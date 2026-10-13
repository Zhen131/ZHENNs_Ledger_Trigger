import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deploySettingsFrom,
  deployWithExternalParts,
  deployWithMocks,
  formatDeployment,
  mockSettingsFrom,
} from "../scripts/deploy.ts";
import { ScriptError } from "../scripts/scriptError.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { setUpScripts } from "./setUpScripts.ts";

// The deployment scripts and the two limits on later kinds of order:
// TRIGGER_MAX_PERIODS_PER_ORDER and TRIGGER_MAX_TIERS_PER_ORDER. Every
// deployment here runs on a brand-new in-process chain.

describe("deployment settings: the period and tier limits", () => {
  it("takes 52 periods and 5 tiers per order when neither variable is set", () => {
    const settings = deploySettingsFrom({});

    assert.equal(settings.maxPeriodsPerOrder, 52n);
    assert.equal(settings.maxTiersPerOrder, 5n);
  });

  it(`takes ${VARIABLES.maxPeriodsPerOrder} and ${VARIABLES.maxTiersPerOrder} when they are set`, () => {
    const settings = deploySettingsFrom({
      [VARIABLES.maxPeriodsPerOrder]: "12",
      [VARIABLES.maxTiersPerOrder]: "1",
    });

    assert.equal(settings.maxPeriodsPerOrder, 12n);
    assert.equal(settings.maxTiersPerOrder, 1n);
    assert.equal(VARIABLES.maxPeriodsPerOrder, "TRIGGER_MAX_PERIODS_PER_ORDER");
    assert.equal(VARIABLES.maxTiersPerOrder, "TRIGGER_MAX_TIERS_PER_ORDER");
  });

  for (const name of [
    VARIABLES.maxPeriodsPerOrder,
    VARIABLES.maxTiersPerOrder,
  ]) {
    for (const value of ["0", "-1", "2.5", "five"]) {
      it(`rejects ${name}=${value}, naming the variable`, () => {
        assert.throws(
          () => deploySettingsFrom({ [name]: value }),
          (error) =>
            error instanceof ScriptError && error.message.startsWith(name),
        );
      });
    }
  }
});

describe("deployment with mock parts: the period and tier limits", () => {
  it("deploys with 52 periods and 5 tiers per order by default, reads both back and prints them", async () => {
    const s = await setUpScripts();

    const report = await deployWithMocks({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({}),
      mocks: mockSettingsFrom({}),
    });

    const trigger = await s.viem.getContractAt("LedgerTrigger", report.trigger);
    assert.equal(report.parameters.maxPeriodsPerOrder, 52n);
    assert.equal(report.parameters.maxTiersPerOrder, 5n);
    assert.equal(await trigger.read.maxPeriodsPerOrder(), 52n);
    assert.equal(await trigger.read.maxTiersPerOrder(), 5n);
    const text = formatDeployment(report).join("\n");
    assert.match(
      text,
      /maxPeriodsPerOrder +52 \(periods per time-scheduled order\)/,
    );
    assert.match(text, /maxTiersPerOrder +5 \(tiers per tiered order\)/);
  });

  it("deploys with the values of the two variables, reads both back and prints them", async () => {
    const s = await setUpScripts();

    const report = await deployWithMocks({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({
        [VARIABLES.maxPeriodsPerOrder]: "26",
        [VARIABLES.maxTiersPerOrder]: "3",
      }),
      mocks: mockSettingsFrom({}),
    });

    const trigger = await s.viem.getContractAt("LedgerTrigger", report.trigger);
    assert.equal(await trigger.read.maxPeriodsPerOrder(), 26n);
    assert.equal(await trigger.read.maxTiersPerOrder(), 3n);
    assert.equal(report.parameters.maxPeriodsPerOrder, 26n);
    assert.equal(report.parameters.maxTiersPerOrder, 3n);
    const text = formatDeployment(report).join("\n");
    assert.match(text, /maxPeriodsPerOrder +26 /);
    assert.match(text, /maxTiersPerOrder +3 /);
  });

  for (const name of [
    VARIABLES.maxPeriodsPerOrder,
    VARIABLES.maxTiersPerOrder,
  ]) {
    it(`stops before sending any transaction when ${name} is 0, naming the variable`, async () => {
      const s = await setUpScripts();
      const blockBefore = await s.blockNumber();

      await assert.rejects(
        async () =>
          deployWithMocks({
            viem: s.viem,
            confirmation: undefined,
            settings: deploySettingsFrom({ [name]: "0" }),
            mocks: mockSettingsFrom({}),
          }),
        (error) =>
          error instanceof ScriptError && error.message.startsWith(name),
      );

      assert.equal(await s.blockNumber(), blockBefore);
    });
  }
});

describe("deployment with external parts: the period and tier limits", () => {
  it("deploys LedgerTrigger with the values of the two variables and reads both back", async () => {
    const s = await setUpScripts();
    const usdc = await s.viem.deployContract("MockUSDC");
    const feed = await s.viem.deployContract("MockPriceFeed", [
      8,
      2_000n * 10n ** 8n,
    ]);

    const { report } = await deployWithExternalParts({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({
        [VARIABLES.maxPeriodsPerOrder]: "8",
        [VARIABLES.maxTiersPerOrder]: "2",
      }),
      usdc: usdc.address,
      priceFeed: feed.address,
    });

    const trigger = await s.viem.getContractAt("LedgerTrigger", report.trigger);
    assert.equal(await trigger.read.maxPeriodsPerOrder(), 8n);
    assert.equal(await trigger.read.maxTiersPerOrder(), 2n);
    assert.equal(report.parameters.maxPeriodsPerOrder, 8n);
    assert.equal(report.parameters.maxTiersPerOrder, 2n);
  });
});
