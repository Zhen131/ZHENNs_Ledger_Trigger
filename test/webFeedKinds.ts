import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  feedEntry,
  mergeFeed,
  newlyFilled,
  type FeedEntry,
  type FeedLog,
  type LogPosition,
} from "../web/src/lib/feed.ts";
import { OrderKind } from "../web/src/lib/kinds.ts";

// The event list's words for every kind of order and for the three newer
// events: a Dca order's schedule, a Ladder order's tiers, an activation; and
// "fill <n> of <N>" on a fill that is one of several.

const DECIMALS = { usdc: 6, price: 8 };
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const USDC = (whole: bigint) => whole * 1_000_000n;
const USD = (whole: bigint) => whole * 100_000_000n;

function at(blockNumber: bigint, logIndex = 0): LogPosition {
  return {
    blockNumber,
    logIndex,
    transactionHash: `0xbb${blockNumber.toString(16)}`,
    time: 2_000n + blockNumber,
  };
}

function created(
  kind: number,
  usdcAmount: bigint,
  targetPrice: bigint,
  activationPrice = 0n,
): string {
  return feedEntry(
    {
      eventName: "OrderCreated",
      args: {
        orderId: 1n,
        owner: OWNER,
        usdcAmount,
        targetPrice,
        kind,
        activationPrice,
      },
      position: at(5n),
    },
    DECIMALS,
  ).detail;
}

function filledLog(
  orderId: bigint,
  blockNumber: bigint,
  fillNumber: bigint,
  fillsTotal: bigint,
  logIndex = 0,
): FeedLog {
  return {
    eventName: "OrderFilled",
    args: {
      orderId,
      filledBy: KEEPER,
      usdcAmount: USDC(100n),
      ethReceived: 52_631_578_947_368_421n,
      price: USD(1900n),
      fillNumber,
      fillsTotal,
    },
    position: at(blockNumber, logIndex),
  };
}

function scheduled(blockNumber: bigint, periodCount: bigint): FeedEntry {
  return feedEntry(
    {
      eventName: "OrderScheduled",
      args: {
        orderId: 2n,
        startAt: 1_700_000_000n,
        periodLength: 86_400n,
        periodCount,
        usdcPerPeriod: USDC(10n),
      },
      position: at(blockNumber, 1),
    },
    DECIMALS,
  );
}

function tiered(
  blockNumber: bigint,
  tiers: readonly { price: bigint; usdcAmount: bigint }[],
): FeedEntry {
  return feedEntry(
    {
      eventName: "OrderTiered",
      args: { orderId: 3n, tiers },
      position: at(blockNumber, 1),
    },
    DECIMALS,
  );
}

function activated(blockNumber: bigint): FeedEntry {
  return feedEntry(
    {
      eventName: "OrderActivated",
      args: { orderId: 4n, activatedBy: KEEPER, price: USD(2150n) },
      position: at(blockNumber),
    },
    DECIMALS,
  );
}

describe("web event words: OrderCreated for every kind", () => {
  it("a limit order without an activation price keeps the first version's words", () => {
    assert.equal(
      created(OrderKind.Limit, USDC(100n), USD(1500n)),
      "100.00 USDC, target 1500.00 USD, owner 0xf39F…2266",
    );
  });

  it("a dormant limit order adds its activation price before the owner", () => {
    assert.equal(
      created(OrderKind.Limit, USDC(100n), USD(1900n), USD(2100n)),
      "100.00 USDC, target 1900.00 USD, activation 2100.00 USD, owner 0xf39F…2266",
    );
  });

  it("a Dca order names its kind, its whole budget and its cap", () => {
    assert.equal(
      created(OrderKind.Dca, USDC(30n), USD(2100n)),
      "Dca, 30.00 USDC in all, cap 2100.00 USD, owner 0xf39F…2266",
    );
    assert.equal(
      created(OrderKind.Dca, USDC(30n), USD(2100n), USD(2150n)),
      "Dca, 30.00 USDC in all, cap 2100.00 USD, activation 2150.00 USD, owner 0xf39F…2266",
    );
  });

  it("a Ladder order names its kind, its whole budget and its top tier", () => {
    assert.equal(
      created(OrderKind.Ladder, USDC(45n), USD(1950n)),
      "Ladder, 45.00 USDC in all, top tier 1950.00 USD, owner 0xf39F…2266",
    );
    assert.equal(
      created(OrderKind.Ladder, USDC(10n), USD(1650n), USD(1800n)),
      "Ladder, 10.00 USDC in all, top tier 1650.00 USD, activation 1800.00 USD, owner 0xf39F…2266",
    );
  });
});

