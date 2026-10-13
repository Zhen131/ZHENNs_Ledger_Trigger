// The event list at the bottom of the page: the contract's OrderCreated,
// OrderScheduled, OrderTiered, OrderActivated, OrderCancelled and OrderFilled
// events, everyone's, newest first, at most FEED_LIMIT of them.

import type { Address, Hex } from "viem";

import { formatAmount, formatFixed } from "./amounts.ts";
import { formatPeriod, plural } from "./details.ts";
import { shortAddress } from "./format.ts";
import { OrderKind, orderKindName } from "./kinds.ts";
import type { Decimals, TierData } from "./orders.ts";

export const FEED_LIMIT = 50;

/** ETH has 18 decimals; the list shows 6 of them. */
const ETH_DECIMALS = 18;
const ETH_PLACES = 6;

/** One event as read from the chain, with the time of its block. */
export type FeedLog =
  | {
      readonly eventName: "OrderCreated";
      readonly args: {
        readonly orderId: bigint;
        readonly owner: Address;
        readonly usdcAmount: bigint;
        readonly targetPrice: bigint;
        /** An OrderKind value. */
        readonly kind: number;
        /** 0 when the order was placed awake. */
        readonly activationPrice: bigint;
      };
      readonly position: LogPosition;
    }
  | {
      readonly eventName: "OrderScheduled";
      readonly args: {
        readonly orderId: bigint;
        readonly startAt: bigint;
        readonly periodLength: bigint;
        readonly periodCount: bigint;
        readonly usdcPerPeriod: bigint;
      };
      readonly position: LogPosition;
    }
  | {
      readonly eventName: "OrderTiered";
      readonly args: {
        readonly orderId: bigint;
        readonly tiers: readonly TierData[];
      };
      readonly position: LogPosition;
    }
  | {
      readonly eventName: "OrderActivated";
      readonly args: {
        readonly orderId: bigint;
        readonly activatedBy: Address;
        readonly price: bigint;
      };
      readonly position: LogPosition;
    }
  | {
      readonly eventName: "OrderCancelled";
      readonly args: {
        readonly orderId: bigint;
        readonly owner: Address;
        readonly afterExpiry: boolean;
      };
      readonly position: LogPosition;
    }
  | {
      readonly eventName: "OrderFilled";
      readonly args: {
        readonly orderId: bigint;
        readonly filledBy: Address;
        readonly usdcAmount: bigint;
        readonly ethReceived: bigint;
        readonly price: bigint;
        /** Which fill this is, counted from 1. */
        readonly fillNumber: bigint;
        readonly fillsTotal: bigint;
      };
      readonly position: LogPosition;
    };

/** Where an event sits on the chain. */
export type LogPosition = {
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: Hex;
  /** The block's time, Unix seconds. */
  readonly time: bigint;
};

export type FeedEntry = {
  /** Unique per event: transaction hash and log index. */
  readonly key: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly time: bigint;
  readonly eventName: FeedLog["eventName"];
  readonly orderId: bigint;
  /** The key numbers, for example "100.00 USDC, target 1500.00 USD". */
  readonly detail: string;
};

/**
 * An OrderCreated event's numbers. A limit order keeps the first version's
 * words ("100.00 USDC, target 1500.00 USD, owner 0xf39F…2266"); a Dca or
 * Ladder order names its kind and its whole budget; an activation price, when
 * there is one, comes before the owner.
 */
function createdDetail(
  args: Extract<FeedLog, { eventName: "OrderCreated" }>["args"],
  decimals: Decimals,
): string {
  const usdc = formatAmount(args.usdcAmount, decimals.usdc);
  const target = formatAmount(args.targetPrice, decimals.price);
  const parts =
    args.kind === OrderKind.Limit
      ? [`${usdc} USDC`, `target ${target} USD`]
      : args.kind === OrderKind.Dca
        ? ["Dca", `${usdc} USDC in all`, `cap ${target} USD`]
        : args.kind === OrderKind.Ladder
          ? ["Ladder", `${usdc} USDC in all`, `top tier ${target} USD`]
          : [
              orderKindName(args.kind),
              `${usdc} USDC in all`,
              `target ${target} USD`,
            ];
  if (args.activationPrice > 0n) {
    parts.push(
      `activation ${formatAmount(args.activationPrice, decimals.price)} USD`,
    );
  }
  parts.push(`owner ${shortAddress(args.owner)}`);
  return parts.join(", ");
}

