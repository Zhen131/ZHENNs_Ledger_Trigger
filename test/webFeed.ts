import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FEED_LIMIT,
  feedEntry,
  mergeFeed,
  newlyFilled,
  type FeedEntry,
  type LogPosition,
} from "../web/src/lib/feed.ts";

// The event list keeps the newest events of the contract, each once, newest
// first, at most FEED_LIMIT of them.

const DECIMALS = { usdc: 6, price: 8 };
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function at(blockNumber: bigint, logIndex = 0): LogPosition {
  return {
    blockNumber,
    logIndex,
    transactionHash: `0xaa${blockNumber.toString(16)}`,
    time: 1_000n + blockNumber,
  };
}

function created(
  orderId: bigint,
  blockNumber: bigint,
  logIndex = 0,
): FeedEntry {
  return feedEntry(
    {
      eventName: "OrderCreated",
      args: {
        orderId,
        owner: OWNER,
        usdcAmount: 100_000_000n,
        targetPrice: 150_000_000_000n,
      },
      position: at(blockNumber, logIndex),
    },
    DECIMALS,
  );
}

function filled(orderId: bigint, blockNumber: bigint): FeedEntry {
  return feedEntry(
    {
      eventName: "OrderFilled",
      args: {
        orderId,
        filledBy: KEEPER,
        usdcAmount: 100_000_000n,
        ethReceived: 52_631_578_947_368_421n,
        price: 190_000_000_000n,
      },
      position: at(blockNumber),
    },
    DECIMALS,
  );
}

describe("web event list: entries", () => {
  it("names the event, the order and the key numbers", () => {
    const entry = created(1n, 5n);
    assert.equal(entry.eventName, "OrderCreated");
    assert.equal(entry.orderId, 1n);
    assert.equal(entry.blockNumber, 5n);
    assert.equal(entry.time, 1_005n);
    assert.equal(
      entry.detail,
      "100.00 USDC, target 1500.00 USD, owner 0xf39F…2266",
    );
    assert.equal(
      filled(1n, 6n).detail,
      "100.00 USDC for 0.052632 ETH at 1900.00 USD, by 0x7099…79C8",
    );
    const cancelled = (afterExpiry: boolean) =>
      feedEntry(
        {
          eventName: "OrderCancelled",
          args: { orderId: 2n, owner: OWNER, afterExpiry },
          position: at(7n),
        },
        DECIMALS,
      ).detail;
    assert.equal(cancelled(false), "by 0xf39F…2266");
    assert.equal(cancelled(true), "by 0xf39F…2266, after expiry");
  });
});

describe("web event list: merging", () => {
  it("newest first: by block, then by position in the block", () => {
    const merged = mergeFeed(
      [created(1n, 3n)],
      [created(3n, 5n, 1), created(2n, 5n, 0)],
    );
    assert.deepEqual(
      merged.map((entry) => entry.orderId),
      [3n, 2n, 1n],
    );
  });

  it("each event once, however often it is read", () => {
    const merged = mergeFeed(
      [created(1n, 3n)],
      [created(1n, 3n), created(2n, 4n)],
    );
    assert.equal(merged.length, 2);
  });

  it("keeps at most 50, dropping the oldest", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      created(BigInt(i + 1), BigInt(i + 1)),
    );
    const merged = mergeFeed([], many);
    assert.equal(FEED_LIMIT, 50);
    assert.equal(merged.length, 50);
    assert.equal(merged[0]?.orderId, 60n);
    assert.equal(merged.at(-1)?.orderId, 11n);
  });

  it("finds the fills that are new, to flash their rows", () => {
    const current = [created(1n, 3n), filled(9n, 4n)];
    assert.deepEqual(
      newlyFilled(current, [filled(9n, 4n), filled(1n, 8n), created(2n, 8n)]),
      [1n],
    );
  });
});
