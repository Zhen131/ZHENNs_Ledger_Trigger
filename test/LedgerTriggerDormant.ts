import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs, zeroAddress, type Hash } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  ActivationBlocker,
  FillBlocker,
  Kind,
  Status,
  setUpFills,
  venueEthOut,
  type DormantInput,
  type OrderInput,
  type Wallet,
} from "./setUpFills.ts";

// Dormant orders: placed with an activation price above the target price,
// they cannot be filled until the price has risen to the activation price and
// the owner or the executor has activated them. The price feed starts at
// 2000 USD; the default dormant order is 100 USDC at a target of 2000 USD
// with an activation price of 2200 USD.

const MAX_PRICE_AGE = DEFAULT_LIMITS.maxPriceAge;
const ONE_HOUR = 3_600n;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/** Sends createOrder with `input` as `from` (default: the owner). */
function sendCreate(
  f: Fixture,
  input: OrderInput,
  from: Wallet = f.owner,
): Promise<Hash> {
  return f.trigger.write.createOrder(
    [
      input.usdcAmount,
      input.targetPrice,
      input.recipient,
      input.executor,
      input.expiry,
    ],
    { account: from.account },
  );
}

/** Sends createDormantOrder with `input` as `from` (default: the owner). */
function sendCreateDormant(
  f: Fixture,
  input: DormantInput,
  from: Wallet = f.owner,
): Promise<Hash> {
  return f.trigger.write.createDormantOrder(
    [
      input.usdcAmount,
      input.targetPrice,
      input.activationPrice,
      input.recipient,
      input.executor,
      input.expiry,
    ],
    { account: from.account },
  );
}

/** Cancels an order as `from` (default: the owner); returns the event. */
async function cancel(f: Fixture, orderId: bigint, from: Wallet = f.owner) {
  const receipt = await f.mined(
    await f.trigger.write.cancelOrder([orderId], { account: from.account }),
  );
  const events = parseEventLogs({
    abi: f.trigger.abi,
    logs: receipt.logs,
    eventName: "OrderCancelled",
  });
  assert.equal(events.length, 1);
  const event = events[0];
  if (event === undefined) throw new Error("no OrderCancelled event");
  return event;
}

/** Asserts that the owner has no unfinished order: nothing was stored. */
async function assertNothingPlaced(f: Fixture) {
  assert.deepEqual(await f.bookOf(f.owner), { count: 0n, total: 0n });
  await f.viem.assertions.revertWithCustomErrorWithArgs(
    f.trigger.read.getOrder([1n]),
    f.trigger,
    "OrderNotFound",
    [1n],
  );
}

describe("LedgerTrigger createDormantOrder: a dormant order is placed", () => {
  it("places a Dormant Limit order with every field as given; OrderCreated records the kind and the activation price", async () => {
    const f = await setUpFills();
    const { publicClient, trigger, owner, stranger, otherOwner } = f;
    const input: DormantInput = {
      usdcAmount: 123n * ONE_USDC + 456_789n,
      targetPrice: usd(1_850n) + 12_345_678n,
      activationPrice: usd(2_150n) + 1n,
      recipient: stranger.account.address,
      executor: otherOwner.account.address,
      expiry: 4_000_000_000n,
    };

    const { orderId, receipt, event } = await f.placeDormant(input);

    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.deepEqual(await trigger.read.getOrder([orderId]), {
      owner: getAddress(owner.account.address),
      executor: getAddress(input.executor),
      recipient: getAddress(input.recipient),
      kind: Kind.Limit,
      status: Status.Dormant,
      usdcAmount: input.usdcAmount,
      usdcRemaining: input.usdcAmount,
      targetPrice: input.targetPrice,
      activationPrice: input.activationPrice,
      fillsTotal: 1n,
      fillsDone: 0n,
      createdAt: block.timestamp,
      expiry: input.expiry,
    });
    assert.deepEqual(event.args, {
      orderId: 1n,
      owner: getAddress(owner.account.address),
      executor: getAddress(input.executor),
      recipient: getAddress(input.recipient),
      usdcAmount: input.usdcAmount,
      targetPrice: input.targetPrice,
      expiry: input.expiry,
      kind: Kind.Limit,
      activationPrice: input.activationPrice,
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Dormant);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.Dormant,
    });
  });

  it("takes one of the owner's slots and adds its amount to the open total, and moves no USDC and no ETH", async () => {
    const f = await setUpFills();
    const { trigger, usdc, owner, venue } = f;
    await f.place({ usdcAmount: 20n * ONE_USDC });
    const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;
    const allowance = await usdc.read.allowance([
      owner.account.address,
      trigger.address,
    ]);
    const contractBefore = await f.balancesOf(trigger.address);
    const venueBefore = await f.balancesOf(venue.address);

    const { receipt } = await f.placeDormant({ usdcAmount: 70n * ONE_USDC });

    assert.deepEqual(await f.bookOf(owner), {
      count: 2n,
      total: 90n * ONE_USDC,
    });
    assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      allowance,
    );
    assert.deepEqual(await f.balancesOf(trigger.address), contractBefore);
    assert.deepEqual(await f.balancesOf(venue.address), venueBefore);
    assert.equal(receipt.logs.length, 1);
    assert.equal(
      getAddress(receipt.logs[0]?.address ?? zeroAddress),
      getAddress(trigger.address),
    );
  });

  it("numbers dormant orders together with the orders createOrder places", async () => {
    const f = await setUpFills();

    const ids = [
      (await f.place()).orderId,
      (await f.placeDormant()).orderId,
      (await f.placeDormant({}, f.otherOwner)).orderId,
      (await f.place({}, f.otherOwner)).orderId,
    ];

    assert.deepEqual(ids, [1n, 2n, 3n, 4n]);
  });
});

