import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  ActivationBlocker,
  FillBlocker,
  ONE_DAY,
  ONE_ETH,
  Status,
  minEthOut,
  setUpFills,
  venueEthOut,
} from "./setUpFills.ts";

// Filling time-scheduled (Dca) orders: one fill per period, for the amount of
// one period, at no more than the price cap; skipped periods stay skipped.
// The price feed starts at 2000 USD; the default Dca order buys 100 USDC's
// worth of ETH once a day for three days, at no more than 2000 USD, starting
// in the block that places it.

const MAX_SLIPPAGE = DEFAULT_LIMITS.maxSlippageBps;
/** Values of ShortChangingSwapVenue's Mode, in declaration order. */
const PAY_GIVEN_AMOUNT = 0;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/**
 * Moves the chain to the first second of period `period` of the Dca order
 * `orderId`, then sets the price again, unchanged, so that it is fresh: the
 * next transactions land one and two seconds into that period.
 */
async function toPeriod(f: Fixture, orderId: bigint, period: bigint) {
  const { startAt, periodLength } = await f.scheduleOf(orderId);
  await f.networkHelpers.time.increaseTo(startAt + period * periodLength);
  await f.setPrice(await f.price());
}

/** Cancels an order as `from` (default: the owner); returns the event. */
async function cancel(f: Fixture, orderId: bigint, from = f.owner) {
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

/**
 * Everything a rejected fill must leave as it was: the order, its schedule,
 * the owner's book, allowance and USDC, the recipient's ETH, and the
 * contract's own USDC and ETH.
 */
async function snapshot(f: Fixture, orderId: bigint) {
  const owner = f.owner.account.address;
  return {
    order: await f.trigger.read.getOrder([orderId]),
    schedule: await f.scheduleOf(orderId),
    book: await f.bookOf(f.owner),
    allowance: await f.usdc.read.allowance([owner, f.trigger.address]),
    ownerUsdc: (await f.balancesOf(owner)).usdc,
    recipientEth: (await f.balancesOf(f.recipient.account.address)).eth,
    contract: await f.balancesOf(f.trigger.address),
  };
}

describe("LedgerTrigger Dca fills: one period at a time (S37 to S41)", () => {
  it("S37 the executor fills the first period once it has begun, at a price below the cap: Open -> PartiallyFilled, one period's USDC is spent and its ETH reaches the recipient", async () => {
    const f = await setUpFills();
    const { trigger, usdc, owner, executor, recipient } = f;
    const { orderId, input } = await f.placeDca();
    const perPeriod = input.usdcPerPeriod;
    const budget = perPeriod * input.periodCount;
    const price = usd(1_950n);
    await f.setPrice(price);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;
    const allowance = await usdc.read.allowance([
      owner.account.address,
      trigger.address,
    ]);
    const recipientEth = (await f.balancesOf(recipient.account.address)).eth;

    const { event } = await f.fill(orderId);

    const ethOut = venueEthOut(perPeriod, price);
    assert.deepEqual(event.args, {
      orderId,
      owner: getAddress(owner.account.address),
      filledBy: getAddress(executor.account.address),
      recipient: getAddress(recipient.account.address),
      usdcAmount: perPeriod,
      ethReceived: ethOut,
      price,
      fillNumber: 1n,
      fillsTotal: input.periodCount,
    });
    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.PartiallyFilled);
    assert.equal(order.usdcRemaining, budget - perPeriod);
    assert.equal(order.fillsDone, 1n);
    assert.equal(
      await trigger.read.statusOf([orderId]),
      Status.PartiallyFilled,
    );
    assert.equal((await f.scheduleOf(orderId)).filledThrough, 1n);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: budget - perPeriod,
    });
    assert.equal(
      (await f.balancesOf(owner.account.address)).usdc,
      ownerUsdc - perPeriod,
    );
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      allowance - perPeriod,
    );
    assert.equal(
      (await f.balancesOf(recipient.account.address)).eth,
      recipientEth + ethOut,
    );
  });

  it("S37 the owner can fill a period of their own Dca order", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDca();

    const { event } = await f.fill(orderId, f.owner);

    assert.equal(event.args.filledBy, getAddress(f.owner.account.address));
    assert.equal(event.args.fillNumber, 1n);
    assert.equal(
      (await f.trigger.read.getOrder([orderId])).status,
      Status.PartiallyFilled,
    );
  });

  it("S37 a stranger cannot fill a period of a Dca order: NotOrderOwnerOrExecutor", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDca();
    const before = await snapshot(f, orderId);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.stranger),
      f.trigger,
      "NotOrderOwnerOrExecutor",
      [orderId, getAddress(f.stranger.account.address)],
    );

    assert.deepEqual(await snapshot(f, orderId), before);
  });

  it("S38 a second fill in the same period reverts with PeriodAlreadyFilled naming the period, canFill reports the same, and nothing moves, even once the price has fallen and the allowance has been topped up", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId } = await f.placeDca();
    await f.fill(orderId);
    const before = await snapshot(f, orderId);

    for (const caller of [f.executor, owner]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendFill(orderId, caller),
        trigger,
        "PeriodAlreadyFilled",
        [orderId, 0n],
      );
    }
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.PeriodAlreadyFilled,
    });
    assert.deepEqual(await snapshot(f, orderId), before);

    await f.setPrice(usd(1_900n));
    await f.approve(owner, 1_000n * ONE_USDC, trigger.address);
    const topped = await snapshot(f, orderId);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "PeriodAlreadyFilled",
      [orderId, 0n],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.PeriodAlreadyFilled,
    });
    assert.deepEqual(await snapshot(f, orderId), topped);
    assert.deepEqual(topped.order, before.order);
    assert.deepEqual(topped.schedule, before.schedule);
  });

  it("S39 filling before the first period has begun reverts with NotStarted naming the start time, canFill reports NotStarted, and nothing moves", async () => {
    const f = await setUpFills();
    const startAt = (await f.now()) + ONE_DAY;
    const { orderId } = await f.placeDca({ startAt });
    const before = await snapshot(f, orderId);

    for (const caller of [f.executor, f.owner]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendFill(orderId, caller),
        f.trigger,
        "NotStarted",
        [orderId, startAt],
      );
    }

    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.NotStarted,
    });
    assert.deepEqual(await snapshot(f, orderId), before);
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S40 every period is bought in turn: Open -> PartiallyFilled -> PartiallyFilled -> Filled, the fills are numbered 1 to 3, and only the last one frees the slot", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId, input } = await f.placeDca();
    const perPeriod = input.usdcPerPeriod;
    const statuses: number[] = [
      (await trigger.read.getOrder([orderId])).status,
    ];
    const fillNumbers: bigint[] = [];
    const books: { count: bigint; total: bigint }[] = [];

    for (const period of [0n, 1n, 2n]) {
      if (period > 0n) await toPeriod(f, orderId, period);
      const { event } = await f.fill(orderId);
      assert.equal(event.args.usdcAmount, perPeriod);
      assert.equal(event.args.fillsTotal, 3n);
      fillNumbers.push(event.args.fillNumber);
      statuses.push((await trigger.read.getOrder([orderId])).status);
      books.push(await f.bookOf(owner));
    }

    assert.deepEqual(statuses, [
      Status.Open,
      Status.PartiallyFilled,
      Status.PartiallyFilled,
      Status.Filled,
    ]);
    assert.deepEqual(fillNumbers, [1n, 2n, 3n]);
    assert.deepEqual(books, [
      { count: 1n, total: 2n * perPeriod },
      { count: 1n, total: perPeriod },
      { count: 0n, total: 0n },
    ]);
    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.usdcRemaining, 0n);
    assert.equal(order.fillsDone, order.fillsTotal);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Filled],
    );
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      trigger.write.cancelOrder([orderId], { account: owner.account }),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Filled],
    );
  });

  it("S40 a Dca order of one period is filled at once: Open -> Filled, and its slot is freed", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDca({ periodCount: 1n });

    const { event } = await f.fill(orderId);

    assert.equal(event.args.fillNumber, 1n);
    assert.equal(event.args.fillsTotal, 1n);
    assert.equal(event.args.usdcAmount, input.usdcPerPeriod);
    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Filled);
    assert.equal(order.usdcRemaining, 0n);
    assert.deepEqual(await f.bookOf(f.owner), { count: 0n, total: 0n });
  });

  it("S41 a skipped period stays skipped: after period 0, a fill in period 2 is fill number 2, filledThrough becomes 3, and period 1 can never be bought", async () => {
    const f = await setUpFills();
    const { trigger } = f;
    const { orderId, input } = await f.placeDca();
    await f.fill(orderId);

    await toPeriod(f, orderId, 2n);
    const { event } = await f.fill(orderId);

    assert.equal(event.args.fillNumber, 2n);
    assert.equal(event.args.usdcAmount, input.usdcPerPeriod);
    assert.equal((await f.scheduleOf(orderId)).filledThrough, 3n);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "PeriodAlreadyFilled",
      [orderId, 2n],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.PeriodAlreadyFilled,
    });

    const { expiry } = await trigger.read.getOrder([orderId]);
    await f.networkHelpers.time.increaseTo(expiry + 1n);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.PartiallyFilled);
    assert.equal(order.fillsDone, 2n);
    assert.equal(order.usdcRemaining, input.usdcPerPeriod);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderExpired",
      [orderId, expiry],
    );
  });
});

