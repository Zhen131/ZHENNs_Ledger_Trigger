import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Hash } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  FillBlocker,
  Status,
  setUpFills,
  type LadderInput,
} from "./setUpFills.ts";

// canFill and fillOrder run the same checks in the same order on a Ladder
// order too: whatever canFill reports, fillOrder rejects with the matching
// error, naming the price or the amount of the next tier, and once canFill
// reports None the executor's fill goes through. The price feed starts at
// 2000 USD; the default Ladder order has three tiers, 100 USDC at 2000 USD,
// 150 USDC at 1900 USD and 200 USDC at 1800 USD.

const MAX_PRICE_AGE = DEFAULT_LIMITS.maxPriceAge;
const TIER0_PRICE = usd(2_000n);
const TIER1_PRICE = usd(1_900n);
const TIER0_AMOUNT = 100n * ONE_USDC;
const TIER1_AMOUNT = 150n * ONE_USDC;
/** A price between tier 0 and tier 1: tier 0 can fill, tier 1 cannot. */
const BETWEEN = usd(1_950n);

type Fixture = Awaited<ReturnType<typeof setUpFills>>;
type Reason = (typeof FillBlocker)[keyof typeof FillBlocker];

/** One way to make a Ladder order unfillable, and what each side then says. */
type Case = {
  readonly label: string;
  readonly reason: Reason;
  /**
   * Places and prepares the order; returns its ID and a check that a fill
   * sent for it reverts with the matching error and values.
   */
  readonly prepare: (f: Fixture) => Promise<{
    readonly orderId: bigint;
    readonly rejects: (fill: Promise<Hash>) => Promise<void>;
  }>;
};

/** Places a Ladder order with the default input changed by `changes`. */
async function placed(f: Fixture, changes: Partial<LadderInput> = {}) {
  return (await f.placeLadder(changes)).orderId;
}

/** Places a Ladder order and fills its tier 0 at `BETWEEN`. */
async function placedAfterTier0(f: Fixture) {
  const orderId = await placed(f);
  await f.setPrice(BETWEEN);
  await f.fill(orderId);
  return orderId;
}

/** Leaves the owner with `left` USDC, giving the rest to the stranger. */
async function leaveOwnerWith(f: Fixture, left: bigint) {
  const balance = (await f.balancesOf(f.owner.account.address)).usdc;
  await f.mined(
    await f.usdc.write.transfer([f.stranger.account.address, balance - left], {
      account: f.owner.account,
    }),
  );
}

/** Asserts that canFill reports `reason` and fillOrder reverts to match. */
async function assertBothSay(
  f: Fixture,
  orderId: bigint,
  reason: Reason,
  rejects: (fill: Promise<Hash>) => Promise<void>,
) {
  assert.notEqual(reason, FillBlocker.None);
  assert.deepEqual(await f.canFill(orderId), { fillable: false, reason });
  await rejects(f.sendFill(orderId));
}