describe("LedgerTrigger createDormantOrder: rejected inputs (S35)", () => {
  for (const [label, changes, error, args] of [
    ["a zero amount", { usdcAmount: 0n }, "ZeroAmount", []],
    [
      "an amount above the single-order limit",
      { usdcAmount: DEFAULT_LIMITS.maxOrderAmount + 1n },
      "AmountAboveMax",
      [DEFAULT_LIMITS.maxOrderAmount + 1n, DEFAULT_LIMITS.maxOrderAmount],
    ],
    ["a zero target price", { targetPrice: 0n }, "ZeroTargetPrice", []],
    ["a zero recipient", { recipient: zeroAddress }, "ZeroRecipient", []],
    ["a zero executor", { executor: zeroAddress }, "ZeroExecutor", []],
  ] as const) {
    it(`rejects ${label} with ${error}, as createOrder does`, async () => {
      const f = await setUpFills();
      const input = { ...(await f.defaultDormantInput()), ...changes };

      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendCreate(f, input),
        f.trigger,
        error,
        [...args],
      );
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendCreateDormant(f, input),
        f.trigger,
        error,
        [...args],
      );

      await assertNothingPlaced(f);
    });
  }

  for (const [label, offset] of [
    ["in the past", -ONE_HOUR],
    ["equal to the time of the block that would place it", 0n],
  ] as const) {
    it(`rejects an expiry ${label} with ExpiryNotInFuture, as createOrder does`, async () => {
      const f = await setUpFills();
      const input = await f.defaultDormantInput();
      for (const send of [sendCreate, sendCreateDormant]) {
        const blockTime = (await f.now()) + 100n;
        await f.networkHelpers.time.setNextBlockTimestamp(blockTime);
        const expiry = blockTime + offset;

        await f.viem.assertions.revertWithCustomErrorWithArgs(
          send(f, { ...input, expiry }),
          f.trigger,
          "ExpiryNotInFuture",
          [expiry, blockTime],
        );
      }

      await assertNothingPlaced(f);
    });
  }

  it("counts dormant orders against the open-order limit: with five unfinished orders, dormant ones among them, both kinds of order are rejected with TooManyOpenOrders, and cancelling a dormant one frees a slot", async () => {
    const f = await setUpFills();
    const dormantIds: bigint[] = [];
    for (let i = 0; i < 3; i += 1) {
      dormantIds.push((await f.placeDormant()).orderId);
    }
    await f.place();
    await f.place();
    assert.deepEqual(await f.bookOf(f.owner), {
      count: 5n,
      total: 500n * ONE_USDC,
    });
    const input = await f.defaultDormantInput();

    for (const send of [sendCreate, sendCreateDormant]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        send(f, input),
        f.trigger,
        "TooManyOpenOrders",
        [getAddress(f.owner.account.address), 5n],
      );
    }

    await cancel(f, dormantIds[0] ?? 0n);
    const { orderId } = await f.placeDormant();
    assert.equal(orderId, 6n);
    assert.equal(
      await f.trigger.read.openOrderCount([f.owner.account.address]),
      5n,
    );
  });

  it("S35 rejects an activation price equal to the target price with ActivationNotAboveTarget", async () => {
    const f = await setUpFills();
    const input = await f.defaultDormantInput();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendCreateDormant(f, { ...input, activationPrice: input.targetPrice }),
      f.trigger,
      "ActivationNotAboveTarget",
      [input.targetPrice, input.targetPrice],
    );

    await assertNothingPlaced(f);
  });

  it("S35 rejects an activation price below the target price with ActivationNotAboveTarget, a zero one included", async () => {
    const f = await setUpFills();
    const input = await f.defaultDormantInput();

    for (const activationPrice of [input.targetPrice - 1n, usd(1_500n), 0n]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendCreateDormant(f, { ...input, activationPrice }),
        f.trigger,
        "ActivationNotAboveTarget",
        [activationPrice, input.targetPrice],
      );
    }

    await assertNothingPlaced(f);
  });

  it("S35 accepts an activation price one unit above the target price", async () => {
    const f = await setUpFills();
    const input = await f.defaultDormantInput();

    const { orderId } = await f.placeDormant({
      activationPrice: input.targetPrice + 1n,
    });

    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Dormant);
    assert.equal(order.activationPrice, input.targetPrice + 1n);
  });

  it("checks the activation price after the amount and the target price and before the recipient, the executor, the expiry and the slots", async () => {
    const f = await setUpFills();
    const input = await f.defaultDormantInput();
    const notAbove = { activationPrice: input.targetPrice };

    for (const changes of [
      { recipient: zeroAddress },
      { executor: zeroAddress },
      { expiry: 1n },
    ]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendCreateDormant(f, { ...input, ...notAbove, ...changes }),
        f.trigger,
        "ActivationNotAboveTarget",
        [input.targetPrice, input.targetPrice],
      );
    }
    await f.viem.assertions.revertWithCustomError(
      sendCreateDormant(f, { ...input, usdcAmount: 0n, ...notAbove }),
      f.trigger,
      "ZeroAmount",
    );
    await f.viem.assertions.revertWithCustomError(
      sendCreateDormant(f, { ...input, targetPrice: 0n, activationPrice: 0n }),
      f.trigger,
      "ZeroTargetPrice",
    );

    await assertNothingPlaced(f);
  });
});

