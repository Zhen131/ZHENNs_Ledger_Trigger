import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  ActivationBlocker,
  FillBlocker,
  ONE_ETH,
  Status,
  minEthOut,
  setUpFills,
  venueEthOut,
  type TierInput,
} from "./setUpFills.ts";

// Filling Ladder orders: one tier per fill, in order, for the amount of the
// next tier, at no more than that tier's price; never two tiers at once,
// never a tier skipped. The price feed starts at 2000 USD; the default Ladder
// order has three tiers, 100 USDC at 2000 USD, 150 USDC at 1900 USD and
// 200 USDC at 1800 USD, each amount different so that a skipped or joined
// tier would show in the amounts.

const MAX_SLIPPAGE = DEFAULT_LIMITS.maxSlippageBps;
/** Values of ShortChangingSwapVenue's Mode, in declaration order. */
const PAY_GIVEN_AMOUNT = 0;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/** Tier `index` of `tiers`; fails the test if there is none. */
function tierAt(tiers: readonly TierInput[], index: number): TierInput {
  const tier = tiers[index];
  if (tier === undefined) throw new Error(`no tier ${index}`);
  return tier;
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
 * Everything a rejected fill must leave as it was: the order, its tiers, the
 * owner's book, allowance and USDC, the recipient's ETH, and the contract's
 * own USDC and ETH.
 */
async function snapshot(f: Fixture, orderId: bigint) {
  const owner = f.owner.account.address;
  return {
    order: await f.trigger.read.getOrder([orderId]),
    tiers: await f.tiersOf(orderId),
    book: await f.bookOf(f.owner),
    allowance: await f.usdc.read.allowance([owner, f.trigger.address]),
    ownerUsdc: (await f.balancesOf(owner)).usdc,
    recipientEth: (await f.balancesOf(f.recipient.account.address)).eth,
    contract: await f.balancesOf(f.trigger.address),
  };
}

describe("LedgerTrigger Ladder fills: one tier at a time, in order (S50, S51)", () => {
  it("S50 tiers fill one at a time as the price falls: at 1950 tier 0 fills (Open -> PartiallyFilled) and a second fill reverts with PriceAboveTarget naming 1950 and the price of tier 1; at 1850 tier 1 fills and the next reverts naming the price of tier 2; at 1800 tier 2 fills (PartiallyFilled -> Filled) and one more fill reverts with OrderNotOpen", async () => {
    const f = await setUpFills();
    const { trigger, usdc, owner, executor, recipient } = f;
    const { orderId, input } = await f.placeLadder();
    const tiers = input.tiers;
    const budget = 450n * ONE_USDC;
    const ownerStart = (await f.balancesOf(owner.account.address)).usdc;
    const allowanceStart = await usdc.read.allowance([
      owner.account.address,
      trigger.address,
    ]);
    let spent = 0n;

    for (const [index, price, statusAfter, rejectedAt] of [
      [0, usd(1_950n), Status.PartiallyFilled, usd(1_950n)],
      [1, usd(1_850n), Status.PartiallyFilled, usd(1_850n)],
      [2, usd(1_800n), Status.Filled, undefined],
    ] as const) {
      const tier = tierAt(tiers, index);
      await f.setPrice(price);
      const recipientEth = (await f.balancesOf(recipient.account.address)).eth;
      const statusBefore = (await trigger.read.getOrder([orderId])).status;

      const { event } = await f.fill(orderId);

      spent += tier.usdcAmount;
      const ethOut = venueEthOut(tier.usdcAmount, price);
      assert.deepEqual(event.args, {
        orderId,
        owner: getAddress(owner.account.address),
        filledBy: getAddress(executor.account.address),
        recipient: getAddress(recipient.account.address),
        usdcAmount: tier.usdcAmount,
        ethReceived: ethOut,
        price,
        fillNumber: BigInt(index + 1),
        fillsTotal: 3n,
      });
      assert.equal(
        statusBefore,
        index === 0 ? Status.Open : Status.PartiallyFilled,
      );
      const order = await trigger.read.getOrder([orderId]);
      assert.equal(order.status, statusAfter);
      assert.equal(order.fillsDone, BigInt(index + 1));
      assert.equal(order.usdcRemaining, budget - spent);
      assert.deepEqual(await f.bookOf(owner), {
        count: statusAfter === Status.Filled ? 0n : 1n,
        total: budget - spent,
      });
      assert.equal(
        (await f.balancesOf(owner.account.address)).usdc,
        ownerStart - spent,
      );
      assert.equal(
        await usdc.read.allowance([owner.account.address, trigger.address]),
        allowanceStart - spent,
      );
      assert.equal(
        (await f.balancesOf(recipient.account.address)).eth,
        recipientEth + ethOut,
      );
      assert.deepEqual(await f.tiersOf(orderId), tiers);

      const before = await snapshot(f, orderId);
      if (rejectedAt === undefined) {
        await f.viem.assertions.revertWithCustomErrorWithArgs(
          f.sendFill(orderId),
          trigger,
          "OrderNotOpen",
          [orderId, Status.Filled],
        );
        assert.deepEqual(await f.canFill(orderId), {
          fillable: false,
          reason: FillBlocker.NotOpen,
        });
      } else {
        const next = tierAt(tiers, index + 1);
        await f.viem.assertions.revertWithCustomErrorWithArgs(
          f.sendFill(orderId),
          trigger,
          "PriceAboveTarget",
          [rejectedAt, next.price],
        );
        assert.deepEqual(await f.canFill(orderId), {
          fillable: false,
          reason: FillBlocker.PriceAboveTarget,
        });
      }
      assert.deepEqual(await snapshot(f, orderId), before);
    }
    assert.equal(spent, budget);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
  });

  it("S51 a price that falls through every tier at once still fills one tier per transaction: three fills at 1700 spend tier 0, then tier 1, then tier 2, each with exactly one OrderFilled, and canFill stays fillable until the last", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId, input } = await f.placeLadder();
    const tiers = input.tiers;
    await f.setPrice(usd(1_700n));
    const amounts: bigint[] = [];
    const fillNumbers: bigint[] = [];
    const statuses: number[] = [];

    for (const index of [0, 1, 2]) {
      const ownerBefore = (await f.balancesOf(owner.account.address)).usdc;

      const { event, receipt } = await f.fill(orderId);

      const filled = parseEventLogs({
        abi: trigger.abi,
        logs: receipt.logs,
        eventName: "OrderFilled",
      });
      assert.equal(filled.length, 1);
      assert.equal(event.args.price, usd(1_700n));
      amounts.push(event.args.usdcAmount);
      fillNumbers.push(event.args.fillNumber);
      assert.equal(
        (await f.balancesOf(owner.account.address)).usdc,
        ownerBefore - tierAt(tiers, index).usdcAmount,
      );
      statuses.push((await trigger.read.getOrder([orderId])).status);
      if (index < 2) {
        assert.deepEqual(await f.canFill(orderId), {
          fillable: true,
          reason: FillBlocker.None,
        });
      }
    }

    assert.deepEqual(
      amounts,
      tiers.map((tier) => tier.usdcAmount),
    );
    assert.deepEqual(fillNumbers, [1n, 2n, 3n]);
    assert.deepEqual(statuses, [
      Status.PartiallyFilled,
      Status.PartiallyFilled,
      Status.Filled,
    ]);
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
  });

  it("a Ladder order of one tier is filled at once: Open -> Filled, and its slot is freed", async () => {
    const f = await setUpFills();
    const tier = { price: usd(2_000n), usdcAmount: 70n * ONE_USDC };
    const { orderId } = await f.placeLadder({ tiers: [tier] });

    const { event } = await f.fill(orderId);

    assert.equal(event.args.fillNumber, 1n);
    assert.equal(event.args.fillsTotal, 1n);
    assert.equal(event.args.usdcAmount, tier.usdcAmount);
    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Filled);
    assert.equal(order.usdcRemaining, 0n);
    assert.deepEqual(await f.bookOf(f.owner), { count: 0n, total: 0n });
  });
});