describe("LedgerTrigger Dca orders: the end of the schedule and cancelling (S42, S43)", () => {
  it("S42 once the schedule has run out with periods unbought, statusOf reports Expired, canFill reports Expired, filling reverts with OrderExpired, and cancelling frees what is left", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const partly = await f.placeDca();
    const never = await f.placeDca();
    await f.fill(partly.orderId);
    const perPeriod = partly.input.usdcPerPeriod;
    const { expiry } = await trigger.read.getOrder([never.orderId]);
    await f.networkHelpers.time.increaseTo(expiry + 1n);
    await f.setPrice(await f.price());

    for (const [orderId, stored, remaining] of [
      [partly.orderId, Status.PartiallyFilled, 2n * perPeriod],
      [never.orderId, Status.Open, 3n * perPeriod],
    ] as const) {
      const order = await trigger.read.getOrder([orderId]);
      assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
      assert.equal(order.status, stored);
      assert.equal(order.usdcRemaining, remaining);
      assert.deepEqual(await f.canFill(orderId), {
        fillable: false,
        reason: FillBlocker.Expired,
      });
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendFill(orderId),
        trigger,
        "OrderExpired",
        [orderId, order.expiry],
      );
    }
    assert.deepEqual(await f.bookOf(owner), {
      count: 2n,
      total: 5n * perPeriod,
    });

    const first = await cancel(f, partly.orderId);
    assert.equal(first.args.afterExpiry, true);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: 3n * perPeriod,
    });
    const second = await cancel(f, never.orderId);
    assert.equal(second.args.afterExpiry, true);
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
    for (const [orderId, remaining] of [
      [partly.orderId, 2n * perPeriod],
      [never.orderId, 3n * perPeriod],
    ] as const) {
      const order = await trigger.read.getOrder([orderId]);
      assert.equal(order.status, Status.Cancelled);
      assert.equal(order.usdcRemaining, remaining);
    }
  });

  it("S43 the owner cancels a Dca order after two of its periods: PartiallyFilled -> Cancelled, what is left leaves the open total, nothing bought is given back, and the executor cannot cancel", async () => {
    const f = await setUpFills();
    const { trigger, owner, executor } = f;
    const { orderId, input } = await f.placeDca();
    await f.fill(orderId);
    await toPeriod(f, orderId, 1n);
    await f.fill(orderId);
    const perPeriod = input.usdcPerPeriod;
    assert.deepEqual(await f.bookOf(owner), { count: 1n, total: perPeriod });

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      trigger.write.cancelOrder([orderId], { account: executor.account }),
      trigger,
      "NotOrderOwner",
      [orderId, getAddress(executor.account.address)],
    );
    const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;

    const event = await cancel(f, orderId);

    assert.equal(event.args.afterExpiry, false);
    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Cancelled);
    assert.equal(order.usdcRemaining, perPeriod);
    assert.equal(order.fillsDone, 2n);
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
    assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Cancelled],
    );
    await toPeriod(f, orderId, 2n);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Cancelled],
    );
  });
});