describe("LedgerTrigger activateOrder: a dormant order wakes up (S27, S28)", () => {
  it("S27 the executor activates a dormant order once the price has risen to its activation price, then fills it at its target price: Dormant -> Open -> Filled", async () => {
    const f = await setUpFills();
    const { trigger, owner, executor, recipient } = f;
    const { orderId, input } = await f.placeDormant();
    assert.equal(await trigger.read.statusOf([orderId]), Status.Dormant);
    const bookWhileDormant = await f.bookOf(owner);
    assert.deepEqual(bookWhileDormant, {
      count: 1n,
      total: input.usdcAmount,
    });
    await f.setPrice(input.activationPrice);
    const before = await trigger.read.getOrder([orderId]);

    const { event } = await f.activate(orderId);

    assert.deepEqual(event.args, {
      orderId,
      activatedBy: getAddress(executor.account.address),
      price: input.activationPrice,
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    const after = await trigger.read.getOrder([orderId]);
    assert.equal(after.status, Status.Open);
    assert.deepEqual({ ...after, status: before.status }, before);
    assert.equal(after.activationPrice, input.activationPrice);
    assert.equal(after.kind, Kind.Limit);
    assert.deepEqual(await f.bookOf(owner), bookWhileDormant);

    await f.setPrice(input.targetPrice);
    const recipientBefore = await f.balancesOf(recipient.account.address);
    const { event: filled } = await f.fill(orderId);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
    assert.equal(filled.args.filledBy, getAddress(executor.account.address));
    const recipientAfter = await f.balancesOf(recipient.account.address);
    assert.equal(
      recipientAfter.eth - recipientBefore.eth,
      venueEthOut(input.usdcAmount, input.targetPrice),
    );
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
  });

  it("S28 the owner activates their own dormant order: Dormant -> Open", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice + usd(50n));
    const before = await trigger.read.getOrder([orderId]);

    const { event } = await f.activate(orderId, owner);

    assert.deepEqual(event.args, {
      orderId,
      activatedBy: getAddress(owner.account.address),
      price: input.activationPrice + usd(50n),
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    const after = await trigger.read.getOrder([orderId]);
    assert.deepEqual({ ...after, status: before.status }, before);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: input.usdcAmount,
    });
  });
});

