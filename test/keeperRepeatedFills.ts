import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeErrorResult,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

import { Action } from "../keeper/log.ts";
import { OrderStatus } from "../keeper/names.ts";
import { roundHasError } from "../keeper/runOnce.ts";
import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { ONE_DAY } from "./setUpFills.ts";
import { setUpKeeper } from "./setUpKeeper.ts";

// The keeper's second pass: it fills Open and PartiallyFilled orders, and
// fills one order again and again in the same round until canFill says no or
// the most fills of one round are done. The price feed starts at 2000 USD.
// The default Dca order buys 100 USDC's worth of ETH once a day for three
// days at no more than 2000 USD; the default Ladder order buys 100 USDC at
// 2000 USD, then 150 USDC at 1900 USD, then 200 USDC at 1800 USD. Each test
// starts a new chain that holds only the orders it places.

/** The time stamp every line of a test round carries. */
const AT = "1970-01-01T00:00:00.000Z";

/** A skip by status that a partly filled order must never get. */
const OLD_SKIP = "reason=PartiallyFilled check=statusOf";

type Keeper = Awaited<ReturnType<typeof setUpKeeper>>;

/** The OrderFilled events of `orderId` so far, in the order they happened. */
async function fillsOf(k: Keeper, orderId: bigint) {
  return (await k.filledEvents()).filter(
    (event) => event.args.orderId === orderId,
  );
}

/** The fill line of the `index`-th OrderFilled event of `orderId`. */
async function filledLine(k: Keeper, orderId: bigint, index: number) {
  const event = (await fillsOf(k, orderId))[index];
  assert.ok(event, `fill ${index + 1} of order ${orderId} happened`);
  return `${AT} order=${orderId} action=filled reason=transaction-succeeded tx=${event.transactionHash}`;
}

describe("keeper round: orders filled more than once", () => {
  it("fills a three-period Dca order once in a period, logs PeriodAlreadyFilled from canFill for the same period, and fills it again in the next period", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.placeDca();
    const seen: string[] = [];

    const first = await k.round();
    seen.push(...first.lines);
    assert.deepEqual(first.lines.slice(1), [
      await filledLine(k, orderId, 0),
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);
    assert.equal(
      await k.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );

    const second = await k.round();
    seen.push(...second.lines);
    assert.deepEqual(second.lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=PeriodAlreadyFilled check=canFill`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);

    await k.networkHelpers.time.increase(ONE_DAY);
    await k.setPrice(await k.price());
    const third = await k.round();
    seen.push(...third.lines);
    assert.deepEqual(third.lines.slice(1), [
      await filledLine(k, orderId, 1),
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);

    const fills = await fillsOf(k, orderId);
    assert.deepEqual(
      fills.map((event) => event.args.fillNumber),
      [1n, 2n],
    );
    assert.equal(
      await k.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );
    assert.ok(
      seen.every((line) => !line.includes(OLD_SKIP)),
      seen.join("\n"),
    );
  });

  it("logs NotStarted from canFill for a Dca order whose start time is still ahead", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.placeDca({
      startAt: (await k.now()) + ONE_DAY,
    });
    const nonceBefore = await k.keeperNonce();

    const { lines } = await k.round();

    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=NotStarted check=canFill`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore);
  });

  it("fills tier 0 of a three-tier Ladder order at a price that reaches tier 0 only, and tier 1 in a later round at the price of tier 1", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeLadder();
    const seen: string[] = [];

    const first = await k.round();
    seen.push(...first.lines);
    assert.deepEqual(first.lines.slice(1), [
      await filledLine(k, orderId, 0),
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);
    assert.equal(
      await k.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );

    await k.setPrice(input.tiers[1]?.price ?? 0n);
    const second = await k.round();
    seen.push(...second.lines);
    assert.deepEqual(second.lines.slice(1), [
      await filledLine(k, orderId, 1),
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);

    const fills = await fillsOf(k, orderId);
    assert.deepEqual(
      fills.map((event) => [event.args.fillNumber, event.args.usdcAmount]),
      [
        [1n, input.tiers[0]?.usdcAmount],
        [2n, input.tiers[1]?.usdcAmount],
      ],
    );
    assert.equal(
      await k.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );
    assert.ok(
      seen.every((line) => !line.includes(OLD_SKIP)),
      seen.join("\n"),
    );
  });
});

describe("keeper round: one order filled again and again in one round", () => {
  it("fills all three tiers of a Ladder order in one round, one transaction per tier and in order, when the price is below every tier", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeLadder();
    await k.setPrice(usd(1_700n));
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round();

    const fills = await fillsOf(k, orderId);
    assert.deepEqual(
      fills.map((event) => [
        event.args.fillNumber,
        event.args.usdcAmount,
        event.args.filledBy,
      ]),
      input.tiers.map((tier, index) => [
        BigInt(index + 1),
        tier.usdcAmount,
        getAddress(k.keeper.account.address),
      ]),
    );
    assert.deepEqual(
      report.orders.map((entry) => entry.action),
      [Action.Fill, Action.Fill, Action.Fill],
    );
    assert.deepEqual(lines.slice(1), [
      await filledLine(k, orderId, 0),
      await filledLine(k, orderId, 1),
      await filledLine(k, orderId, 2),
      `${AT} order=- action=round-end reason=done activated=0 filled=3 skipped=0 errors=0`,
    ]);
    assert.ok(lines.every((line) => !line.includes("fill-limit-reached")));
    assert.equal(await k.keeperNonce(), nonceBefore + 3);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
    assert.equal(roundHasError(report), false);
  });
});

