// The details behind an order's row: a Dca order's schedule and a Ladder
// order's tiers, as the page shows them when the row is opened.
//
// Periods and tiers are numbered from 0, as the contract numbers them (the
// period index in `PeriodAlreadyFilled`, the tier index in
// `TiersNotDescending`, the positions `getTiers` returns).

import { OrderStatus } from "../../../keeper/names.ts";
import { formatAmount } from "./amounts.ts";
import type { Decimals, ScheduleData, TierData } from "./orders.ts";

const MINUTE = 60n;
const HOUR = 3600n;
const DAY = 86400n;

/** `count` and its word, plural unless the count is 1: "1 day", "3 days". */
export function plural(count: bigint, word: string): string {
  return `${count} ${word}${count === 1n ? "" : "s"}`;
}

/**
 * A length of time for people: whole days as "1 day" or "N days", otherwise
 * whole hours as "N h", otherwise whole minutes as "N min", otherwise "N s".
 */
export function formatPeriod(seconds: bigint): string {
  if (seconds > 0n && seconds % DAY === 0n) {
    return plural(seconds / DAY, "day");
  }
  if (seconds > 0n && seconds % HOUR === 0n) return `${seconds / HOUR} h`;
  if (seconds > 0n && seconds % MINUTE === 0n) {
    return `${seconds / MINUTE} min`;
  }
  return `${seconds} s`;
}

/** True while an order can still be filled some day: not finished, not over. */
function isLive(status: number): boolean {
  return (
    status === OrderStatus.Dormant ||
    status === OrderStatus.Open ||
    status === OrderStatus.PartiallyFilled
  );
}

/** What the page shows of a Dca order's schedule. */
export type ScheduleView = {
  /** Period 0 starts at this second (Unix time); the page writes the date. */
  readonly startAt: bigint;
  /** The length of a period: "1 day". */
  readonly every: string;
  /** The number of periods, which is the order's `fillsTotal`. */
  readonly periods: string;
  /** "10.00 USDC". */
  readonly perPeriod: string;
  /** No period is bought above this price: "2100.00 USD". */
  readonly cap: string;
  /**
   * The earliest period that may still be bought (`filledThrough`), or
   * "none" once no period is left: all bought, the schedule over, or the
   * order filled or cancelled.
   */
  readonly nextPeriod: string;
  /**
   * The period the latest block falls in, or "not started yet" before the
   * start, or "schedule over" after the last period.
   */
  readonly currentPeriod: string;
};

/**
 * The schedule of a Dca order: `schedule` as `getSchedule` returns it, the
 * order's cap (`targetPrice`) and number of periods (`fillsTotal`, which
 * `getSchedule` does not return), its `statusOf` value, and `now`, the
 * latest block's time.
 */
export function scheduleView(
  schedule: ScheduleData,
  order: { readonly targetPrice: bigint; readonly fillsTotal: bigint },
  status: number,
  now: bigint,
  decimals: Decimals,
): ScheduleView {
  const periodCount = order.fillsTotal;
  let current: bigint | undefined;
  let currentPeriod: string;
  if (now < schedule.startAt) {
    currentPeriod = "not started yet";
  } else if (schedule.periodLength === 0n) {
    currentPeriod = "unknown";
  } else {
    current = (now - schedule.startAt) / schedule.periodLength;
    currentPeriod = current >= periodCount ? "schedule over" : String(current);
  }
  const over = current !== undefined && current >= periodCount;
  const nextPeriod =
    !isLive(status) || over || schedule.filledThrough >= periodCount
      ? "none"
      : String(schedule.filledThrough);
  return {
    startAt: schedule.startAt,
    every: formatPeriod(schedule.periodLength),
    periods: String(periodCount),
    perPeriod: `${formatAmount(schedule.usdcPerPeriod, decimals.usdc)} USDC`,
    cap: `${formatAmount(order.targetPrice, decimals.price)} USD`,
    nextPeriod,
    currentPeriod,
  };
}

/** Where a tier stands. Each value is also a CSS class suffix. */
export const TierState = {
  /** Bought: its number is below the order's `fillsDone`. */
  Filled: "filled",
  /** The tier the next fill buys. */
  Next: "next",
  /** Comes after the next one. */
  Later: "later",
  /** Never bought: the order is finished or over before reaching it. */
  Unfilled: "unfilled",
} as const;

export type TierStateName = (typeof TierState)[keyof typeof TierState];

/** One tier as the page shows it. */
export type TierView = {
  /** Counted from 0. */
  readonly index: number;
  /** "1950.00". */
  readonly price: string;
  /** "10.00". */
  readonly amount: string;
  readonly state: TierStateName;
  /** "filled", "next", "later" or "not filled". */
  readonly stateText: string;
};

const TIER_STATE_TEXT: Readonly<Record<TierStateName, string>> = {
  [TierState.Filled]: "filled",
  [TierState.Next]: "next",
  [TierState.Later]: "later",
  [TierState.Unfilled]: "not filled",
};

/**
 * The tiers of a Ladder order, as `getTiers` returns them, with where each
 * stands: the first `fillsDone` are filled; while the order can still be
 * filled the one after them is next and the rest come later; once it cannot
 * (filled, cancelled or expired) the rest were never bought.
 */
export function tiersView(
  tiers: readonly TierData[],
  fillsDone: bigint,
  status: number,
  decimals: Decimals,
): TierView[] {
  const live = isLive(status);
  return tiers.map((tier, index) => {
    const position = BigInt(index);
    const state =
      position < fillsDone
        ? TierState.Filled
        : !live
          ? TierState.Unfilled
          : position === fillsDone
            ? TierState.Next
            : TierState.Later;
    return {
      index,
      price: formatAmount(tier.price, decimals.price),
      amount: formatAmount(tier.usdcAmount, decimals.usdc),
      state,
      stateText: TIER_STATE_TEXT[state],
    };
  });
}