describe("LedgerTrigger dormant orders: what is refused (S29 to S34)", () => {
  it("S29 a dormant order cannot be filled even at its target price: fillOrder reverts with OrderNotOpen naming Dormant, canFill reports Dormant, and no money moves", async () => {
    const f = await setUpFills();
    const { trigger, owner, recipient } = f;
    const { orderId, input } = await f.placeDormant();
    assert.equal(await f.price(), input.targetPrice);
    const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;
    const recipientBefore = await f.balancesOf(recipient.account.address);
    const contractBefore = await f.balancesOf(trigger.address);

    for (const caller of [f.executor, owner]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendFill(orderId, caller),
        trigger,
        "OrderNotOpen",
        [orderId, Status.Dormant],
      );
    }

    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.Dormant,
    });
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Dormant,
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Dormant);
    assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);
    assert.deepEqual(
      await f.balancesOf(recipient.account.address),
      recipientBefore,
    );
    assert.deepEqual(await f.balancesOf(trigger.address), contractBefore);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: input.usdcAmount,
    });
  });

  it("S30 activating below the activation price reverts with PriceBelowActivation and canActivate reports the same reason; at exactly the activation price the activation goes through", async () => {
    const f = await setUpFills();
    const { trigger } = f;
    const { orderId, input } = await f.placeDormant();

    for (const price of [usd(2_000n), input.activationPrice - 1n]) {
      await f.setPrice(price);
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId),
        trigger,
        "PriceBelowActivation",
        [price, input.activationPrice],
      );
      assert.deepEqual(await f.canActivate(orderId), {
        activatable: false,
        reason: ActivationBlocker.PriceBelowActivation,
      });
      assert.equal(await trigger.read.statusOf([orderId]), Status.Dormant);
    }

    await f.setPrice(input.activationPrice);
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: true,
      reason: ActivationBlocker.None,
    });
    const { event } = await f.activate(orderId);
    assert.equal(event.args.price, input.activationPrice);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S31 an open, a filled and a cancelled order cannot be activated: each reverts with OrderNotDormant naming its stored status", async () => {
    const f = await setUpFills();
    const { trigger } = f;
    const open = (await f.place()).orderId;
    const filled = (await f.place()).orderId;
    await f.fill(filled);
    const cancelled = (await f.place()).orderId;
    await cancel(f, cancelled);
    const cancelledDormant = (await f.placeDormant()).orderId;
    await cancel(f, cancelledDormant);
    await f.setPrice(usd(2_200n));

    for (const [orderId, status] of [
      [open, Status.Open],
      [filled, Status.Filled],
      [cancelled, Status.Cancelled],
      [cancelledDormant, Status.Cancelled],
    ] as const) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId, f.owner),
        trigger,
        "OrderNotDormant",
        [orderId, status],
      );
      assert.deepEqual(await f.canActivate(orderId), {
        activatable: false,
        reason: ActivationBlocker.NotDormant,
      });
      assert.equal((await trigger.read.getOrder([orderId])).status, status);
    }
  });

  it("S31 a second activation of the same order reverts with OrderNotDormant naming Open", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);
    await f.activate(orderId);

    for (const caller of [f.executor, f.owner]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId, caller),
        f.trigger,
        "OrderNotDormant",
        [orderId, Status.Open],
      );
    }
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S32 a stranger cannot activate a dormant order: activateOrder reverts with NotOrderOwnerOrExecutor and the order stays dormant", async () => {
    const f = await setUpFills();
    const { trigger, stranger, recipient } = f;
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);

    for (const caller of [stranger, recipient]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId, caller),
        trigger,
        "NotOrderOwnerOrExecutor",
        [orderId, getAddress(caller.account.address)],
      );
    }

    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Dormant,
    );
    assert.deepEqual(await f.canActivate(orderId, stranger), {
      activatable: true,
      reason: ActivationBlocker.None,
    });
  });

  it("S33 a dormant order can still be activated in the very second of its expiry", async () => {
    const f = await setUpFills();
    const expiry = (await f.now()) + ONE_HOUR;
    const { orderId, input } = await f.placeDormant({ expiry });
    await f.networkHelpers.time.increaseTo(expiry - 10n);
    await f.setPrice(input.activationPrice);

    await f.networkHelpers.time.setNextBlockTimestamp(expiry);
    const { receipt } = await f.activate(orderId);

    const block = await f.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.equal(block.timestamp, expiry);
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S33 once a dormant order has expired, activating reverts with OrderExpired and filling with OrderNotOpen naming Dormant; statusOf says Expired while getOrder keeps Dormant; the owner can still cancel it, which frees its slot and its amount", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const expiry = (await f.now()) + ONE_HOUR;
    const { orderId, input } = await f.placeDormant({ expiry });
    await f.networkHelpers.time.increaseTo(expiry + 1n);
    await f.setPrice(input.activationPrice);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      trigger,
      "OrderExpired",
      [orderId, expiry],
    );
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: false,
      reason: ActivationBlocker.Expired,
    });
    await f.setPrice(input.targetPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Dormant],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.Dormant,
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Dormant,
    );
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: input.usdcAmount,
    });

    const event = await cancel(f, orderId);

    assert.equal(event.args.afterExpiry, true);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
  });

  it("S34 the executor cannot cancel a dormant order: cancelOrder reverts with NotOrderOwner and the order stays dormant", async () => {
    const f = await setUpFills();
    const { trigger, executor } = f;
    const { orderId } = await f.placeDormant();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      trigger.write.cancelOrder([orderId], { account: executor.account }),
      trigger,
      "NotOrderOwner",
      [orderId, getAddress(executor.account.address)],
    );

    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Dormant,
    );
  });

  it("S34 the owner cancels a dormant order: Dormant -> Cancelled, with what it had left to spend kept, and its slot and amount leave the owner's open count and total", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    await f.place({ usdcAmount: 25n * ONE_USDC });
    const { orderId, input } = await f.placeDormant({
      usdcAmount: 60n * ONE_USDC,
    });
    assert.deepEqual(await f.bookOf(owner), {
      count: 2n,
      total: 85n * ONE_USDC,
    });

    const event = await cancel(f, orderId);

    assert.deepEqual(event.args, {
      orderId,
      owner: getAddress(owner.account.address),
      afterExpiry: false,
    });
    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Cancelled);
    assert.equal(order.usdcRemaining, input.usdcAmount);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: 25n * ONE_USDC,
    });
  });
});

