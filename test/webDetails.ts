import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OrderStatus } from "../keeper/names.ts";
import {
  TierState,
  formatPeriod,
  scheduleView,
  tiersView,
} from "../web/src/lib/details.ts";
import type { ScheduleData, TierData } from "../web/src/lib/orders.ts";

// The details behind a row: a Dca order's schedule, read with the latest
// block's time, and a Ladder order's tiers with where each stands.

const DECIMALS = { usdc: 6, price: 8 };

describe("web period lengths", () => {
  it("whole days as days, one day without an s", () => {
    assert.equal(formatPeriod(86_400n), "1 day");
    assert.equal(formatPeriod(2n * 86_400n), "2 days");
    assert.equal(formatPeriod(7n * 86_400n), "7 days");
  });

  it("otherwise whole hours as h", () => {
    assert.equal(formatPeriod(3_600n), "1 h");
    assert.equal(formatPeriod(25n * 3_600n), "25 h");
  });

  it("otherwise whole minutes as min", () => {
    assert.equal(formatPeriod(60n), "1 min");
    assert.equal(formatPeriod(90n * 60n), "90 min");
  });

  it("otherwise seconds as s", () => {
    assert.equal(formatPeriod(90n), "90 s");
    assert.equal(formatPeriod(1n), "1 s");
  });
});

describe("web Dca schedule", () => {
  // Period 0 is [1000, 1099], period 1 [1100, 1199], period 2 [1200, 1299].
  const SCHEDULE: ScheduleData = {
    startAt: 1_000n,
    periodLength: 100n,
    usdcPerPeriod: 10_000_000n,
    filledThrough: 0n,
  };
  const ORDER = { targetPrice: 210_000_000_000n, fillsTotal: 3n };
  const view = (schedule: ScheduleData, status: number, now: bigint) =>
    scheduleView(schedule, ORDER, status, now, DECIMALS);

  it("shows the start, the period, the number of periods from fillsTotal, the amount and the cap", () => {
    const shown = view(SCHEDULE, OrderStatus.Open, 1_050n);
    assert.equal(shown.startAt, 1_000n);
    assert.equal(shown.every, "100 s");
    assert.equal(shown.periods, "3");
    assert.equal(shown.perPeriod, "10.00 USDC");
    assert.equal(shown.cap, "2100.00 USD");
    assert.equal(
      scheduleView(
        { ...SCHEDULE, periodLength: 86_400n },
        { ...ORDER, fillsTotal: 52n },
        OrderStatus.Open,
        1_050n,
        DECIMALS,
      ).periods,
      "52",
    );
  });

  it("the next period is filledThrough, and the current one follows the latest block's time", () => {
    const fresh = view(SCHEDULE, OrderStatus.Open, 1_050n);
    assert.equal(fresh.nextPeriod, "0");
    assert.equal(fresh.currentPeriod, "0");
    const afterFirst = view(
      { ...SCHEDULE, filledThrough: 1n },
      OrderStatus.PartiallyFilled,
      1_099n,
    );
    assert.equal(afterFirst.nextPeriod, "1");
    assert.equal(afterFirst.currentPeriod, "0");
    const nextDay = view(
      { ...SCHEDULE, filledThrough: 1n },
      OrderStatus.PartiallyFilled,
      1_100n,
    );
    assert.equal(nextDay.currentPeriod, "1");
    assert.equal(view(SCHEDULE, OrderStatus.Open, 1_299n).currentPeriod, "2");
  });

  it("before the start: not started yet", () => {
    const shown = view(
      { ...SCHEDULE, startAt: 2_000n },
      OrderStatus.Open,
      1_999n,
    );
    assert.equal(shown.currentPeriod, "not started yet");
    assert.equal(shown.nextPeriod, "0");
  });

  it("after the last period: schedule over, and no next period", () => {
    const shown = view(
      { ...SCHEDULE, filledThrough: 1n },
      OrderStatus.Expired,
      1_300n,
    );
    assert.equal(shown.currentPeriod, "schedule over");
    assert.equal(shown.nextPeriod, "none");
    assert.equal(
      view(SCHEDULE, OrderStatus.PartiallyFilled, 5_000n).nextPeriod,
      "none",
    );
  });

  it("no next period once every period is bought, or the order is filled or cancelled", () => {
    assert.equal(
      view({ ...SCHEDULE, filledThrough: 3n }, OrderStatus.Filled, 1_250n)
        .nextPeriod,
      "none",
    );
    assert.equal(
      view(
        { ...SCHEDULE, filledThrough: 3n },
        OrderStatus.PartiallyFilled,
        1_250n,
      ).nextPeriod,
      "none",
    );
    assert.equal(
      view({ ...SCHEDULE, filledThrough: 1n }, OrderStatus.Cancelled, 1_150n)
        .nextPeriod,
      "none",
    );
  });
});

describe("web Ladder tiers", () => {
  const TIERS: TierData[] = [
    { price: 195_000_000_000n, usdcAmount: 10_000_000n },
    { price: 190_000_000_000n, usdcAmount: 15_000_000n },
    { price: 185_000_000_000n, usdcAmount: 20_000_000n },
  ];
  const states = (fillsDone: bigint, status: number) =>
    tiersView(TIERS, fillsDone, status, DECIMALS).map((tier) => tier.state);

  it("each tier's number from 0, its price and its amount", () => {
    assert.deepEqual(
      tiersView(TIERS, 0n, OrderStatus.Open, DECIMALS).map((tier) => [
        tier.index,
        tier.price,
        tier.amount,
      ]),
      [
        [0, "1950.00", "10.00"],
        [1, "1900.00", "15.00"],
        [2, "1850.00", "20.00"],
      ],
    );
  });

  it("before any fill tier 0 is next, also while the order is dormant", () => {
    for (const status of [OrderStatus.Open, OrderStatus.Dormant]) {
      assert.deepEqual(states(0n, status), [
        TierState.Next,
        TierState.Later,
        TierState.Later,
      ]);
    }
  });

  it("tiers below fillsDone are filled, and the one at fillsDone is next", () => {
    assert.deepEqual(states(1n, OrderStatus.PartiallyFilled), [
      TierState.Filled,
      TierState.Next,
      TierState.Later,
    ]);
    assert.deepEqual(
      tiersView(TIERS, 2n, OrderStatus.PartiallyFilled, DECIMALS).map(
        (tier) => tier.stateText,
      ),
      ["filled", "filled", "next"],
    );
  });

  it("once filled, every tier is filled and none is next", () => {
    assert.deepEqual(states(3n, OrderStatus.Filled), [
      TierState.Filled,
      TierState.Filled,
      TierState.Filled,
    ]);
  });

  it("after a cancel, or once expired, the tiers not bought say so", () => {
    assert.deepEqual(
      tiersView(TIERS, 1n, OrderStatus.Cancelled, DECIMALS).map(
        (tier) => tier.stateText,
      ),
      ["filled", "not filled", "not filled"],
    );
    assert.deepEqual(states(2n, OrderStatus.Expired), [
      TierState.Filled,
      TierState.Filled,
      TierState.Unfilled,
    ]);
  });
});
