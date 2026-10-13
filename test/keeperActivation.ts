import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeErrorResult,
  getAddress,
  parseEventLogs,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

import { Action } from "../keeper/log.ts";
import { OrderStatus } from "../keeper/names.ts";
import { roundHasError } from "../keeper/runOnce.ts";
import { DEFAULT_LIMITS, usd } from "./deployLedgerTrigger.ts";
import { setUpKeeper } from "./setUpKeeper.ts";

// The keeper's first pass: it reads each order's status once and activates
// the Dormant ones that can be activated now, before it fills anything. The
// price feed starts at 2000 USD; the default dormant order spends 100 USDC at
// a target of 2000 USD and wakes up at 2200 USD. Each test starts a new chain
// that holds only the orders it places.

/** The time stamp every line of a test round carries. */
const AT = "1970-01-01T00:00:00.000Z";

type Keeper = Awaited<ReturnType<typeof setUpKeeper>>;

/** Every OrderActivated event of the main LedgerTrigger so far. */
async function activatedEvents(k: Keeper) {
  const logs = await k.publicClient.getLogs({
    address: k.trigger.address,
    fromBlock: 0n,
  });
  return parseEventLogs({
    abi: k.trigger.abi,
    logs,
    eventName: "OrderActivated",
  });
}

/**
 * Gas times the highest gas price for activating `orderId`, worked out the way
 * the round does.
 */
async function activationFee(k: Keeper, orderId: bigint) {
  const gas = await k.publicClient.estimateContractGas({
    address: k.trigger.address,
    abi: k.trigger.abi,
    functionName: "activateOrder",
    args: [orderId],
    account: k.keeper.account,
  });
  const { maxFeePerGas } = await k.publicClient.estimateFeesPerGas();
  return gas * maxFeePerGas;
}

/** The status stored for `orderId`, which never reads Expired. */
async function storedStatus(k: Keeper, orderId: bigint) {
  return (await k.trigger.read.getOrder([orderId])).status;
}

describe("keeper round: activating a dormant order", () => {
  it("logs PriceBelowActivation from canActivate and sends nothing below the activation price; at the activation price it activates the order and then reports PriceAboveTarget from canFill in the same round; at the target price it fills it", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDormant();
    const nonceBefore = await k.keeperNonce();

    const first = await k.round();

    assert.deepEqual(first.report.orders, [
      {
        orderId,
        action: Action.Skip,
        reason: "PriceBelowActivation",
        details: [["check", "canActivate"]],
      },
    ]);
    assert.deepEqual(first.lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=PriceBelowActivation check=canActivate`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Dormant);

    await k.setPrice(input.activationPrice);
    const second = await k.round();

    const [activated, ...moreActivations] = await activatedEvents(k);
    assert.equal(moreActivations.length, 0);
    assert.ok(activated);
    assert.equal(activated.args.orderId, orderId);
    assert.equal(
      activated.args.activatedBy,
      getAddress(k.keeper.account.address),
    );
    assert.equal(activated.args.price, input.activationPrice);
    assert.deepEqual(second.report.orders, [
      {
        orderId,
        action: Action.Activate,
        reason: "transaction-succeeded",
        details: [["tx", activated.transactionHash]],
      },
      {
        orderId,
        action: Action.Skip,
        reason: "PriceAboveTarget",
        details: [["check", "canFill"]],
      },
    ]);
    assert.deepEqual(second.lines.slice(1), [
      `${AT} order=${orderId} action=activated reason=transaction-succeeded tx=${activated.transactionHash}`,
      `${AT} order=${orderId} action=skip reason=PriceAboveTarget check=canFill`,
      `${AT} order=- action=round-end reason=done activated=1 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Open);
    assert.equal(await k.keeperNonce(), nonceBefore + 1);
    assert.equal(roundHasError(second.report), false);

    await k.setPrice(input.targetPrice);
    const third = await k.round();

    const [filled, ...moreFills] = await k.filledEvents();
    assert.equal(moreFills.length, 0);
    assert.ok(filled);
    assert.deepEqual(third.lines.slice(1), [
      `${AT} order=${orderId} action=filled reason=transaction-succeeded tx=${filled.transactionHash}`,
      `${AT} order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0`,
    ]);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
    assert.equal(await k.keeperNonce(), nonceBefore + 2);
  });
});