describe("keeper round: the most fills of one order in one round", () => {
  it("with a limit of 2 fills two tiers and logs fill-limit-reached; the next round, with the default limit, fills the last tier without that line", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.placeLadder();
    await k.setPrice(usd(1_700n));
    const nonceBefore = await k.keeperNonce();

    const limited = await k.round({ maxFillsPerOrderPerRound: 2 });

    assert.deepEqual(limited.lines.slice(1), [
      await filledLine(k, orderId, 0),
      await filledLine(k, orderId, 1),
      `${AT} order=${orderId} action=skip reason=fill-limit-reached limit=2`,
      `${AT} order=- action=round-end reason=done activated=0 filled=2 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore + 2);
    assert.equal((await k.trigger.read.getOrder([orderId])).fillsDone, 2n);
    assert.equal(
      await k.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );

    const unlimited = await k.round();

    assert.deepEqual(unlimited.lines.slice(1), [
      await filledLine(k, orderId, 2),
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
  });

  it("with a limit of 1 fills a Limit order once and writes no fill-limit-reached line, because canFill already says no", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.place();

    const { lines } = await k.round({ maxFillsPerOrderPerRound: 1 });

    assert.deepEqual(lines.slice(1), [
      await filledLine(k, orderId, 0),
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
  });
});

describe("keeper round: no extra line when a filled order cannot be filled again", () => {
  it("writes only the fill for each of two Ladder orders that canFill stops after one fill, one by the price and one by the allowance; the next round names both reasons", async () => {
    const k = await setUpKeeper();
    const byPrice = await k.placeLadder();
    const byAllowance = await k.placeLadder(
      {
        tiers: [
          { price: usd(2_100n), usdcAmount: 10n * ONE_USDC },
          { price: usd(2_000n), usdcAmount: 15n * ONE_USDC },
          { price: usd(1_900n), usdcAmount: 20n * ONE_USDC },
        ],
      },
      k.otherOwner,
    );
    await k.approve(k.otherOwner, 10n * ONE_USDC, k.trigger.address);
    await k.setPrice(usd(1_950n));

    const first = await k.round();

    assert.deepEqual(
      first.report.orders.map((entry) => [entry.orderId, entry.action]),
      [
        [byPrice.orderId, Action.Fill],
        [byAllowance.orderId, Action.Fill],
      ],
    );
    assert.deepEqual(first.lines.slice(1), [
      await filledLine(k, byPrice.orderId, 0),
      await filledLine(k, byAllowance.orderId, 0),
      `${AT} order=- action=round-end reason=done activated=0 filled=2 skipped=0 errors=0`,
    ]);

    const second = await k.round();

    assert.deepEqual(second.lines.slice(1), [
      `${AT} order=${byPrice.orderId} action=skip reason=PriceAboveTarget check=canFill`,
      `${AT} order=${byAllowance.orderId} action=skip reason=InsufficientAllowance check=canFill`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=2 errors=0`,
    ]);
  });
});

describe("keeper round: a failure in the middle of repeated fills", () => {
  it("stops after the first tier when simulating the second fill reverts, logging the contract error by name at step simulate", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.placeLadder();
    await k.setPrice(usd(1_700n));
    const selector = toFunctionSelector("fillOrder(uint256)");
    const revertData = encodeErrorResult({
      abi: k.trigger.abi,
      errorName: "OrderNotOpen",
      args: [orderId, OrderStatus.PartiallyFilled],
    });
    let simulatedFills = 0;
    const watched = k.publicClientThrough(async (args, forward) => {
      const [call] = (args.params ?? []) as { to?: Address; data?: Hex }[];
      if (
        args.method === "eth_call" &&
        call?.to?.toLowerCase() === k.trigger.address.toLowerCase() &&
        call.data?.startsWith(selector) === true
      ) {
        simulatedFills += 1;
        if (simulatedFills === 2) {
          throw Object.assign(new Error("execution reverted"), {
            code: 3,
            data: revertData,
          });
        }
      }
      return forward();
    });
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round({}, { publicClient: watched });

    assert.equal(simulatedFills, 2);
    assert.deepEqual(lines.slice(1), [
      await filledLine(k, orderId, 0),
      `${AT} order=${orderId} action=skip reason=OrderNotOpen step=simulate`,
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore + 1);
    assert.equal((await k.trigger.read.getOrder([orderId])).fillsDone, 1n);
    assert.equal(roundHasError(report), false);
  });
});
