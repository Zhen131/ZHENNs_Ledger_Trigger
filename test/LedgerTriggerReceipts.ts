import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs, zeroAddress } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { Status, setUpFills, type Wallet } from "./setUpFills.ts";

// Every fill issues the order's owner one receipt from the receipt contract
// bound to LedgerTrigger, recording the same values OrderFilled logs and the
// time of the fill's block. The price feed starts at 2000 USD.

type Fixture = Awaited<ReturnType<typeof setUpFills>>;
type Filled = Awaited<ReturnType<Fixture["fill"]>>;

/**
 * Checks the one receipt a fill issued and returns its ID: the receipt
 * contract logged exactly a Transfer from the zero address to the owner and
 * then ReceiptIssued, and the receipt records what OrderFilled logged and the
 * time of the fill's block.
 */
async function assertReceiptOf(f: Fixture, filled: Filled, owner: Wallet) {
  const { event, receipt } = filled;
  const to = getAddress(owner.account.address);
  const logs = f.receiptLogsIn(receipt);
  assert.deepEqual(
    logs.map((log) => log.eventName),
    ["Transfer", "ReceiptIssued"],
  );
  const issued = logs[1];
  if (issued?.eventName !== "ReceiptIssued") throw new Error("no receipt");
  const tokenId = issued.args.tokenId;
  assert.deepEqual(logs[0]?.args, { from: zeroAddress, to, tokenId });
  assert.deepEqual(issued.args, {
    tokenId,
    orderId: event.args.orderId,
    owner: to,
  });

  const block = await f.publicClient.getBlock({
    blockNumber: receipt.blockNumber,
  });
  assert.equal(await f.fillReceipt.read.ownerOf([tokenId]), to);
  assert.deepEqual(await f.fillReceipt.read.receiptOf([tokenId]), {
    orderId: event.args.orderId,
    fillNumber: event.args.fillNumber,
    usdcIn: event.args.usdcAmount,
    ethOut: event.args.ethReceived,
    price: event.args.price,
    filledAt: block.timestamp,
  });
  return tokenId;
}

/** The receipt balances of the owner, the executor and the recipient. */
async function receiptBalances(f: Fixture) {
  return Promise.all(
    [f.owner, f.executor, f.recipient].map((wallet) =>
      f.fillReceipt.read.balanceOf([wallet.account.address]),
    ),
  );
}