describe("keeper round: a dormant order that cannot be activated only gets a line", () => {
  it("a stale price: logs StalePrice from canActivate, sends nothing and leaves the order Dormant", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDormant();
    await k.setPrice(input.activationPrice);
    await k.networkHelpers.time.increase(DEFAULT_LIMITS.maxPriceAge + 60n);
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round();

    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=StalePrice check=canActivate`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Dormant);
    assert.equal(roundHasError(report), false);
  });

  it("a zero price: logs InvalidPrice from canActivate, sends nothing and leaves the order Dormant", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.placeDormant();
    await k.setPrice(0n);
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round();

    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=InvalidPrice check=canActivate`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Dormant);
    assert.equal(roundHasError(report), false);
  });

  it("an expired dormant order: no line in the first pass, Expired from statusOf in the second, nothing sent, the stored status still Dormant", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDormant();
    await k.setPrice(input.activationPrice);
    await k.networkHelpers.time.increaseTo(input.expiry + 1n);
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round();

    assert.deepEqual(report.orders, [
      {
        orderId,
        action: Action.Skip,
        reason: "Expired",
        details: [["check", "statusOf"]],
      },
    ]);
    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=Expired check=statusOf`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Expired);
    assert.equal(await storedStatus(k, orderId), OrderStatus.Dormant);
    assert.equal(roundHasError(report), false);
  });
});

describe("keeper round: an activation that fails before it is sent", () => {
  it("logs the contract error by name at step activate-simulate when simulating activateOrder reverts, sends nothing, and gives the order no line in the second pass", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDormant();
    await k.setPrice(input.activationPrice);
    const selector = toFunctionSelector("activateOrder(uint256)");
    const revertData = encodeErrorResult({
      abi: k.trigger.abi,
      errorName: "OrderNotDormant",
      args: [orderId, OrderStatus.Open],
    });
    const watched = k.publicClientThrough(async (args, forward) => {
      const [call] = (args.params ?? []) as { to?: Address; data?: Hex }[];
      if (
        args.method === "eth_call" &&
        call?.to?.toLowerCase() === k.trigger.address.toLowerCase() &&
        call.data?.startsWith(selector) === true
      ) {
        throw Object.assign(new Error("execution reverted"), {
          code: 3,
          data: revertData,
        });
      }
      return forward();
    });
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round({}, { publicClient: watched });

    assert.deepEqual(report.orders, [
      {
        orderId,
        action: Action.Skip,
        reason: "OrderNotDormant",
        details: [["step", "activate-simulate"]],
      },
    ]);
    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=skip reason=OrderNotDormant step=activate-simulate`,
      `${AT} order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Dormant);
    assert.equal(roundHasError(report), false);
  });
});

describe("keeper round: the fee cap of an activation", () => {
  it("sends no activation whose estimated fee is above the cap, and logs the step, the estimate and the cap", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDormant();
    await k.setPrice(input.activationPrice);
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round({ maxFeeWei: 1n });

    const fee = await activationFee(k, orderId);
    assert.ok(fee > 1n);
    assert.deepEqual(report.orders, [
      {
        orderId,
        action: Action.Skip,
        reason: "fee-above-cap",
        details: [
          ["step", "activate-estimate"],
          ["estimated-fee-wei", fee.toString()],
          ["cap-wei", "1"],
        ],
      },
    ]);
    assert.ok(
      lines.includes(
        `${AT} order=${orderId} action=skip reason=fee-above-cap step=activate-estimate estimated-fee-wei=${fee} cap-wei=1`,
      ),
      lines.join("\n"),
    );
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Dormant);
  });

  it("checks the activation and the fill against the cap each on its own: with the cap at the activation's estimated fee, a dormant Dca order is activated and its fill is skipped as above the cap", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDca({
      activationPrice: usd(1_900n),
    });
    const price = await k.price();
    assert.ok(input.activationPrice <= price && price <= input.targetPrice);
    const cap = await activationFee(k, orderId);
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round({ maxFeeWei: cap });

    const [activated] = await activatedEvents(k);
    assert.ok(activated);
    const [activation, fill, ...others] = report.orders;
    assert.equal(others.length, 0);
    assert.deepEqual(activation, {
      orderId,
      action: Action.Activate,
      reason: "transaction-succeeded",
      details: [["tx", activated.transactionHash]],
    });
    assert.ok(fill);
    assert.equal(fill.orderId, orderId);
    assert.equal(fill.action, Action.Skip);
    assert.equal(fill.reason, "fee-above-cap");
    assert.deepEqual(
      fill.details.map(([key]) => key),
      ["estimated-fee-wei", "cap-wei"],
    );
    const details = new Map(fill.details);
    const fillFee = details.get("estimated-fee-wei") ?? "";
    assert.equal(details.get("cap-wei"), cap.toString());
    assert.ok(BigInt(fillFee) > cap);
    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=activated reason=transaction-succeeded tx=${activated.transactionHash}`,
      `${AT} order=${orderId} action=skip reason=fee-above-cap estimated-fee-wei=${fillFee} cap-wei=${cap}`,
      `${AT} order=- action=round-end reason=done activated=1 filled=0 skipped=1 errors=0`,
    ]);
    assert.equal(await k.keeperNonce(), nonceBefore + 1);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Open);
  });
});

