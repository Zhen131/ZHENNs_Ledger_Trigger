import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Hash } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  FillBlocker,
  ONE_DAY,
  Status,
  setUpFills,
  type DcaInput,
} from "./setUpFills.ts";

// canFill and fillOrder run the same checks in the same order on a
// time-scheduled (Dca) order too: whatever canFill reports, fillOrder rejects
// with the matching error, and once canFill reports None the executor's fill
// goes through. The price feed starts at 2000 USD; the default Dca order buys
// 100 USDC's worth of ETH once a day for three days, at no more than
// 2000 USD, starting in the block that places it.

const MAX_PRICE_AGE = DEFAULT_LIMITS.maxPriceAge;
const CAP = usd(2_000n);
const PER_PERIOD = 100n * ONE_USDC;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;
type Reason = (typeof FillBlocker)[keyof typeof FillBlocker];

/** One way to make a Dca order unfillable, and what each side then says. */
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

/** Places a Dca order with the default input changed by `changes`. */
async function placed(f: Fixture, changes: Partial<DcaInput> = {}) {
  return (await f.placeDca(changes)).orderId;
}

/** Takes the owner's whole USDC balance away, to the stranger. */
async function emptyOwner(f: Fixture) {
  const balance = (await f.balancesOf(f.owner.account.address)).usdc;
  await f.mined(
    await f.usdc.write.transfer([f.stranger.account.address, balance], {
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
    label: "NotOpen for a Dca order that is filled",
    reason: FillBlocker.NotOpen,
    prepare: async (f) => {
      const orderId = await placed(f, { periodCount: 1n });
      await f.fill(orderId);
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
    label: "NotOpen for a Dca order that is cancelled",
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
      const orderId = await placed(f);
      const { expiry } = await f.trigger.read.getOrder([orderId]);
      await f.networkHelpers.time.increaseTo(expiry + 1n);
      await f.setPrice(CAP);
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
    label: "NotStarted",
    reason: FillBlocker.NotStarted,
    prepare: async (f) => {
      const startAt = (await f.now()) + ONE_DAY;
      const orderId = await placed(f, { startAt });
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "NotStarted",
            [orderId, startAt],
          ),
      };
    },
  },
  {
    label: "PeriodAlreadyFilled",
    reason: FillBlocker.PeriodAlreadyFilled,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.fill(orderId);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "PeriodAlreadyFilled",
            [orderId, 0n],
          ),
      };
    },
  },
  {
    label: "InvalidPrice",
    reason: FillBlocker.InvalidPrice,
    prepare: async (f) => {
      const orderId = await placed(f);
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
      const orderId = await placed(f);
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
    label: "PriceAboveTarget",
    reason: FillBlocker.PriceAboveTarget,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.setPrice(CAP + 1n);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "PriceAboveTarget",
            [CAP + 1n, CAP],
          ),
      };
    },
  },
  {
    label: "InsufficientAllowance",
    reason: FillBlocker.InsufficientAllowance,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.approve(f.owner, PER_PERIOD - 1n, f.trigger.address);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "InsufficientAllowance",
            [PER_PERIOD - 1n, PER_PERIOD],
          ),
      };
    },
  },
  {
    label: "InsufficientBalance",
    reason: FillBlocker.InsufficientBalance,
    prepare: async (f) => {
      const orderId = await placed(f);
      await emptyOwner(f);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "InsufficientBalance",
            [0n, PER_PERIOD],
          ),
      };
    },
  },
];

const TWO_REASONS: readonly Case[] = [
  {
    label: "dormant and not started gives Dormant",
    reason: FillBlocker.Dormant,
    prepare: async (f) => {
      const orderId = await placed(f, {
        activationPrice: usd(2_200n),
        startAt: (await f.now()) + ONE_DAY,
      });
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
    label: "not started and a price above the cap gives NotStarted",
    reason: FillBlocker.NotStarted,
    prepare: async (f) => {
      const startAt = (await f.now()) + ONE_DAY;
      const orderId = await placed(f, { startAt });
      await f.setPrice(CAP + 1n);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "NotStarted",
            [orderId, startAt],
          ),
      };
    },
  },
  {
    label:
      "the period bought already and too small an allowance gives PeriodAlreadyFilled",
    reason: FillBlocker.PeriodAlreadyFilled,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.fill(orderId);
      await f.approve(f.owner, 0n, f.trigger.address);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "PeriodAlreadyFilled",
            [orderId, 0n],
          ),
      };
    },
  },
  {
    label:
      "a price above the cap and too small an allowance gives PriceAboveTarget",
    reason: FillBlocker.PriceAboveTarget,
    prepare: async (f) => {
      const orderId = await placed(f);
      await f.setPrice(CAP + 1n);
      await f.approve(f.owner, 0n, f.trigger.address);
      return {
        orderId,
        rejects: (fill) =>
          f.viem.assertions.revertWithCustomErrorWithArgs(
            fill,
            f.trigger,
            "PriceAboveTarget",
            [CAP + 1n, CAP],
          ),
      };
    },
  },
];

describe("LedgerTrigger canFill and fillOrder on Dca orders: one reason at a time", () => {
  it("None: canFill reports the Dca order fillable and the executor's fill goes through", async () => {
    const f = await setUpFills();
    const orderId = await placed(f);

    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    const { event } = await f.fill(orderId);
    assert.equal(event.args.usdcAmount, PER_PERIOD);
  });

  for (const { label, reason, prepare } of ONE_REASON) {
    it(`${label}: canFill reports it and fillOrder reverts with the matching error`, async () => {
      const f = await setUpFills();
      const { orderId, rejects } = await prepare(f);

      await assertBothSay(f, orderId, reason, rejects);
    });
  }
});

describe("LedgerTrigger canFill and fillOrder on Dca orders: several reasons at once give the first", () => {
  for (const { label, reason, prepare } of TWO_REASONS) {
    it(`${label}, on both sides`, async () => {
      const f = await setUpFills();
      const { orderId, rejects } = await prepare(f);

      await assertBothSay(f, orderId, reason, rejects);
    });
  }
});
