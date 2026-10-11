// Keeps up with the contract's events: every OrderCreated (to find my
// orders) and the newest 50 of the three kinds the event list shows. The
// first read starts at block 0; each later one reads only the new blocks.

import { readEvents } from "./chain.ts";
import {
  feedEntry,
  mergeFeed,
  newlyFilled,
  type FeedEntry,
} from "./lib/feed.ts";
import type { CreatedOrder } from "./lib/orders.ts";
import type { Page } from "./page.ts";

let created: CreatedOrder[] = [];
let feed: FeedEntry[] = [];
let nextBlock = 0n;
let loaded = false;
const blockTimes = new Map<bigint, bigint>();

/** Forgets everything read, for another contract or a restarted chain. */
export function resetEvents(): void {
  created = [];
  feed = [];
  nextBlock = 0n;
  loaded = false;
  blockTimes.clear();
}

/** Every order placed on the contract so far (ID and owner). */
export function createdOrders(): readonly CreatedOrder[] {
  return created;
}

/** The event list, newest first. */
export function feedEntries(): readonly FeedEntry[] {
  return feed;
}

export type EventPull = {
  /** Orders whose OrderFilled event just arrived (none on the first read). */
  readonly filled: readonly bigint[];
  /** True when the chain is shorter than before: the node was restarted. */
  readonly restarted: boolean;
};

/** Reads the events of the blocks not read yet, up to the latest block. */
export async function pullEvents(page: Page): Promise<EventPull> {
  const trigger = page.trigger;
  const latest = page.latest;
  if (trigger === undefined || latest === undefined) {
    return { filled: [], restarted: false };
  }
  if (latest.number + 1n < nextBlock) return { filled: [], restarted: true };
  if (latest.number < nextBlock) return { filled: [], restarted: false };
  const read = await readEvents(
    page.reader,
    trigger,
    nextBlock,
    latest.number,
    blockTimes,
  );
  const entries = read.logs.map((log) => feedEntry(log, trigger.decimals));
  const filled = loaded ? newlyFilled(feed, entries) : [];
  feed = mergeFeed(feed, entries);
  created = [...created, ...read.created];
  nextBlock = latest.number + 1n;
  loaded = true;
  return { filled, restarted: false };
}
