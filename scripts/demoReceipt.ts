// S56 and S57 of the demo: fill receipts.
//
// S56: the executor fills a limit order; the fill issues the order's owner one
// receipt from FillReceipt, and the receipt holds what the fill's
// `OrderFilled` event says.
//
// S57: the owner tries to transfer that receipt to the stranger; FillReceipt
// refuses, and the owner still holds it.

import { isAddressEqual, parseEventLogs } from "viem";

import type { PlayedRow } from "./demo.ts";
import type { DemoChain } from "./demoChain.ts";

/** The made-up numbers of the limit order, as people write them. */
export const RECEIPT_NUMBERS = {
  orderUsdc: "100",
  targetPriceUsd: "2000",
  validMinutes: 24n * 60n,
} as const;

export async function playReceipt(chain: DemoChain): Promise<PlayedRow[]> {
  const { trigger, receipt, owner, keeper, stranger, publicClient } = chain;
  const ownerAddress = owner.account.address;
  const amount = chain.toUsdc(RECEIPT_NUMBERS.orderUsdc);
  const rows: PlayedRow[] = [];

  // S56: one fill, one receipt.
  const placed = await chain.placeLimit({
    amount,
    targetPrice: chain.toPrice(RECEIPT_NUMBERS.targetPriceUsd),
    validSeconds: RECEIPT_NUMBERS.validMinutes * 60n,
  });
  await chain.approve(amount);
  const price = await chain.feedPrice();
  const before = await chain.status(placed.orderId);
  const receiptsBefore = await receipt.read.balanceOf([ownerAddress]);
  const tried = await chain.tryCall(() =>
    trigger.write.fillOrder([placed.orderId], chain.as(keeper)),
  );
  const after = await chain.status(placed.orderId);
  const receiptsGained =
    (await receipt.read.balanceOf([ownerAddress])) - receiptsBefore;
  const issued = tried.accepted
    ? parseEventLogs({
        abi: receipt.abi,
        logs: tried.receipt.logs.filter((entry) =>
          isAddressEqual(entry.address, receipt.address),
        ),
        eventName: "ReceiptIssued",
      }).map((event) => event.args)
    : [];
  const [filled] = tried.accepted
    ? chain.fillsIn(tried.receipt, placed.orderId)
    : [];
  const tokenId = issued.length === 1 ? issued[0]?.tokenId : undefined;
  const holder =
    tokenId === undefined ? undefined : await receipt.read.ownerOf([tokenId]);

  const gotOne =
    receiptsGained === 1n &&
    issued.length === 1 &&
    issued[0] !== undefined &&
    isAddressEqual(issued[0].owner, ownerAddress) &&
    holder !== undefined &&
    isAddressEqual(holder, ownerAddress);
  let matches = "no receipt to compare";
  const details: string[] = [];
  if (tokenId !== undefined && filled !== undefined && tried.accepted) {
    const data = await receipt.read.receiptOf([tokenId]);
    const block = await publicClient.getBlock({
      blockNumber: tried.receipt.blockNumber,
    });
    const checks: [string, boolean][] = [
      ["orderId", data.orderId === filled.orderId],
      ["fillNumber", data.fillNumber === filled.fillNumber],
      ["usdcIn", data.usdcIn === filled.usdcAmount],
      ["ethOut", data.ethOut === filled.ethReceived],
      ["price", data.price === filled.price],
      ["filledAt", data.filledAt === block.timestamp],
    ];
    const differ = checks.filter(([, same]) => !same).map(([name]) => name);
    matches =
      differ.length === 0
        ? "receipt matches OrderFilled"
        : `receipt differs from OrderFilled in ${differ.join(", ")}`;
    details.push(
      `receipt #${tokenId}: order ${data.orderId}, fill ${data.fillNumber}, ${chain.usdcText(data.usdcIn)} in, ${chain.ethText(data.ethOut)} out, price ${chain.usdText(data.price)}, filled at Unix ${data.filledAt}`,
      `OrderFilled: order ${filled.orderId}, fill ${filled.fillNumber}, ${chain.usdcText(filled.usdcAmount)} in, ${chain.ethText(filled.ethReceived)} out, price ${chain.usdText(filled.price)}; the fill's block time Unix ${block.timestamp}`,
    );
  } else if (filled === undefined) {
    matches = "no OrderFilled to compare";
  }
  rows.push({
    id: "S56",
    did: [
      `placed order #${placed.orderId} (${RECEIPT_NUMBERS.orderUsdc} USDC at a target of ${RECEIPT_NUMBERS.targetPriceUsd} USD, valid for ${RECEIPT_NUMBERS.validMinutes / 60n} hours); the price is ${chain.usdText(price)}`,
      "the executor called fillOrder",
    ],
    actual: [
      `${before} -> ${after}`,
      gotOne
        ? "the owner got one receipt"
        : `the owner's receipts +${receiptsGained}, ReceiptIssued events ${issued.length}, receipt held by ${chain.who(holder)}`,
      matches,
    ],
    details,
  });

  // S57: the owner tries to hand the receipt to the stranger.
  if (tokenId === undefined) {
    rows.push({
      id: "S57",
      did: ["went on with the receipt of S56: there was none"],
      actual: [
        "transfer not tried: no receipt from S56",
        "no receipt to check",
      ],
      details: [],
    });
    return rows;
  }
  const transfer = await chain.tryCall(() =>
    receipt.write.transferFrom(
      [ownerAddress, stranger.account.address, tokenId],
      chain.as(owner),
    ),
  );
  const heldBy = await receipt.read.ownerOf([tokenId]);
  const strangerHolds = await receipt.read.balanceOf([
    stranger.account.address,
  ]);
  rows.push({
    id: "S57",
    did: [
      `went on with receipt #${tokenId} of S56`,
      "the owner called transferFrom on FillReceipt to hand it to the stranger",
    ],
    actual: [
      `transfer ${chain.outcome(transfer)}`,
      isAddressEqual(heldBy, ownerAddress) && strangerHolds === 0n
        ? "receipt still held by the owner"
        : `receipt held by ${chain.who(heldBy)}, the stranger holds ${strangerHolds}`,
    ],
    details: transfer.accepted
      ? []
      : [`${transfer.errorName}(${transfer.values.map(String).join(", ")})`],
  });
  return rows;
}