describe("web event words: schedules, tiers and activations", () => {
  it("OrderScheduled: the periods, the amount of each and how often", () => {
    const entry = scheduled(5n, 3n);
    assert.equal(entry.eventName, "OrderScheduled");
    assert.equal(entry.orderId, 2n);
    assert.equal(entry.detail, "3 periods of 10.00 USDC, every 1 day");
    assert.equal(
      scheduled(5n, 1n).detail,
      "1 period of 10.00 USDC, every 1 day",
    );
  });

  it("OrderTiered: each tier's amount and price, in order", () => {
    const entry = tiered(6n, [
      { price: USD(1950n), usdcAmount: USDC(10n) },
      { price: USD(1900n), usdcAmount: USDC(15n) },
      { price: USD(1850n), usdcAmount: USDC(20n) },
    ]);
    assert.equal(entry.eventName, "OrderTiered");
    assert.equal(entry.orderId, 3n);
    assert.equal(
      entry.detail,
      "3 tiers: 10.00 USDC at 1950.00, 15.00 USDC at 1900.00, 20.00 USDC at 1850.00 USD",
    );
    assert.equal(
      tiered(6n, [{ price: USD(1650n), usdcAmount: USDC(10n) }]).detail,
      "1 tier: 10.00 USDC at 1650.00 USD",
    );
  });

  it("OrderActivated: the price then, and who pressed it", () => {
    const entry = activated(7n);
    assert.equal(entry.eventName, "OrderActivated");
    assert.equal(entry.orderId, 4n);
    assert.equal(entry.detail, "at 2150.00 USD, by 0x7099…79C8");
  });
});

describe("web event words: fills of an order that fills several times", () => {
  it("a fill of an order that fills once keeps the first version's words", () => {
    assert.equal(
      feedEntry(filledLog(1n, 6n, 1n, 1n), DECIMALS).detail,
      "100.00 USDC for 0.052632 ETH at 1900.00 USD, by 0x7099…79C8",
    );
  });

  it("a fill of an order that fills several times says which one it is", () => {
    assert.equal(
      feedEntry(filledLog(2n, 6n, 1n, 3n), DECIMALS).detail,
      "fill 1 of 3: 100.00 USDC for 0.052632 ETH at 1900.00 USD, by 0x7099…79C8",
    );
    assert.equal(
      feedEntry(filledLog(2n, 9n, 3n, 3n), DECIMALS).detail,
      "fill 3 of 3: 100.00 USDC for 0.052632 ETH at 1900.00 USD, by 0x7099…79C8",
    );
  });
});

describe("web event list: the newer events merge like the others", () => {
  it("newest first, each once, however often read", () => {
    const merged = mergeFeed(
      [scheduled(5n, 3n)],
      [activated(7n), tiered(6n, []), scheduled(5n, 3n), activated(7n)],
    );
    assert.deepEqual(
      merged.map((entry) => entry.eventName),
      ["OrderActivated", "OrderTiered", "OrderScheduled"],
    );
  });

  it("only fills flash: an activation does not", () => {
    const fills = [1n, 2n, 3n].map((n) =>
      feedEntry(filledLog(3n, 10n, n, 3n, Number(n)), DECIMALS),
    );
    assert.deepEqual(newlyFilled([], [activated(9n), ...fills]), [3n, 3n, 3n]);
    assert.deepEqual(newlyFilled([], [activated(9n), scheduled(9n, 2n)]), []);
  });
});
