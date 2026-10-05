import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { Action } from "../keeper/log.ts";
import { blockRanges, findOrders } from "../keeper/findOrders.ts";
import { FillBlocker, OrderStatus, fillBlockerName } from "../keeper/names.ts";
import { roundHasError } from "../keeper/runOnce.ts";
import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { venueEthOut } from "./setUpFills.ts";
import { setUpKeeper } from "./setUpKeeper.ts";

describe("keeper round: an order of its own, before and at the target price", () => {
  it("sends nothing while the price is above the target and logs PriceAboveTarget; after the price drops to the target, the next round fills the order and the ETH goes to the recipient", async () => {
    const k = await setUpKeeper();
    const target = usd(1_900n);
    const { orderId, input } = await k.place({ targetPrice: target });
    const nonceBefore = await k.keeperNonce();

    const first = await k.round();

    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Open);
    const priceReason = fillBlockerName(FillBlocker.PriceAboveTarget);
    assert.equal(priceReason, "PriceAboveTarget");
    assert.deepEqual(first.report.orders, [
      {
        orderId,
        action: Action.Skip,
        reason: priceReason,
        details: [["check", "canFill"]],
      },
    ]);
    assert.ok(
      first.lines.includes(
        `1970-01-01T00:00:00.000Z order=${orderId} action=skip reason=PriceAboveTarget check=canFill`,
      ),
      first.lines.join("\n"),
    );
    assert.equal(roundHasError(first.report), false);

    await k.setPrice(target);
    const recipientBefore = await k.balancesOf(input.recipient);
    const second = await k.round();

    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
    const recipientAfter = await k.balancesOf(input.recipient);
    assert.equal(
      recipientAfter.eth - recipientBefore.eth,
      venueEthOut(input.usdcAmount, target),
    );
    const [event, ...others] = await k.filledEvents();
    assert.equal(others.length, 0);
    assert.ok(event);
    assert.equal(event.args.orderId, orderId);
    assert.equal(event.args.filledBy, getAddress(k.keeper.account.address));
    assert.deepEqual(second.report.orders, [
      {
        orderId,
        action: Action.Fill,
        reason: "transaction-succeeded",
        details: [["tx", event.transactionHash]],
      },
    ]);
    assert.ok(
      second.lines.includes(
        `1970-01-01T00:00:00.000Z order=${orderId} action=filled reason=transaction-succeeded tx=${event.transactionHash}`,
      ),
    );
    assert.equal(await k.keeperNonce(), nonceBefore + 1);
    assert.equal(roundHasError(second.report), false);
  });

  it("logs the start of the round with the blocks read and the orders found, and the end with the counts", async () => {
    const k = await setUpKeeper();
    await k.place();
    await k.place({ targetPrice: usd(1_000n) });
    const latest = await k.publicClient.getBlockNumber();

    const { lines } = await k.round();

    assert.equal(lines.length, 4);
    assert.equal(
      lines[0],
      `1970-01-01T00:00:00.000Z order=- action=round-start reason=orders-found from-block=0 to-block=${latest} orders=2`,
    );
    assert.equal(
      lines[3],
      "1970-01-01T00:00:00.000Z order=- action=round-end reason=done filled=1 skipped=1 errors=0",
    );
  });
});

describe("keeper round: only orders that name the keeper as executor", () => {
  it("leaves alone an order at its target price that names another executor", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.place({
      executor: k.stranger.account.address,
    });
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round();

    assert.deepEqual(report.orders, []);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Open);
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.ok(lines.every((line) => !line.includes(`order=${orderId} `)));
  });

  it("fills its own order and still leaves the other executor's order alone", async () => {
    const k = await setUpKeeper();
    const others = await k.place({ executor: k.stranger.account.address });
    const own = await k.place();

    const { report } = await k.round();

    assert.deepEqual(
      report.orders.map((entry) => [entry.orderId, entry.action]),
      [[own.orderId, Action.Fill]],
    );
    assert.equal(
      await k.trigger.read.statusOf([others.orderId]),
      OrderStatus.Open,
    );
    assert.equal(
      await k.trigger.read.statusOf([own.orderId]),
      OrderStatus.Filled,
    );
  });
});

