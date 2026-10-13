import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, type Address } from "viem";

import {
  deploySettingsFrom,
  deployWithExternalParts,
  deployWithMocks,
  formatDeployment,
  mockSettingsFrom,
  type DeploymentReport,
} from "../scripts/deploy.ts";
import { setUpScripts } from "./setUpScripts.ts";

// Both deployment modes deploy FillReceipt right before LedgerTrigger, bound
// to the address LedgerTrigger then gets, and read the binding back from the
// chain: LedgerTrigger's `receipt` parameter and FillReceipt's `trigger`.

type Scripts = Awaited<ReturnType<typeof setUpScripts>>;

/** True when `address` holds code at `blockNumber`. */
async function hasCodeAt(s: Scripts, address: Address, blockNumber: bigint) {
  const code = await s.publicClient.getCode({ address, blockNumber });
  return code !== undefined && code !== "0x";
}

/**
 * Checks the binding a deployment report shows against the chain: the
 * receipt contract holds code, LedgerTrigger names it, it names LedgerTrigger,
 * it was deployed in the block right before LedgerTrigger's, and the printout
 * shows it.
 */
async function assertBound(s: Scripts, report: DeploymentReport) {
  const receipt = report.parameters.receipt;
  const trigger = await s.viem.getContractAt("LedgerTrigger", report.trigger);
  const fillReceipt = await s.viem.getContractAt("FillReceipt", receipt);

  assert.equal(await trigger.read.receipt(), getAddress(receipt));
  assert.equal(await fillReceipt.read.trigger(), getAddress(report.trigger));
  assert.equal(getAddress(report.receiptBoundTo), getAddress(report.trigger));
  assert.ok(await hasCodeAt(s, receipt, report.triggerBlock - 1n));
  assert.equal(await hasCodeAt(s, receipt, report.triggerBlock - 2n), false);
  assert.equal(
    await hasCodeAt(s, report.trigger, report.triggerBlock - 1n),
    false,
  );

  const text = formatDeployment(report).join("\n");
  assert.match(
    text,
    new RegExp(`FillReceipt +${receipt} +\\(deployed now; `, "u"),
  );
  assert.match(
    text,
    new RegExp(`\\n {2}receipt +${receipt} \\(the receipt contract\\)`, "u"),
  );
  assert.ok(
    text.includes(
      `FillReceipt, read back from the chain, is bound to ${report.receiptBoundTo}: this LedgerTrigger`,
    ),
  );
}

describe("deployment scripts: the receipt contract", () => {
  it("with mock parts, deploys FillReceipt right before LedgerTrigger, bound to it, and reads back and prints the binding both ways", async () => {
    const s = await setUpScripts();

    const report = await deployWithMocks({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({}),
      mocks: mockSettingsFrom({}),
    });

    assert.deepEqual(report.deployedNow, [
      "MockUSDC",
      "MockPriceFeed",
      "MockSwapVenue",
      "FillReceipt",
      "LedgerTrigger",
    ]);
    await assertBound(s, report);
  });

  it("with external parts, sends exactly three transactions, the swap venue, FillReceipt and LedgerTrigger, and reads back and prints the binding both ways", async () => {
    const s = await setUpScripts();
    const usdc = await s.viem.deployContract("MockUSDC");
    const feed = await s.viem.deployContract("MockPriceFeed", [
      8,
      2_000n * 10n ** 8n,
    ]);
    const blockBefore = await s.blockNumber();
    const nonceBefore = await s.publicClient.getTransactionCount({
      address: s.owner.account.address,
    });

    const { report } = await deployWithExternalParts({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({}),
      usdc: usdc.address,
      priceFeed: feed.address,
    });

    assert.equal(await s.blockNumber(), blockBefore + 3n);
    assert.equal(report.triggerBlock, blockBefore + 3n);
    assert.equal(
      await s.publicClient.getTransactionCount({
        address: s.owner.account.address,
      }),
      nonceBefore + 3,
    );
    assert.deepEqual(report.deployedNow, [
      "MockSwapVenue",
      "FillReceipt",
      "LedgerTrigger",
    ]);
    await assertBound(s, report);
  });
});