const ONE_REASON: readonly Case[] = [
  {
    label:
      "NotOpen, not a panic, for a Ladder order whose every tier is filled",
    reason: FillBlocker.NotOpen,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.setPrice(usd(1_700n));
      for (let i = 0; i < 3; i += 1) await f.fill(orderId);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "OrderNotOpen",
            [orderId, Status.Filled],
          ),
      };
    },
  },
  {
    label: "NotOpen for a Ladder order that is cancelled",
    reason: FillBlocker.NotOpen,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.mined(
        await f.trigger.write.cancelOrder([orderId], {
          account: f.owner.account,
        }),
      );
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "OrderNotOpen",
            [orderId, Status.Cancelled],
          ),
      };
    },
  },
  {
    label: "Dormant",
    reason: FillBlocker.Dormant,
    prepare: async (f) => {
      const orderId = await placed(f, { activationPrice: usd(2_200n) });
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "OrderNotOpen",
            [orderId, Status.Dormant],
          ),
      };
    },
  },
  {
    label: "Expired",
    reason: FillBlocker.Expired,
    prepare: async (f) => {
      const orderId = await placedAfterTier0(f);
      const { expiry } = await f.trigger.read.getOrder([orderId]);
      await f.networkHelpers.time.increaseTo(expiry + 1n);
      await f.setPrice(usd(1_700n));
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "OrderExpired",
            [orderId, expiry],
          ),
      };
    },
  },
  {
    label: "InvalidPrice",
    reason: FillBlocker.InvalidPrice,
    prepare: async (f) => {
      const orderId = await placedAfterTier0(f);
      await f.setPrice(0n);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "InvalidPrice",
            [0n],
          ),
      };
    },
  },
  {
    label: "StalePrice",
    reason: FillBlocker.StalePrice,
    prepare: async (f) => {
      const orderId = await placedAfterTier0(f);
      const updatedAt = (await f.now()) - MAX_PRICE_AGE - 10n;
      await f.setUpdatedAt(updatedAt);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "StalePrice",
            [updatedAt, MAX_PRICE_AGE],
          ),
      };
    },
  },
  {
    label:
      "PriceAboveTarget after tier 0, at a price between tier 0 and tier 1, naming the price of tier 1",
    reason: FillBlocker.PriceAboveTarget,
    prepare: async (f) => {
      const orderId = await placedAfterTier0(f);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "PriceAboveTarget",
            [BETWEEN, TIER1_PRICE],
          ),
      };
    },
  },
  {
    label:
      "InsufficientAllowance after tier 0, with an allowance that covered tier 0 but not tier 1 too, naming the amount of tier 1",
    reason: FillBlocker.InsufficientAllowance,
    prepare: async (f) => {
      await f.approve(
        f.owner,
        TIER0_AMOUNT + TIER1_AMOUNT - 1n,
        f.trigger.address,
      );
      const orderId = await placedAfterTier0(f);
      await f.setPrice(TIER1_PRICE);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "InsufficientAllowance",
            [TIER1_AMOUNT - 1n, TIER1_AMOUNT],
          ),
      };
    },
  },
  {
    label:
      "InsufficientBalance after tier 0, with a balance one unit below tier 1, naming the amount of tier 1",
    reason: FillBlocker.InsufficientBalance,
    prepare: async (f) => {
      const orderId = await placedAfterTier0(f);
      await leaveOwnerWith(f, TIER1_AMOUNT - 1n);
      await f.setPrice(TIER1_PRICE);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "InsufficientBalance",
            [TIER1_AMOUNT - 1n, TIER1_AMOUNT],
          ),
      };
    },
  },
];

const TWO_REASONS: readonly Case[] = [
  {
    label: "dormant and a price above tier 0 gives Dormant",
    reason: FillBlocker.Dormant,
    prepare: async (f) => {
      const orderId = await placed(f, { activationPrice: usd(2_200n) });
      await f.setPrice(TIER0_PRICE + 1n);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "OrderNotOpen",
            [orderId, Status.Dormant],
          ),
      };
    },
  },
  {
    label: "expired and a price above tier 0 gives Expired",
    reason: FillBlocker.Expired,
    prepare: async (f) => {
      const orderId = await placed(f);
      const { expiry } = await f.trigger.read.getOrder([orderId]);
      await f.networkHelpers.time.increaseTo(expiry + 1n);
      await f.setPrice(TIER0_PRICE + 1n);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "OrderExpired",
            [orderId, expiry],
          ),
      };
    },
  },
  {
    label:
      "a price above the next tier and too small an allowance gives PriceAboveTarget",
    reason: FillBlocker.PriceAboveTarget,
    prepare: async (f) => {
      const orderId = await placedAfterTier0(f);
      await f.approve(f.owner, 0n, f.trigger.address);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "PriceAboveTarget",
            [BETWEEN, TIER1_PRICE],
          ),
      };
    },
  },
];

describe("LedgerTrigger canFill and fillOrder on Ladder orders: one reason at a time", () => {
  it("None: canFill reports the Ladder order fillable, before tier 0 and again before tier 1, and the executor's fills go through", async () => {
    const f = await setUpFills();
    const orderId = await placed(f);

    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    const first = await f.fill(orderId);
    assert.equal(first.event.args.usdcAmount, TIER0_AMOUNT);

    await f.setPrice(TIER1_PRICE);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    const second = await f.fill(orderId);
    assert.equal(second.event.args.usdcAmount, TIER1_AMOUNT);
  });

  for (const { label, reason, prepare } of ONE_REASON) {
    it(`${label}: canFill reports it and fillOrder reverts with the matching error`, async () => {
      const f = await setUpFills();
      const { orderId, rejects } = await prepare(f);

      await assertBothSay(f, orderId, reason, rejects);
    });
  }
});

describe("LedgerTrigger canFill and fillOrder on Ladder orders: several reasons at once give the first", () => {
  for (const { label, reason, prepare } of TWO_REASONS) {
    it(`${label}, on both sides`, async () => {
      const f = await setUpFills();
      const { orderId, rejects } = await prepare(f);

      await assertBothSay(f, orderId, reason, rejects);
    });
  }
});