describe("keeper round: the fee cap", () => {
  /** Gas times the highest gas price, worked out the way the round does. */
  async function estimatedFee(
    k: Awaited<ReturnType<typeof setUpKeeper>>,
    orderId: bigint,
  ) {
    const gas = await k.publicClient.estimateContractGas({
      address: k.trigger.address,
      abi: k.trigger.abi,
      functionName: "fillOrder",
      args: [orderId],
      account: k.keeper.account,
    });
    const { maxFeePerGas } = await k.publicClient.estimateFeesPerGas();
    return gas * maxFeePerGas;
  }

  it("sends nothing when the estimated fee is above the cap, and logs the estimate and the cap", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.place();
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round({ maxFeeWei: 1n });

    const fee = await estimatedFee(k, orderId);
    assert.ok(fee > 1n);
    assert.deepEqual(report.orders, [
      {
        orderId,
        action: Action.Skip,
        reason: "fee-above-cap",
        details: [
          ["estimated-fee-wei", fee.toString()],
          ["cap-wei", "1"],
        ],
      },
    ]);
    assert.ok(
      lines.includes(
        `1970-01-01T00:00:00.000Z order=${orderId} action=skip reason=fee-above-cap estimated-fee-wei=${fee} cap-wei=1`,
      ),
    );
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Open);
  });

  it("skips when the cap is one wei below the estimated fee, and fills when the cap equals it", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.place();
    const fee = await estimatedFee(k, orderId);

    const below = await k.round({ maxFeeWei: fee - 1n });
    assert.equal(below.report.orders[0]?.reason, "fee-above-cap");
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Open);

    const equal = await k.round({ maxFeeWei: fee });
    assert.equal(equal.report.orders[0]?.action, Action.Fill);
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
  });
});

describe("keeper round: one order's trouble does not hold up the others", () => {
  it("of two owners' orders, fills the one whose owner gave enough allowance and skips the other with InsufficientAllowance", async () => {
    const k = await setUpKeeper();
    await k.approve(k.otherOwner, 10n * ONE_USDC, k.trigger.address);
    const short = await k.place({}, k.otherOwner);
    const covered = await k.place({}, k.owner);

    const { report, lines } = await k.round();

    assert.deepEqual(
      report.orders.map((entry) => [entry.orderId, entry.action, entry.reason]),
      [
        [short.orderId, Action.Skip, "InsufficientAllowance"],
        [covered.orderId, Action.Fill, "transaction-succeeded"],
      ],
    );
    assert.ok(
      lines.includes(
        `1970-01-01T00:00:00.000Z order=${short.orderId} action=skip reason=InsufficientAllowance check=canFill`,
      ),
    );
    assert.equal(
      await k.trigger.read.statusOf([short.orderId]),
      OrderStatus.Open,
    );
    assert.equal(
      await k.trigger.read.statusOf([covered.orderId]),
      OrderStatus.Filled,
    );
    assert.equal(roundHasError(report), false);
  });

  it("skips an order whose simulated fill reverts, logging the contract error by name, and fills the next one", async () => {
    const k = await setUpKeeper();
    const refuser = await k.viem.deployContract("EthRejectingRecipient");
    const refused = await k.place({ recipient: refuser.address });
    const fine = await k.place();
    const nonceBefore = await k.keeperNonce();

    const { report, lines } = await k.round();

    assert.deepEqual(report.orders[0], {
      orderId: refused.orderId,
      action: Action.Skip,
      reason: "EthTransferFailed",
      details: [["step", "simulate"]],
    });
    assert.ok(
      lines.includes(
        `1970-01-01T00:00:00.000Z order=${refused.orderId} action=skip reason=EthTransferFailed step=simulate`,
      ),
    );
    assert.equal(report.orders[1]?.action, Action.Fill);
    assert.equal(
      await k.trigger.read.statusOf([refused.orderId]),
      OrderStatus.Open,
    );
    assert.equal(
      await k.trigger.read.statusOf([fine.orderId]),
      OrderStatus.Filled,
    );
    assert.equal(await k.keeperNonce(), nonceBefore + 1);
  });
});