describe("LedgerTrigger Dca fills: price cap and money (S44, S45)", () => {
  it("S44 a price above the cap reverts with PriceAboveTarget naming the price and the cap, and canFill reports the same; at exactly the cap the period is bought", async () => {
    const f = await setUpFills();
    const { trigger } = f;
    const { orderId, input } = await f.placeDca();
    const cap = input.targetPrice;
    await f.setPrice(cap + 1n);
    const before = await snapshot(f, orderId);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "PriceAboveTarget",
      [cap + 1n, cap],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.PriceAboveTarget,
    });
    assert.deepEqual(await snapshot(f, orderId), before);

    await f.setPrice(cap);
    const { event } = await f.fill(orderId);
    assert.equal(event.args.price, cap);
    assert.equal(event.args.usdcAmount, input.usdcPerPeriod);
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.PartiallyFilled,
    );
  });

  it("S44 the minimum ETH output is worked out from the amount of one period and the cap, not from the whole budget: a venue that keeps 2 % rejects the swap with InsufficientOutput naming that minimum", async () => {
    const f = await setUpFills({ venueFeeBps: 200n });
    const { orderId, input } = await f.placeDca();
    const perPeriod = input.usdcPerPeriod;
    const cap = input.targetPrice;
    assert.equal(await f.price(), cap);
    const expectedMin = minEthOut(perPeriod, cap, cap, MAX_SLIPPAGE);
    assert.notEqual(
      expectedMin,
      minEthOut(perPeriod * input.periodCount, cap, cap, MAX_SLIPPAGE),
    );
    const before = await snapshot(f, orderId);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      f.venue,
      "InsufficientOutput",
      [venueEthOut(perPeriod, cap, 200n), expectedMin],
    );

    assert.deepEqual(await snapshot(f, orderId), before);
  });

  it("S44 a venue that pays one wei less than the minimum for one period is rejected with InsufficientEthOut naming that minimum, and one that pays the minimum fills the period", async () => {
    const f = await setUpFills();
    const cheat = await f.viem.deployContract("ShortChangingSwapVenue", [
      f.usdc.address,
    ]);
    await f.mined(
      await f.deployer.sendTransaction({
        to: cheat.address,
        value: 10n * ONE_ETH,
      }),
    );
    const cheated = await f.deployTrigger({ swapVenue: cheat.address });
    await f.approve(f.owner, 1_000n * ONE_USDC, cheated.address);
    const { orderId, input } = await f.placeDca({}, f.owner, cheated);
    const cap = input.targetPrice;
    const m = minEthOut(input.usdcPerPeriod, cap, cap, MAX_SLIPPAGE);

    await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m - 1n]));
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, cheated),
      cheated,
      "InsufficientEthOut",
      [m - 1n, m],
    );
    await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m]));
    const { event } = await f.fill(orderId, f.executor, cheated);

    assert.equal(event.args.ethReceived, m);
    assert.equal(event.args.usdcAmount, input.usdcPerPeriod);
  });

  it("S45 an allowance for one period buys that period only: the next one reverts with InsufficientAllowance until the allowance is topped up, and a balance below one period reverts with InsufficientBalance; nothing moves on a rejection", async () => {
    const f = await setUpFills();
    const { trigger, usdc, owner, stranger } = f;
    const perPeriod = f.defaultDcaInput().usdcPerPeriod;
    await f.approve(owner, perPeriod, trigger.address);
    const { orderId } = await f.placeDca();

    await f.fill(orderId);
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      0n,
    );

    await toPeriod(f, orderId, 1n);
    const short = await snapshot(f, orderId);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "InsufficientAllowance",
      [0n, perPeriod],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.InsufficientAllowance,
    });
    assert.deepEqual(await snapshot(f, orderId), short);

    await f.approve(owner, perPeriod, trigger.address);
    const { event } = await f.fill(orderId);
    assert.equal(event.args.fillNumber, 2n);

    await toPeriod(f, orderId, 2n);
    await f.approve(owner, perPeriod, trigger.address);
    const balance = (await f.balancesOf(owner.account.address)).usdc;
    await f.mined(
      await usdc.write.transfer(
        [stranger.account.address, balance - (perPeriod - 1n)],
        { account: owner.account },
      ),
    );
    const poor = await snapshot(f, orderId);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "InsufficientBalance",
      [perPeriod - 1n, perPeriod],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.InsufficientBalance,
    });
    assert.deepEqual(await snapshot(f, orderId), poor);
  });
});