describe("LedgerTrigger receipts: one receipt for each fill (S56)", () => {
  it("S56 a Limit order filled by the executor gets its owner, not the executor or the recipient, one receipt recording the fill, logged after the last USDC log and before OrderFilled", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    assert.notEqual(input.recipient, f.owner.account.address);

    const filled = await f.fill(orderId);

    assert.deepEqual(await receiptBalances(f), [1n, 0n, 0n]);
    const tokenId = await assertReceiptOf(f, filled, f.owner);
    assert.equal(tokenId, 1n);
    assert.equal(filled.event.args.fillNumber, 1n);
    assert.equal(filled.event.args.usdcAmount, input.usdcAmount);

    // Where the receipt contract's two logs sit among all of the fill's logs.
    const sources = filled.receipt.logs.map((log) => getAddress(log.address));
    const usdc = getAddress(f.usdc.address);
    const receipts = getAddress(f.fillReceipt.address);
    const trigger = getAddress(f.trigger.address);
    const lastUsdc = sources.lastIndexOf(usdc);
    const first = sources.indexOf(receipts);
    const triggerLogs = parseEventLogs({
      abi: f.trigger.abi,
      logs: filled.receipt.logs.filter(
        (log) => getAddress(log.address) === trigger,
      ),
    });
    assert.deepEqual(
      triggerLogs.map((log) => log.eventName),
      ["OrderFilled"],
    );
    const orderFilled = sources.indexOf(trigger);
    assert.equal(sources.filter((source) => source === receipts).length, 2);
    assert.ok(lastUsdc < first);
    assert.equal(sources[first + 1], receipts);
    assert.equal(orderFilled, first + 2);
    assert.equal(orderFilled, sources.length - 1);
  });

  it("S56 a three-period Dca order bought in full gets three receipts with IDs in a row and fill numbers 1, 2, 3; one that skips a period gets two, with fill numbers 1 and 2, not the period numbers", async () => {
    const f = await setUpFills();
    const all = await f.placeDca();
    const { startAt, periodLength } = await f.scheduleOf(all.orderId);

    const ids: bigint[] = [];
    for (const period of [0n, 1n, 2n]) {
      if (period > 0n) {
        await f.networkHelpers.time.increaseTo(startAt + period * periodLength);
        await f.setPrice(await f.price());
      }
      const filled = await f.fill(all.orderId);
      assert.equal(filled.event.args.fillNumber, period + 1n);
      assert.equal(filled.event.args.usdcAmount, all.input.usdcPerPeriod);
      ids.push(await assertReceiptOf(f, filled, f.owner));
    }
    assert.deepEqual(ids, [1n, 2n, 3n]);
    assert.equal(
      await f.fillReceipt.read.balanceOf([f.owner.account.address]),
      3n,
    );

    const skipping = await f.placeDca();
    const second = await f.scheduleOf(skipping.orderId);
    const first = await f.fill(skipping.orderId);
    await f.networkHelpers.time.increaseTo(
      second.startAt + 2n * second.periodLength,
    );
    await f.setPrice(await f.price());
    const last = await f.fill(skipping.orderId);

    assert.equal(await assertReceiptOf(f, first, f.owner), 4n);
    assert.equal(await assertReceiptOf(f, last, f.owner), 5n);
    assert.deepEqual(
      [
        (await f.fillReceipt.read.receiptOf([4n])).fillNumber,
        (await f.fillReceipt.read.receiptOf([5n])).fillNumber,
      ],
      [1n, 2n],
    );
    assert.equal((await f.scheduleOf(skipping.orderId)).filledThrough, 3n);
    assert.equal(
      await f.fillReceipt.read.balanceOf([f.owner.account.address]),
      5n,
    );
  });

  it("S56 a Ladder order of three tiers of different amounts gets three receipts, each with the amount and the price of its tier and fill numbers 1, 2, 3", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeLadder();

    const receipts = [];
    for (const [index, tier] of input.tiers.entries()) {
      await f.setPrice(tier.price);
      const filled = await f.fill(orderId);
      const tokenId = await assertReceiptOf(f, filled, f.owner);
      receipts.push(await f.fillReceipt.read.receiptOf([tokenId]));
      assert.equal(tokenId, BigInt(index + 1));
    }

    assert.deepEqual(
      receipts.map((r) => [r.fillNumber, r.usdcIn, r.price]),
      [
        [1n, 100n * ONE_USDC, usd(2_000n)],
        [2n, 150n * ONE_USDC, usd(1_900n)],
        [3n, 200n * ONE_USDC, usd(1_800n)],
      ],
    );
    assert.equal(
      (await f.trigger.read.getOrder([orderId])).status,
      Status.Filled,
    );
  });
});