describe("LedgerTrigger activateOrder: the price must be usable (S36)", () => {
  for (const [label, answer] of [
    ["zero", 0n],
    ["negative", -1n],
  ] as const) {
    it(`S36 activating while the feed reports a ${label} price reverts with InvalidPrice and canActivate reports InvalidPrice`, async () => {
      const f = await setUpFills();
      const { orderId } = await f.placeDormant();
      await f.setPrice(answer);

      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId),
        f.trigger,
        "InvalidPrice",
        [answer],
      );
      assert.deepEqual(await f.canActivate(orderId), {
        activatable: false,
        reason: ActivationBlocker.InvalidPrice,
      });
      assert.equal(await f.trigger.read.statusOf([orderId]), Status.Dormant);
    });
  }

  it("S36 activating while the feed's update time is in the future reverts with InvalidPrice, even with the price above the activation price", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDormant();
    await f.setPrice(usd(2_300n));
    await f.setUpdatedAt((await f.now()) + ONE_HOUR);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "InvalidPrice",
      [usd(2_300n)],
    );
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: false,
      reason: ActivationBlocker.InvalidPrice,
    });
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Dormant);
  });

  it("S36 activating with a price older than maxPriceAge reverts with StalePrice, even with the price above the activation price", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDormant();
    await f.setPrice(usd(2_300n));
    const updatedAt = await f.now();

    await f.networkHelpers.time.setNextBlockTimestamp(
      updatedAt + MAX_PRICE_AGE + 1n,
    );
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: false,
      reason: ActivationBlocker.StalePrice,
    });
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Dormant);
  });

  it("S36 a price exactly maxPriceAge old is fresh enough to activate", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDormant();
    await f.setPrice(usd(2_300n));
    const updatedAt = await f.now();

    await f.networkHelpers.time.setNextBlockTimestamp(
      updatedAt + MAX_PRICE_AGE,
    );
    const { event } = await f.activate(orderId);

    assert.equal(event.args.price, usd(2_300n));
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
  });
});

describe("LedgerTrigger activateOrder: an activation moves no money", () => {
  it("activating moves no USDC and no ETH, needs no ETH at the swap venue, and logs nothing but OrderActivated", async () => {
    const f = await setUpFills({ venueEth: 0n });
    const { trigger, usdc, owner, venue } = f;
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);
    const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;
    const allowance = await usdc.read.allowance([
      owner.account.address,
      trigger.address,
    ]);
    const contractBefore = await f.balancesOf(trigger.address);
    const venueBefore = await f.balancesOf(venue.address);
    assert.equal(venueBefore.eth, 0n);

    const { receipt } = await f.activate(orderId);

    assert.equal(receipt.logs.length, 1);
    assert.equal(
      getAddress(receipt.logs[0]?.address ?? zeroAddress),
      getAddress(trigger.address),
    );
    assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      allowance,
    );
    assert.deepEqual(await f.balancesOf(trigger.address), contractBefore);
    assert.deepEqual(await f.balancesOf(venue.address), venueBefore);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });
});
