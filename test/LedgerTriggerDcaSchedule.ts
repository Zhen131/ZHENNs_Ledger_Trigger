import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Hash } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { FillBlocker, ONE_DAY, Status, setUpFills } from "./setUpFills.ts";

// The schedule of a time-scheduled (Dca) order: which second belongs to which
// period, and what getSchedule returns. Period p of an order that starts at S
// with periods of L seconds runs from S + p * L to S + (p + 1) * L - 1, and
// the order's expiry is the last second of its last period.

const ONE_HOUR = 3_600n;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/** Sets the price again, unchanged, in a block at exactly `time`. */
async function refreshPriceAt(f: Fixture, time: bigint) {
  await f.networkHelpers.time.setNextBlockTimestamp(time);
  await f.setPrice(await f.price());
}

/** Sends the executor's fill of `orderId` in a block at exactly `time`. */
async function sendFillAt(
  f: Fixture,
  orderId: bigint,
  time: bigint,
): Promise<Hash> {
  await f.networkHelpers.time.setNextBlockTimestamp(time);
  return f.sendFill(orderId);
}

/** Fills `orderId` as the executor in a block at exactly `time`. */
async function fillAt(f: Fixture, orderId: bigint, time: bigint) {
  await f.networkHelpers.time.setNextBlockTimestamp(time);
  const filled = await f.fill(orderId);
  const block = await f.publicClient.getBlock({
    blockNumber: filled.receipt.blockNumber,
  });
  assert.equal(block.timestamp, time);
  return filled;
}

describe("LedgerTrigger Dca fills: the seconds at the edges of each period", () => {
  it("a fill one second before the start reverts with NotStarted, at the start buys period 0, in the last second of period 0 reverts with PeriodAlreadyFilled, in the first second of period 1 buys it, and in the expiry second buys period 2 and fills the order; canFill gives the same reason in the block of each rejected fill", async () => {
    const f = await setUpFills();
    const { trigger } = f;
    const start = (await f.now()) + 1_000n;
    const { orderId } = await f.placeDca({
      startAt: start,
      periodLength: ONE_HOUR,
      periodCount: 3n,
    });
    const expiry = start + 3n * ONE_HOUR - 1n;
    assert.equal((await trigger.read.getOrder([orderId])).expiry, expiry);

    await refreshPriceAt(f, start - 2n);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendFillAt(f, orderId, start - 1n),
      trigger,
      "NotStarted",
      [orderId, start],
    );
    assert.equal(await f.now(), start - 1n);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.NotStarted,
    });

    const first = await fillAt(f, orderId, start);
    assert.equal(first.event.args.fillNumber, 1n);
    assert.equal((await f.scheduleOf(orderId)).filledThrough, 1n);

    await refreshPriceAt(f, start + ONE_HOUR - 2n);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendFillAt(f, orderId, start + ONE_HOUR - 1n),
      trigger,
      "PeriodAlreadyFilled",
      [orderId, 0n],
    );
    assert.equal(await f.now(), start + ONE_HOUR - 1n);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.PeriodAlreadyFilled,
    });

    const second = await fillAt(f, orderId, start + ONE_HOUR);
    assert.equal(second.event.args.fillNumber, 2n);
    assert.equal((await f.scheduleOf(orderId)).filledThrough, 2n);

    await refreshPriceAt(f, expiry - 1n);
    const third = await fillAt(f, orderId, expiry);
    assert.equal(third.event.args.fillNumber, 3n);
    assert.equal((await f.scheduleOf(orderId)).filledThrough, 3n);
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Filled,
    );
  });

  it("an order that bought period 0 only can still be filled in the very second of its expiry, and not one second later: from then on canFill and statusOf say Expired and the fill reverts with OrderExpired", async () => {
    const f = await setUpFills();
    const { trigger } = f;
    const { orderId } = await f.placeDca({
      periodLength: ONE_HOUR,
      periodCount: 3n,
    });
    await f.fill(orderId);
    const { expiry } = await trigger.read.getOrder([orderId]);

    await refreshPriceAt(f, expiry - 1n);
    await f.networkHelpers.time.increaseTo(expiry);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    assert.equal(
      await trigger.read.statusOf([orderId]),
      Status.PartiallyFilled,
    );

    await f.networkHelpers.time.increaseTo(expiry + 1n);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.Expired,
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      trigger,
      "OrderExpired",
      [orderId, expiry],
    );
  });
});

describe("LedgerTrigger getSchedule (S49)", () => {
  it("S49 returns the four fields of a Dca order's schedule to anyone, and filledThrough follows the fills", async () => {
    const f = await setUpFills();
    const { trigger, stranger } = f;
    const { orderId, input, receipt } = await f.placeDca();
    const { timestamp } = await f.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    const read = () =>
      trigger.read.getSchedule([orderId], { account: stranger.account });

    assert.deepEqual(await read(), {
      startAt: timestamp,
      periodLength: ONE_DAY,
      usdcPerPeriod: input.usdcPerPeriod,
      filledThrough: 0n,
    });

    await f.fill(orderId);

    assert.deepEqual(await read(), {
      startAt: timestamp,
      periodLength: ONE_DAY,
      usdcPerPeriod: input.usdcPerPeriod,
      filledThrough: 1n,
    });
  });

  it("S49 rejects a plain order and a dormant Limit order with NotADcaOrder naming the order", async () => {
    const f = await setUpFills();
    const plain = (await f.place()).orderId;
    const dormant = (await f.placeDormant()).orderId;

    for (const orderId of [plain, dormant]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.trigger.read.getSchedule([orderId], {
          account: f.stranger.account,
        }),
        f.trigger,
        "NotADcaOrder",
        [orderId],
      );
    }
  });

  it("S49 rejects ID 0 and an ID that no order has with OrderNotFound", async () => {
    const f = await setUpFills();
    await f.placeDca();

    for (const orderId of [0n, 2n]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.trigger.read.getSchedule([orderId]),
        f.trigger,
        "OrderNotFound",
        [orderId],
      );
    }
  });

  it("S49 still returns the schedule of a Dca order that is filled, one that is cancelled and one that has expired", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const filled = await f.placeDca({ periodCount: 1n });
    await f.fill(filled.orderId);
    const cancelled = await f.placeDca({
      usdcPerPeriod: 7n * ONE_USDC,
      periodLength: ONE_HOUR,
    });
    await f.mined(
      await trigger.write.cancelOrder([cancelled.orderId], {
        account: owner.account,
      }),
    );
    const expired = await f.placeDca({
      targetPrice: usd(1_000n),
      periodLength: ONE_HOUR,
      periodCount: 2n,
    });
    const { expiry } = await trigger.read.getOrder([expired.orderId]);
    await f.networkHelpers.time.increaseTo(expiry + 1n);

    assert.equal(await trigger.read.statusOf([filled.orderId]), Status.Filled);
    assert.equal(
      await trigger.read.statusOf([cancelled.orderId]),
      Status.Cancelled,
    );
    assert.equal(
      await trigger.read.statusOf([expired.orderId]),
      Status.Expired,
    );
    for (const [{ orderId, input, scheduled }, filledThrough] of [
      [filled, 1n],
      [cancelled, 0n],
      [expired, 0n],
    ] as const) {
      assert.deepEqual(await trigger.read.getSchedule([orderId]), {
        startAt: scheduled.args.startAt,
        periodLength: input.periodLength,
        usdcPerPeriod: input.usdcPerPeriod,
        filledThrough,
      });
    }
  });
});