/** "3 tiers: 10.00 USDC at 1950.00, 15.00 USDC at 1900.00 USD". */
function tieredDetail(tiers: readonly TierData[], decimals: Decimals): string {
  const each = tiers.map(
    (tier) =>
      `${formatAmount(tier.usdcAmount, decimals.usdc)} USDC at ${formatAmount(tier.price, decimals.price)}`,
  );
  const count = plural(BigInt(tiers.length), "tier");
  return each.length === 0 ? count : `${count}: ${each.join(", ")} USD`;
}

function detailOf(log: FeedLog, decimals: Decimals): string {
  switch (log.eventName) {
    case "OrderCreated":
      return createdDetail(log.args, decimals);
    case "OrderScheduled":
      return `${plural(log.args.periodCount, "period")} of ${formatAmount(log.args.usdcPerPeriod, decimals.usdc)} USDC, every ${formatPeriod(log.args.periodLength)}`;
    case "OrderTiered":
      return tieredDetail(log.args.tiers, decimals);
    case "OrderActivated":
      return `at ${formatAmount(log.args.price, decimals.price)} USD, by ${shortAddress(log.args.activatedBy)}`;
    case "OrderCancelled":
      return `by ${shortAddress(log.args.owner)}${log.args.afterExpiry ? ", after expiry" : ""}`;
    case "OrderFilled": {
      const fill = `${formatAmount(log.args.usdcAmount, decimals.usdc)} USDC for ${formatFixed(log.args.ethReceived, ETH_DECIMALS, ETH_PLACES)} ETH at ${formatAmount(log.args.price, decimals.price)} USD, by ${shortAddress(log.args.filledBy)}`;
      return log.args.fillsTotal > 1n
        ? `fill ${log.args.fillNumber} of ${log.args.fillsTotal}: ${fill}`
        : fill;
    }
  }
}

/** The list entry for one event. */
export function feedEntry(log: FeedLog, decimals: Decimals): FeedEntry {
  return {
    key: `${log.position.transactionHash}:${log.position.logIndex}`,
    blockNumber: log.position.blockNumber,
    logIndex: log.position.logIndex,
    time: log.position.time,
    eventName: log.eventName,
    orderId: log.args.orderId,
    detail: detailOf(log, decimals),
  };
}

function newestFirst(a: FeedEntry, b: FeedEntry): number {
  if (a.blockNumber !== b.blockNumber)
    return a.blockNumber > b.blockNumber ? -1 : 1;
  return b.logIndex - a.logIndex;
}

/**
 * `current` with `incoming` added: each event once (by key), newest first
 * (by block, then by position in the block), at most `limit` entries.
 */
export function mergeFeed(
  current: readonly FeedEntry[],
  incoming: readonly FeedEntry[],
  limit = FEED_LIMIT,
): FeedEntry[] {
  const byKey = new Map<string, FeedEntry>();
  for (const entry of [...current, ...incoming]) byKey.set(entry.key, entry);
  return [...byKey.values()].sort(newestFirst).slice(0, limit);
}

/**
 * IDs of the orders that `incoming` reports filled and `current` did not
 * have yet: the rows to flash.
 */
export function newlyFilled(
  current: readonly FeedEntry[],
  incoming: readonly FeedEntry[],
): bigint[] {
  const known = new Set(current.map((entry) => entry.key));
  return incoming
    .filter(
      (entry) => entry.eventName === "OrderFilled" && !known.has(entry.key),
    )
    .map((entry) => entry.orderId);
}