describe("LedgerTrigger receipts: numbering and holders", () => {
  it("receipt IDs run from 1 without a gap across two owners and all four kinds of order; each receipt is held by its order's owner, each owner holds one per fill, and placing, activating and cancelling issue none", async () => {
    const f = await setUpFills();
    const { owner, otherOwner } = f;

    const limit = await f.place();
    const ladder = await f.placeLadder({}, otherOwner);
    const dormant = await f.placeDormant();
    const dca = await f.placeDca({}, otherOwner);
    const cancelled = await f.place();
    await f.mined(
      await f.trigger.write.cancelOrder([cancelled.orderId], {
        account: owner.account,
      }),
    );

    await f.fill(limit.orderId);
    await f.fill(ladder.orderId);
    await f.fill(dca.orderId);
    await f.setPrice(usd(2_200n));
    await f.activate(dormant.orderId);
    await f.setPrice(usd(2_000n));
    await f.fill(dormant.orderId);
    await f.setPrice(usd(1_900n));
    await f.fill(ladder.orderId);
    await f.mined(
      await f.trigger.write.cancelOrder([dca.orderId], {
        account: otherOwner.account,
      }),
    );

    const issued = await f.publicClient.getContractEvents({
      address: f.fillReceipt.address,
      abi: f.fillReceipt.abi,
      eventName: "ReceiptIssued",
      fromBlock: 0n,
    });
    const fills = await f.publicClient.getContractEvents({
      address: f.trigger.address,
      abi: f.trigger.abi,
      eventName: "OrderFilled",
      fromBlock: 0n,
    });
    assert.equal(issued.length, 5);
    assert.equal(fills.length, 5);
    assert.deepEqual(
      issued.map((log) => log.args.tokenId),
      [1n, 2n, 3n, 4n, 5n],
    );

    for (let tokenId = 1n; tokenId <= 5n; tokenId += 1n) {
      const { orderId } = await f.fillReceipt.read.receiptOf([tokenId]);
      assert.equal(
        await f.fillReceipt.read.ownerOf([tokenId]),
        (await f.trigger.read.getOrder([orderId])).owner,
      );
    }
    for (const [wallet, orderIds] of [
      [owner, [limit.orderId, dormant.orderId, cancelled.orderId]],
      [otherOwner, [ladder.orderId, dca.orderId]],
    ] as const) {
      let fillsDone = 0n;
      for (const orderId of orderIds) {
        fillsDone += (await f.trigger.read.getOrder([orderId])).fillsDone;
      }
      assert.equal(
        await f.fillReceipt.read.balanceOf([wallet.account.address]),
        fillsDone,
      );
    }
    assert.equal(
      await f.fillReceipt.read.balanceOf([owner.account.address]),
      2n,
    );
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.fillReceipt.read.ownerOf([6n]),
      f.fillReceipt,
      "ERC721NonexistentToken",
      [6n],
    );

    // Every log of the receipt contract comes from a transaction that filled
    // an order, two per fill.
    const receiptLogs = await f.publicClient.getLogs({
      address: f.fillReceipt.address,
      fromBlock: 0n,
    });
    assert.equal(receiptLogs.length, 10);
    assert.deepEqual(
      new Set(receiptLogs.map((log) => log.transactionHash)),
      new Set(fills.map((log) => log.transactionHash)),
    );
    assert.equal(
      (await f.trigger.read.getOrder([dca.orderId])).status,
      Status.Cancelled,
    );
  });

  it("a receipt is read by anyone; receiptOf, ownerOf and tokenURI refuse ID 0 and the ID after the last with ERC721NonexistentToken, and tokenURI is empty for a receipt that exists", async () => {
    const f = await setUpFills();
    const first = await f.place();
    const second = await f.place();
    await f.fill(first.orderId);
    await f.fill(second.orderId);

    for (const tokenId of [0n, 3n]) {
      for (const read of [
        f.fillReceipt.read.receiptOf([tokenId]),
        f.fillReceipt.read.ownerOf([tokenId]),
        f.fillReceipt.read.tokenURI([tokenId]),
      ]) {
        await f.viem.assertions.revertWithCustomErrorWithArgs(
          read,
          f.fillReceipt,
          "ERC721NonexistentToken",
          [tokenId],
        );
      }
    }
    assert.equal(await f.fillReceipt.read.tokenURI([2n]), "");
    const asStranger = await f.fillReceipt.read.receiptOf([2n], {
      account: f.stranger.account,
    });
    assert.equal(asStranger.orderId, second.orderId);
    assert.equal(asStranger.usdcIn, second.input.usdcAmount);
  });
});
