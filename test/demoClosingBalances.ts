import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, isAddressEqual, type Address } from "viem";

import { runDemo } from "../scripts/demo.ts";
import { formatDemo } from "../scripts/demoReport.ts";
import { setUpScripts } from "./setUpScripts.ts";

// What the chain holds once the whole demo has run on a fresh chain, read
// straight from the chain at the addresses the demo printed in its
// `Contracts:` line: the contracts keep no money, the owner holds one receipt
// for each fill LedgerTrigger reported, and the FillReceipt printed is bound
// to the LedgerTrigger printed.

/** The address printed after `name` in the `Contracts:` line. */
function printed(line: string, name: string): Address {
  const match = new RegExp(`\\b${name} (0x[0-9a-fA-F]{40})\\b`).exec(line);
  assert.ok(match?.[1] !== undefined, `no ${name} in: ${line}`);
  return getAddress(match[1]);
}

describe("demo: the chain after the demo", () => {
  it("lists five contracts, leaves no USDC or ETH in the two contracts, gives the owner one receipt per OrderFilled, and binds the printed FillReceipt to the printed LedgerTrigger", async () => {
    const s = await setUpScripts();

    const result = await runDemo({ viem: s.viem, confirmation: undefined });

    const line = formatDemo(result).find((entry) =>
      entry.startsWith("Contracts: "),
    );
    assert.ok(line !== undefined);
    assert.deepEqual(
      [...line.matchAll(/(\w+) 0x[0-9a-fA-F]{40}/g)].map((match) => match[1]),
      [
        "MockUSDC",
        "MockPriceFeed",
        "MockSwapVenue",
        "FillReceipt",
        "LedgerTrigger",
      ],
    );
    const triggerAddress = printed(line, "LedgerTrigger");
    const receiptAddress = printed(line, "FillReceipt");
    const trigger = await s.viem.getContractAt("LedgerTrigger", triggerAddress);
    const receipt = await s.viem.getContractAt("FillReceipt", receiptAddress);
    const usdc = await s.viem.getContractAt(
      "MockUSDC",
      printed(line, "MockUSDC"),
    );

    for (const address of [triggerAddress, receiptAddress]) {
      assert.equal(await usdc.read.balanceOf([address]), 0n);
      assert.equal(await s.publicClient.getBalance({ address }), 0n);
    }

    const fills = await s.publicClient.getContractEvents({
      address: triggerAddress,
      abi: trigger.abi,
      eventName: "OrderFilled",
      fromBlock: 0n,
      toBlock: "latest",
    });
    assert.ok(fills.length > 0);
    for (const fill of fills) {
      const owner = fill.args.owner;
      assert.ok(owner !== undefined);
      assert.ok(isAddressEqual(owner, s.owner.account.address));
    }
    assert.equal(
      await receipt.read.balanceOf([s.owner.account.address]),
      BigInt(fills.length),
    );

    assert.ok(isAddressEqual(await receipt.read.trigger(), triggerAddress));
  });
});
