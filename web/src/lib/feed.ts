// The event list at the bottom of the page: the contract's OrderCreated,
// OrderCancelled and OrderFilled events, everyone's, newest first, at most
// FEED_LIMIT of them.

import type { Address, Hex } from "viem";

import { formatAmount, formatFixed } from "./amounts.ts";
import { shortAddress } from "./format.ts";
import type { Decimals } from "./orders.ts";

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

function detailOf(log: FeedLog, decimals: Decimals): string {
  switch (log.eventName) {
    case "OrderCreated":
      return `${formatAmount(log.args.usdcAmount, decimals.usdc)} USDC, target ${formatAmount(log.args.targetPrice, decimals.price)} USD, owner ${shortAddress(log.args.owner)}`;
    case "OrderCancelled":
      return `by ${shortAddress(log.args.owner)}${log.args.afterExpiry ? ", after expiry" : ""}`;
    case "OrderFilled":
      return `${formatAmount(log.args.usdcAmount, decimals.usdc)} USDC for ${formatFixed(log.args.ethReceived, ETH_DECIMALS, ETH_PLACES)} ETH at ${formatAmount(log.args.price, decimals.price)} USD, by ${shortAddress(log.args.filledBy)}`;
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
