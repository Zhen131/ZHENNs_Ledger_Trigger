import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, getContractAddress, type Address } from "viem";

import { DEFAULT_LIMITS, ONE_USDC } from "./deployLedgerTrigger.ts";
import {
  FillBlocker,
  ONE_ETH,
  Status,
  minEthOut,
  setUpFills,
  type Receipts,
  type Trigger,
} from "./setUpFills.ts";

// A fill that is undone leaves no receipt behind, and a fill whose receipt
// cannot be issued is undone as a whole. Neither LedgerTrigger nor its
// receipt contract keeps any USDC or ETH.

/** Values of ShortChangingSwapVenue's Mode, in declaration order. */
const PAY_GIVEN_AMOUNT = 0;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/** The order's stored status, fill count and USDC left to spend. */
async function orderState(on: Trigger, orderId: bigint) {
  const order = await on.read.getOrder([orderId]);
  return {
    status: order.status,
    fillsDone: order.fillsDone,
    usdcRemaining: order.usdcRemaining,
  };
}

/** Checks that receipt `tokenId` of `of` does not exist. */
async function assertNoReceipt(f: Fixture, of: Receipts, tokenId: bigint) {
  await f.viem.assertions.revertWithCustomErrorWithArgs(
    of.read.ownerOf([tokenId]),
    of,
    "ERC721NonexistentToken",
    [tokenId],
  );
}

describe("LedgerTrigger receipts: an undone fill leaves no receipt (S60)", () => {
  it("S60 a fill undone at the swap, or when the recipient refuses the ETH, issues no receipt and leaves the order as it was; the next fill that goes through gets the next receipt ID", async () => {
    const f = await setUpFills();
    const cheat = await f.viem.deployContract("ShortChangingSwapVenue", [
      f.usdc.address,
    ]);
    await f.mined(
      await f.deployer.sendTransaction({
        to: cheat.address,
        value: 10n * ONE_ETH,
      }),
    );
    const cheated = await f.deployTrigger({ swapVenue: cheat.address });
    const receipts = await f.fillReceiptOf(cheated);
    assert.notEqual(
      getAddress(receipts.address),
      getAddress(f.fillReceipt.address),
    );
    await f.approve(f.owner, 1_000n * ONE_USDC, cheated.address);
    const { orderId, input } = await f.place({}, f.owner, cheated);
    const m = minEthOut(
      input.usdcAmount,
      input.targetPrice,
      await f.price(),
      DEFAULT_LIMITS.maxSlippageBps,
    );
    const owner = f.owner.account.address;
    const stateBefore = await orderState(cheated, orderId);

    await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m - 1n]));
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, cheated),
      cheated,
      "InsufficientEthOut",
      [m - 1n, m],
    );

    assert.equal(await receipts.read.balanceOf([owner]), 0n);
    await assertNoReceipt(f, receipts, 1n);
    assert.deepEqual(await orderState(cheated, orderId), stateBefore);
    assert.equal(stateBefore.status, Status.Open);

    await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m]));
    const { receipt } = await f.fill(orderId, f.executor, cheated);
    const issued = f
      .receiptLogsIn(receipt, receipts)
      .flatMap((log) =>
        log.eventName === "ReceiptIssued" ? [log.args.tokenId] : [],
      );
    assert.deepEqual(issued, [1n]);
    assert.equal(await receipts.read.ownerOf([1n]), getAddress(owner));

    const refuser = await f.viem.deployContract("EthRejectingRecipient");
    const refused = await f.place(
      { recipient: refuser.address },
      f.owner,
      cheated,
    );
    const refusedBefore = await orderState(cheated, refused.orderId);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(refused.orderId, f.executor, cheated),
      cheated,
      "EthTransferFailed",
      [getAddress(refuser.address), m],
    );

    assert.equal(await receipts.read.balanceOf([owner]), 1n);
    await assertNoReceipt(f, receipts, 2n);
    assert.deepEqual(await orderState(cheated, refused.orderId), refusedBefore);
  });
});

describe("LedgerTrigger receipts: a receipt that cannot be issued", () => {
  it("a LedgerTrigger bound to a receipt contract that refuses every receipt reports the order fillable, but the fill reverts with that contract's own error and nothing changes: not the order, not the open total, not one balance", async () => {
    const f = await setUpFills();
    const nonce = await f.publicClient.getTransactionCount({
      address: f.deployer.account.address,
      blockTag: "pending",
    });
    const refusing = await f.viem.deployContract("RefusingFillReceipt", [
      getContractAddress({
        from: f.deployer.account.address,
        nonce: BigInt(nonce) + 1n,
      }),
    ]);
    const bound = await f.deployTrigger({ receipt: refusing.address });
    assert.equal(await bound.read.receipt(), getAddress(refusing.address));
    await f.approve(f.owner, 1_000n * ONE_USDC, bound.address);
    const { orderId } = await f.place({}, f.owner, bound);

    const holders: Address[] = [
      f.owner.account.address,
      f.recipient.account.address,
      bound.address,
      refusing.address,
      f.venue.address,
    ];
    const balancesBefore = await Promise.all(holders.map(f.balancesOf));
    const stateBefore = await orderState(bound, orderId);
    const bookBefore = await f.bookOf(f.owner, bound);

    assert.deepEqual(await f.canFill(orderId, f.stranger, bound), {
      fillable: true,
      reason: FillBlocker.None,
    });
    await f.viem.assertions.revertWithCustomError(
      f.sendFill(orderId, f.executor, bound),
      refusing,
      "ReceiptRefused",
    );

    assert.deepEqual(await orderState(bound, orderId), stateBefore);
    assert.deepEqual(await f.bookOf(f.owner, bound), bookBefore);
    assert.deepEqual(
      await Promise.all(holders.map(f.balancesOf)),
      balancesBefore,
    );
  });
});

describe("LedgerTrigger receipts: no money kept", () => {
  it("over a Limit fill, a Dca fill and a Ladder fill, LedgerTrigger's and the receipt contract's USDC and ETH stay as they were, the receipt contract's at zero", async () => {
    const f = await setUpFills();
    const limit = await f.place();
    const dca = await f.placeDca();
    const ladder = await f.placeLadder();
    const zero = { eth: 0n, usdc: 0n };

    for (const orderId of [limit.orderId, dca.orderId, ladder.orderId]) {
      const triggerBefore = await f.balancesOf(f.trigger.address);
      assert.deepEqual(await f.balancesOf(f.fillReceipt.address), zero);

      await f.fill(orderId);

      assert.deepEqual(await f.balancesOf(f.trigger.address), triggerBefore);
      assert.deepEqual(await f.balancesOf(f.fillReceipt.address), zero);
    }
    assert.equal(
      await f.fillReceipt.read.balanceOf([f.owner.account.address]),
      3n,
    );
  });
});