describe("LedgerTrigger dormant Dca orders (S47)", () => {
  it("S47 a Dca order with an activation price is placed Dormant and cannot be filled; once activated it buys its current period: Dormant -> Open -> PartiallyFilled, after which it cannot be activated again", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId, input } = await f.placeDca({
      activationPrice: usd(2_200n),
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Dormant);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: input.usdcPerPeriod * input.periodCount,
    });
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

    await f.setPrice(usd(2_200n));
    const { event } = await f.activate(orderId);
    assert.equal(event.args.price, usd(2_200n));
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);

    await f.setPrice(usd(2_000n));
    await f.fill(orderId);
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.PartiallyFilled,
    );

    await f.setPrice(usd(2_200n));
    for (const caller of [f.executor, owner]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId, caller),
        trigger,
        "OrderNotDormant",
        [orderId, Status.PartiallyFilled],
      );
    }
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: false,
      reason: ActivationBlocker.NotDormant,
    });
  });

  it("S47 a dormant Dca order can be activated before its first period begins, and filling it then reverts with NotStarted", async () => {
    const f = await setUpFills();
    const startAt = (await f.now()) + ONE_DAY;
    const { orderId } = await f.placeDca({
      startAt,
      activationPrice: usd(2_200n),
    });
    await f.setPrice(usd(2_200n));

    await f.activate(orderId);
    await f.setPrice(usd(2_000n));

    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      f.trigger,
      "NotStarted",
      [orderId, startAt],
    );
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.NotStarted,
    });
  });

  it("S47 a dormant Dca order whose activation price is below its price cap is activated and filled at the same price", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDca({ activationPrice: usd(1_800n) });
    assert.equal(await f.price(), usd(2_000n));

    await f.activate(orderId, f.owner);
    const { event } = await f.fill(orderId);

    assert.equal(event.args.price, usd(2_000n));
    assert.equal(
      (await f.trigger.read.getOrder([orderId])).status,
      Status.PartiallyFilled,
    );
  });
});

describe("LedgerTrigger Dca fills keep no money and add up (S48)", () => {
  it("S48 over three fills the contract's USDC and ETH stay as they were, usdcRemaining plus what the fills spent is the budget, fillsDone never passes fillsTotal, and the owner pays exactly what the fills spent", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId } = await f.placeDca();
    const budget = (await trigger.read.getOrder([orderId])).usdcAmount;
    const ownerStart = (await f.balancesOf(owner.account.address)).usdc;
    let spent = 0n;

    for (const period of [0n, 1n, 2n]) {
      if (period > 0n) await toPeriod(f, orderId, period);
      const contractBefore = await f.balancesOf(trigger.address);
      const { event } = await f.fill(orderId);
      assert.deepEqual(await f.balancesOf(trigger.address), contractBefore);
      spent += event.args.usdcAmount;
      const order = await trigger.read.getOrder([orderId]);
      assert.equal(order.usdcRemaining + spent, budget);
      assert.ok(order.fillsDone <= order.fillsTotal);
      assert.equal(
        (await f.balancesOf(owner.account.address)).usdc,
        ownerStart - spent,
      );
    }
    assert.equal(spent, budget);
  });
});