describe("LedgerTrigger Ladder fills: the minimum ETH output of each tier", () => {
  it("the minimum ETH output of a fill is worked out from the amount and the price of the next tier: a venue that pays one wei less than it for tier 1 is rejected with InsufficientEthOut naming that minimum, and one that pays the minimum fills tier 1", async () => {
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
    const { orderId, input } = await f.placeLadder({}, f.owner, cheated);
    const [tier0, tier1] = [tierAt(input.tiers, 0), tierAt(input.tiers, 1)];
    const price0 = await f.price();
    await f.mined(
      await cheat.write.setMode([
        PAY_GIVEN_AMOUNT,
        minEthOut(tier0.usdcAmount, tier0.price, price0, MAX_SLIPPAGE),
      ]),
    );
    await f.fill(orderId, f.executor, cheated);

    const p1 = tier1.price;
    await f.setPrice(p1);
    const m = minEthOut(tier1.usdcAmount, p1, p1, MAX_SLIPPAGE);
    assert.notEqual(
      m,
      minEthOut(tier1.usdcAmount, tier0.price, p1, MAX_SLIPPAGE),
    );
    assert.notEqual(m, minEthOut(450n * ONE_USDC, p1, p1, MAX_SLIPPAGE));
    await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m - 1n]));
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, cheated),
      cheated,
      "InsufficientEthOut",
      [m - 1n, m],
    );
    assert.equal((await cheated.read.getOrder([orderId])).fillsDone, 1n);

    await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m]));
    const { event } = await f.fill(orderId, f.executor, cheated);

    assert.equal(event.args.ethReceived, m);
    assert.equal(event.args.usdcAmount, tier1.usdcAmount);
    assert.equal(event.args.fillNumber, 2n);
  });
});

