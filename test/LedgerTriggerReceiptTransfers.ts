import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeFunctionData, getAddress, zeroAddress } from "viem";

import { setUpFills } from "./setUpFills.ts";

// A receipt stays with the owner it was issued to: every way of moving it, or
// of approving someone else to move it, is refused. `approve` and
// `setApprovalForAll` are pure functions, which viem only offers as reads;
// they are sent here as real transactions, with their call data encoded from
// the ABI.

describe("LedgerTrigger receipts: no transfer, no approval (S57)", () => {
  it("S57 refuses every transfer and approval of a receipt with ReceiptNotTransferable: transferFrom, both safeTransferFrom, a stranger's transferFrom, approve of it and of a receipt that does not exist, and setApprovalForAll either way, which names 0; the receipt stays where it was", async () => {
    const f = await setUpFills();
    const { owner, stranger, fillReceipt } = f;
    const { orderId } = await f.place();
    await f.fill(orderId);
    const from = owner.account.address;
    const to = stranger.account.address;

    for (const [label, send] of [
      [
        "transferFrom",
        () =>
          fillReceipt.write.transferFrom([from, to, 1n], {
            account: owner.account,
          }),
      ],
      [
        "safeTransferFrom",
        () =>
          fillReceipt.write.safeTransferFrom([from, to, 1n], {
            account: owner.account,
          }),
      ],
      [
        "safeTransferFrom with data",
        () =>
          fillReceipt.write.safeTransferFrom([from, to, 1n, "0x1234"], {
            account: owner.account,
          }),
      ],
      [
        "a stranger's transferFrom",
        () =>
          fillReceipt.write.transferFrom([from, to, 1n], {
            account: stranger.account,
          }),
      ],
    ] as const) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        send(),
        fillReceipt,
        "ReceiptNotTransferable",
        [1n],
      );
      assert.equal(
        await fillReceipt.read.ownerOf([1n]),
        getAddress(from),
        label,
      );
    }

    for (const [args, tokenId] of [
      [[to, 1n], 1n],
      [[to, 2n], 2n],
    ] as const) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        owner.sendTransaction({
          to: fillReceipt.address,
          data: encodeFunctionData({
            abi: fillReceipt.abi,
            functionName: "approve",
            args,
          }),
        }),
        fillReceipt,
        "ReceiptNotTransferable",
        [tokenId],
      );
    }
    for (const approved of [true, false]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        owner.sendTransaction({
          to: fillReceipt.address,
          data: encodeFunctionData({
            abi: fillReceipt.abi,
            functionName: "setApprovalForAll",
            args: [to, approved],
          }),
        }),
        fillReceipt,
        "ReceiptNotTransferable",
        [0n],
      );
    }

    assert.equal(await fillReceipt.read.ownerOf([1n]), getAddress(from));
    assert.equal(await fillReceipt.read.balanceOf([from]), 1n);
    assert.equal(await fillReceipt.read.balanceOf([to]), 0n);
    assert.equal(await fillReceipt.read.getApproved([1n]), zeroAddress);
    assert.equal(await fillReceipt.read.isApprovedForAll([from, to]), false);
  });

  it("S57 a transfer to the zero address is refused first by OpenZeppelin with ERC721InvalidReceiver, and a transfer of a receipt that does not exist with ERC721NonexistentToken, which makes no receipt", async () => {
    const f = await setUpFills();
    const { owner, stranger, fillReceipt } = f;
    const { orderId } = await f.place();
    await f.fill(orderId);
    const from = owner.account.address;

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      fillReceipt.write.transferFrom([from, zeroAddress, 1n], {
        account: owner.account,
      }),
      fillReceipt,
      "ERC721InvalidReceiver",
      [zeroAddress],
    );
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      fillReceipt.write.transferFrom([from, stranger.account.address, 2n], {
        account: owner.account,
      }),
      fillReceipt,
      "ERC721NonexistentToken",
      [2n],
    );

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      fillReceipt.read.ownerOf([2n]),
      fillReceipt,
      "ERC721NonexistentToken",
      [2n],
    );
    assert.equal(
      await fillReceipt.read.balanceOf([stranger.account.address]),
      0n,
    );
    assert.equal(await fillReceipt.read.ownerOf([1n]), getAddress(from));
    assert.equal(await fillReceipt.read.balanceOf([from]), 1n);
    assert.equal(await fillReceipt.read.getApproved([1n]), zeroAddress);
  });
});