describe("keeper round: orders settled before the round", () => {
  it("skips an order the owner filled, one the owner cancelled and one that expired, and sends no transaction", async () => {
    const k = await setUpKeeper();
    const filledByOwner = await k.place();
    const cancelled = await k.place();
    const expiring = await k.place();
    await k.fill(filledByOwner.orderId, k.owner);
    await k.mined(
      await k.trigger.write.cancelOrder([cancelled.orderId], {
        account: k.owner.account,
      }),
    );
    await k.networkHelpers.time.increaseTo(expiring.input.expiry + 1n);
    const nonceBefore = await k.keeperNonce();

    const { report } = await k.round();

    assert.deepEqual(
      report.orders.map((entry) => [entry.orderId, entry.reason]),
      [
        [filledByOwner.orderId, "Filled"],
        [cancelled.orderId, "Cancelled"],
        [expiring.orderId, "Expired"],
      ],
    );
    for (const entry of report.orders) {
      assert.equal(entry.action, Action.Skip);
      assert.deepEqual(entry.details, [["check", "statusOf"]]);
    }
    assert.equal(await k.keeperNonce(), nonceBefore);
    assert.equal(roundHasError(report), false);
  });
});

describe("keeper round: reading the events in pieces", () => {
  it("splits a block span into pieces of at most the given size", () => {
    assert.deepEqual(blockRanges(0n, 9n, 3n), [
      [0n, 2n],
      [3n, 5n],
      [6n, 8n],
      [9n, 9n],
    ]);
    assert.deepEqual(blockRanges(5n, 5n, 100n), [[5n, 5n]]);
    assert.deepEqual(blockRanges(4n, 7n, 1n), [
      [4n, 4n],
      [5n, 5n],
      [6n, 6n],
      [7n, 7n],
    ]);
    assert.deepEqual(blockRanges(8n, 7n, 2n), []);
    assert.throws(() => blockRanges(0n, 1n, 0n), RangeError);
  });

  for (const maxBlockRange of [1n, 2n, 3n]) {
    it(`finds every order that names the keeper, reading at most ${maxBlockRange} block(s) per request, with other executors' orders in between`, async () => {
      const k = await setUpKeeper();
      const own: bigint[] = [];
      for (let i = 0; i < 4; i += 1) {
        own.push((await k.place()).orderId);
        await k.place({ executor: k.stranger.account.address }, k.otherOwner);
        await k.networkHelpers.mine(i + 1);
      }
      const requested: string[] = [];
      const watched = k.publicClientThrough(async (args, forward) => {
        if (args.method === "eth_getLogs") {
          const [filter] = args.params as [
            { fromBlock: string; toBlock: string },
          ];
          requested.push(
            `${BigInt(filter.fromBlock)}-${BigInt(filter.toBlock)}`,
          );
        }
        return forward();
      });
      const toBlock = await k.publicClient.getBlockNumber();

      const found = await findOrders({
        publicClient: watched,
        abi: k.abis.trigger,
        contractAddress: k.trigger.address,
        executor: k.keeper.account.address,
        fromBlock: 0n,
        toBlock,
        maxBlockRange,
      });

      assert.deepEqual(found, own);
      assert.deepEqual(
        requested,
        blockRanges(0n, toBlock, maxBlockRange).map(([a, b]) => `${a}-${b}`),
      );

      const { report } = await k.round(
        { maxBlockRange },
        { publicClient: watched },
      );
      assert.deepEqual(
        report.orders.map((entry) => [entry.orderId, entry.action]),
        own.map((orderId) => [orderId, Action.Fill]),
      );
    });
  }

  it("does not look at blocks before the configured first block", async () => {
    const k = await setUpKeeper();
    const early = await k.place();
    const fromBlock = (await k.publicClient.getBlockNumber()) + 1n;
    const late = await k.place();

    const { report } = await k.round({ fromBlock, maxBlockRange: 1n });

    assert.deepEqual(
      report.orders.map((entry) => entry.orderId),
      [late.orderId],
    );
    assert.equal(
      await k.trigger.read.statusOf([early.orderId]),
      OrderStatus.Open,
    );
  });
});