describe("keeper round: activated and filled in the same round", () => {
  it("activates a dormant Dca order whose activation price is at or below the price and its cap, then fills its first period in the same round", async () => {
    const k = await setUpKeeper();
    const { orderId, input } = await k.placeDca({
      activationPrice: usd(1_900n),
    });
    const price = await k.price();
    assert.ok(input.activationPrice <= price && price <= input.targetPrice);

    const { report, lines } = await k.round();

    const [activated] = await activatedEvents(k);
    const [filled, ...moreFills] = await k.filledEvents();
    assert.ok(activated);
    assert.ok(filled);
    assert.equal(moreFills.length, 0);
    assert.deepEqual(lines.slice(1), [
      `${AT} order=${orderId} action=activated reason=transaction-succeeded tx=${activated.transactionHash}`,
      `${AT} order=${orderId} action=filled reason=transaction-succeeded tx=${filled.transactionHash}`,
      `${AT} order=- action=round-end reason=done activated=1 filled=1 skipped=0 errors=0`,
    ]);
    assert.equal(
      activated.args.activatedBy,
      getAddress(k.keeper.account.address),
    );
    assert.equal(filled.args.orderId, orderId);
    assert.equal(filled.args.filledBy, getAddress(k.keeper.account.address));
    assert.equal(filled.args.fillNumber, 1n);
    assert.equal(
      await k.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );
    assert.equal(roundHasError(report), false);
  });
});

describe("keeper round: every activation before any fill", () => {
  it("activates the dormant order with the higher ID before it fills the open order with the lower ID, then tries the activated one", async () => {
    const k = await setUpKeeper();
    const open = await k.place();
    const dormant = await k.placeDormant({
      targetPrice: usd(1_900n),
      activationPrice: usd(2_000n),
    });
    assert.ok(open.orderId < dormant.orderId);
    assert.equal(await k.price(), usd(2_000n));

    const { report, lines } = await k.round();

    const [activated] = await activatedEvents(k);
    const [filled] = await k.filledEvents();
    assert.ok(activated);
    assert.ok(filled);
    assert.equal(activated.args.orderId, dormant.orderId);
    assert.equal(filled.args.orderId, open.orderId);
    assert.deepEqual(
      report.orders.map((entry) => [entry.orderId, entry.action, entry.reason]),
      [
        [dormant.orderId, Action.Activate, "transaction-succeeded"],
        [open.orderId, Action.Fill, "transaction-succeeded"],
        [dormant.orderId, Action.Skip, "PriceAboveTarget"],
      ],
    );
    assert.deepEqual(lines.slice(1), [
      `${AT} order=${dormant.orderId} action=activated reason=transaction-succeeded tx=${activated.transactionHash}`,
      `${AT} order=${open.orderId} action=filled reason=transaction-succeeded tx=${filled.transactionHash}`,
      `${AT} order=${dormant.orderId} action=skip reason=PriceAboveTarget check=canFill`,
      `${AT} order=- action=round-end reason=done activated=1 filled=1 skipped=1 errors=0`,
    ]);
    assert.equal(
      await k.trigger.read.statusOf([dormant.orderId]),
      OrderStatus.Open,
    );
    assert.equal(
      await k.trigger.read.statusOf([open.orderId]),
      OrderStatus.Filled,
    );
  });
});