describe("LedgerTrigger Ladder orders: cancelling and activation (S53, S54)", () => {
  it("S53 the owner cancels a Ladder order after its first tier: PartiallyFilled -> Cancelled, the two tiers left leave the open total, usdcRemaining is kept, nothing bought is given back, the executor cannot cancel, and a fill after it reverts with OrderNotOpen", async () => {
    const f = await setUpFills();
    const { trigger, owner, executor } = f;
    const { orderId, input } = await f.placeLadder();
    await f.fill(orderId);
    const left =
      tierAt(input.tiers, 1).usdcAmount + tierAt(input.tiers, 2).usdcAmount;
    assert.deepEqual(await f.bookOf(owner), { count: 1n, total: left });
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.PartiallyFilled,
    );

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
    assert.equal(order.usdcRemaining, left);
    assert.equal(order.fillsDone, 1n);
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
    assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);

    await f.setPrice(usd(1_700n));
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Cancelled],
    );
  });

  it("S54 rejects an activation price equal to the price of tier 0, between tiers 0 and 1, or below tier 1 with ActivationNotAboveTarget naming it and the price of tier 0, and stores nothing", async () => {
    const f = await setUpFills();
    const top = usd(2_000n);

    for (const activationPrice of [top, usd(1_950n), usd(1_850n)]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendPlaceLadder({
          ...(await f.defaultLadderInput()),
          activationPrice,
        }),
        f.trigger,
        "ActivationNotAboveTarget",
        [activationPrice, top],
      );
    }

    assert.deepEqual(await f.bookOf(f.owner), { count: 0n, total: 0n });
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.trigger.read.getOrder([1n]),
      f.trigger,
      "OrderNotFound",
      [1n],
    );
  });

  it("S54 a Ladder order with an activation price above tier 0 is placed Dormant, takes a slot and counts in the open total, and cannot be filled; once activated it fills tier 0: Dormant -> Open -> PartiallyFilled, after which it cannot be activated again", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId, input, created } = await f.placeLadder({
      activationPrice: usd(2_200n),
    });
    assert.equal(created.args.activationPrice, usd(2_200n));
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Dormant,
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Dormant);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: 450n * ONE_USDC,
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
    const { event: activated } = await f.activate(orderId);
    assert.equal(activated.args.price, usd(2_200n));
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);

    await f.setPrice(usd(1_950n));
    const { event } = await f.fill(orderId);
    assert.equal(event.args.usdcAmount, tierAt(input.tiers, 0).usdcAmount);
    assert.equal(event.args.fillNumber, 1n);
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
});

describe("LedgerTrigger Ladder orders: expiry", () => {
  it("a Ladder order can fill its next tier in its expiry second; one second later statusOf reports Expired while getOrder keeps PartiallyFilled, canFill reports Expired, a fill reverts with OrderExpired, and the owner cancels what is left; an order that never filled is stored Open and frees its whole budget", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const expiry = (await f.now()) + 1_000n;
    const partly = await f.placeLadder({ expiry });
    const never = await f.placeLadder({ expiry });
    await f.fill(partly.orderId);
    await f.setPrice(usd(1_900n));

    await f.networkHelpers.time.setNextBlockTimestamp(expiry);
    const { event, receipt } = await f.fill(partly.orderId);
    const block = await f.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.equal(block.timestamp, expiry);
    assert.equal(event.args.fillNumber, 2n);
    assert.equal(event.args.usdcAmount, 150n * ONE_USDC);

    await f.networkHelpers.time.increaseTo(expiry + 1n);
    for (const [{ orderId }, stored, remaining] of [
      [partly, Status.PartiallyFilled, 200n * ONE_USDC],
      [never, Status.Open, 450n * ONE_USDC],
    ] as const) {
      assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
      const order = await trigger.read.getOrder([orderId]);
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
        [orderId, expiry],
      );
    }
    assert.deepEqual(await f.bookOf(owner), {
      count: 2n,
      total: 650n * ONE_USDC,
    });

    const first = await cancel(f, partly.orderId);
    assert.equal(first.args.afterExpiry, true);
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: 450n * ONE_USDC,
    });
    const second = await cancel(f, never.orderId);
    assert.equal(second.args.afterExpiry, true);
    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
  });
});

describe("LedgerTrigger Ladder fills keep no money and add up", () => {
  it("over three fills the contract's USDC and ETH stay as they were, usdcRemaining plus what the fills spent is the budget, fillsDone never passes fillsTotal, and the owner pays exactly the tiers added up", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const { orderId, input } = await f.placeLadder();
    const budget = (await trigger.read.getOrder([orderId])).usdcAmount;
    const ownerStart = (await f.balancesOf(owner.account.address)).usdc;
    let spent = 0n;

    for (const tier of input.tiers) {
      await f.setPrice(tier.price);
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
    assert.equal(
      spent,
      input.tiers.reduce((sum, tier) => sum + tier.usdcAmount, 0n),
    );
    assert.equal(spent, budget);
  });
});
