import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import userConfig from "../hardhat.config.ts";
import {
  deploySettingsFrom,
  deployWithExternalParts,
  deployWithMocks,
  externalAddressesFrom,
  formatDeployment,
  formatPartsCheck,
  mockSettingsFrom,
} from "../scripts/deploy.ts";
import { ScriptError } from "../scripts/scriptError.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { setUpScripts } from "./setUpScripts.ts";

// Every deployment here runs on a brand-new in-process chain. Expected
// numbers are worked out in this file from the inputs, never read from the
// scripts.

const ONE_USDC = 1_000_000n;
const ONE_ETH = 10n ** 18n;

/** An address with nothing deployed at it. */
function emptyAddress() {
  return privateKeyToAccount(generatePrivateKey()).address;
}

describe("deployment settings from the environment", () => {
  it("takes the defaults when nothing is set: 500 USDC, 5 orders, 4500 seconds, 100 basis points, no fee", () => {
    assert.deepEqual(deploySettingsFrom({}), {
      maxOrderUsdc: "500",
      maxOpenOrders: 5n,
      maxPriceAgeSeconds: 4_500n,
      maxSlippageBps: 100n,
      venueFeeBps: 0n,
    });
    assert.deepEqual(mockSettingsFrom({}), {
      mockPriceUsd: "2000",
      mockVenueEth: "10",
      mockDeployerUsdc: "1000",
    });
  });

  it("takes every value that is set", () => {
    assert.deepEqual(
      deploySettingsFrom({
        [VARIABLES.maxOrderUsdc]: "250.5",
        [VARIABLES.maxOpenOrders]: "3",
        [VARIABLES.maxPriceAgeSeconds]: "3600",
        [VARIABLES.maxSlippageBps]: "0",
        [VARIABLES.venueFeeBps]: "30",
      }),
      {
        maxOrderUsdc: "250.5",
        maxOpenOrders: 3n,
        maxPriceAgeSeconds: 3_600n,
        maxSlippageBps: 0n,
        venueFeeBps: 30n,
      },
    );
  });

  for (const [name, value] of [
    [VARIABLES.maxOrderUsdc, "-5"],
    [VARIABLES.maxOrderUsdc, "1e3"],
    [VARIABLES.maxOpenOrders, "0"],
    [VARIABLES.maxOpenOrders, "2.5"],
    [VARIABLES.maxPriceAgeSeconds, "75m"],
    [VARIABLES.maxSlippageBps, "-1"],
    [VARIABLES.venueFeeBps, "abc"],
  ] as const) {
    it(`rejects ${name}=${value}, naming the variable`, () => {
      assert.throws(
        () => deploySettingsFrom({ [name]: value }),
        (error) =>
          error instanceof ScriptError && error.message.startsWith(name),
      );
    });
  }

  it("requires both external addresses and names the one that is missing or malformed", () => {
    const usdc = emptyAddress();
    assert.throws(
      () => externalAddressesFrom({ [VARIABLES.usdcAddress]: usdc }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(VARIABLES.priceFeedAddress),
    );
    assert.throws(
      () =>
        externalAddressesFrom({
          [VARIABLES.usdcAddress]: "0x1234",
          [VARIABLES.priceFeedAddress]: usdc,
        }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(VARIABLES.usdcAddress),
    );
  });
});

describe("deployment with mock parts", () => {
  it("deploys four contracts, stocks the venue, and reads back exactly the default parameters", async () => {
    const s = await setUpScripts();

    const report = await deployWithMocks({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({}),
      mocks: mockSettingsFrom({}),
    });

    const p = report.parameters;
    for (const address of [p.usdc, p.priceFeed, p.swapVenue, report.trigger]) {
      const code = await s.publicClient.getCode({ address });
      assert.ok(code !== undefined && code !== "0x");
    }
    assert.deepEqual(report.deployedNow, [
      "MockUSDC",
      "MockPriceFeed",
      "MockSwapVenue",
      "LedgerTrigger",
    ]);
    assert.equal(p.maxOrderAmount, 500n * ONE_USDC);
    assert.equal(p.maxOpenOrdersPerOwner, 5n);
    assert.equal(p.maxPriceAge, 75n * 60n);
    assert.equal(p.maxSlippageBps, 100n);
    assert.equal(report.venueFeeBps, 0n);
    assert.equal(
      await s.publicClient.getBalance({ address: p.swapVenue }),
      10n * ONE_ETH,
    );
    assert.equal(report.venueEth, 10n * ONE_ETH);
    assert.equal(report.latestPrice, 2_000n * 10n ** 8n);
    assert.equal(report.chainId, 31_337);
    const usdc = await s.viem.getContractAt("MockUSDC", p.usdc);
    assert.equal(
      await usdc.read.balanceOf([s.owner.account.address]),
      1_000n * ONE_USDC,
    );
    assert.equal(report.deployerUsdc, 1_000n * ONE_USDC);
  });

  it("reports parameters equal to what the chain holds, and the block that holds the deployment", async () => {
    const s = await setUpScripts();
    const report = await deployWithMocks({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({
        [VARIABLES.maxOrderUsdc]: "250.5",
        [VARIABLES.maxOpenOrders]: "3",
        [VARIABLES.maxPriceAgeSeconds]: "3600",
        [VARIABLES.maxSlippageBps]: "50",
        [VARIABLES.venueFeeBps]: "30",
      }),
      mocks: mockSettingsFrom({
        [VARIABLES.mockPriceUsd]: "1875.25",
        [VARIABLES.mockVenueEth]: "2.5",
      }),
    });
    const trigger = await s.viem.getContractAt("LedgerTrigger", report.trigger);
    const venue = await s.viem.getContractAt(
      "MockSwapVenue",
      report.parameters.swapVenue,
    );

    assert.deepEqual(report.parameters, {
      usdc: await trigger.read.usdc(),
      priceFeed: await trigger.read.priceFeed(),
      swapVenue: await trigger.read.swapVenue(),
      maxOrderAmount: await trigger.read.maxOrderAmount(),
      maxOpenOrdersPerOwner: await trigger.read.maxOpenOrdersPerOwner(),
      maxPriceAge: await trigger.read.maxPriceAge(),
      maxSlippageBps: await trigger.read.maxSlippageBps(),
    });
    assert.equal(report.parameters.maxOrderAmount, 250_500_000n);
    assert.equal(report.parameters.maxPriceAge, 3_600n);
    assert.equal(report.parameters.maxSlippageBps, 50n);
    assert.equal(await venue.read.feeBps(), 30n);
    assert.equal(report.latestPrice, 187_525_000_000n);
    assert.equal(report.venueEth, 2_500_000_000_000_000_000n);

    const atBlock = await s.publicClient.getCode({
      address: report.trigger,
      blockNumber: report.triggerBlock,
    });
    const before = await s.publicClient.getCode({
      address: report.trigger,
      blockNumber: report.triggerBlock - 1n,
    });
    assert.ok(atBlock !== undefined && atBlock !== "0x");
    assert.ok(before === undefined || before === "0x");
  });

  it("prints every address, the parameters with their units and the block, and no node URL", async () => {
    const s = await setUpScripts();
    const report = await deployWithMocks({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({}),
      mocks: mockSettingsFrom({}),
    });

    const text = formatDeployment(report).join("\n");

    for (const address of [
      report.parameters.usdc,
      report.parameters.priceFeed,
      report.parameters.swapVenue,
      report.trigger,
    ]) {
      assert.ok(text.includes(address));
    }
    assert.match(
      text,
      /maxOrderAmount +500000000 \(smallest USDC units; 500 USDC, as USDC has 6 decimals\)/,
    );
    assert.match(text, /maxOpenOrdersPerOwner +5 \(orders\)/);
    assert.match(text, /maxPriceAge +4500 \(seconds; 75 minutes\)/);
    assert.match(text, /maxSlippageBps +100 \(basis points; 1 %\)/);
    assert.match(
      text,
      new RegExp(
        `deployed in block ${report.triggerBlock}: use it as KEEPER_FROM_BLOCK`,
      ),
    );
    assert.doesNotMatch(text, /https?:\/\/|localhost|127\.0\.0\.1/);
  });

  it("refuses to deploy when a default is replaced by a value with more decimals than USDC has, before deploying LedgerTrigger", async () => {
    const s = await setUpScripts();
    await assert.rejects(
      deployWithMocks({
        viem: s.viem,
        confirmation: undefined,
        settings: deploySettingsFrom({ [VARIABLES.maxOrderUsdc]: "1.1234567" }),
        mocks: mockSettingsFrom({}),
      }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(VARIABLES.maxOrderUsdc),
    );
  });
});

describe("deployment with external parts", () => {
  it("deploys only the swap venue and LedgerTrigger, which uses exactly the two given addresses", async () => {
    const s = await setUpScripts();
    const usdc = await s.viem.deployContract("MockUSDC");
    const feed = await s.viem.deployContract("MockPriceFeed", [
      8,
      2_412n * 10n ** 8n,
    ]);
    const blockBefore = await s.blockNumber();

    const { check, report } = await deployWithExternalParts({
      viem: s.viem,
      confirmation: undefined,
      settings: deploySettingsFrom({}),
      usdc: usdc.address,
      priceFeed: feed.address,
    });

    // One block per transaction: the venue and LedgerTrigger, nothing else.
    assert.equal(await s.blockNumber(), blockBefore + 2n);
    assert.deepEqual(report.deployedNow, ["MockSwapVenue", "LedgerTrigger"]);
    const trigger = await s.viem.getContractAt("LedgerTrigger", report.trigger);
    assert.equal(await trigger.read.usdc(), getAddress(usdc.address));
    assert.equal(await trigger.read.priceFeed(), getAddress(feed.address));
    const venue = await s.viem.getContractAt(
      "MockSwapVenue",
      await trigger.read.swapVenue(),
    );
    assert.equal(await venue.read.usdc(), getAddress(usdc.address));
    assert.equal(await venue.read.priceFeed(), getAddress(feed.address));
    assert.equal(report.venueEth, 0n);
    assert.deepEqual(
      { ...check, updatedAt: 0n },
      {
        usdcDecimals: 6,
        feedDecimals: 8,
        latestPrice: 241_200_000_000n,
        updatedAt: 0n,
      },
    );
    const printed = formatPartsCheck(usdc.address, feed.address, check).join(
      "\n",
    );
    assert.match(printed, /6 decimals/);
    assert.match(printed, /8 decimals, latest price 2412 USD/);
  });

  it("tells the caller what the check found before anything is sent", async () => {
    const s = await setUpScripts();
    const usdc = await s.viem.deployContract("MockUSDC");
    const feed = await s.viem.deployContract("MockPriceFeed", [8, 1n]);
    const blockBefore = await s.blockNumber();
    const seen: unknown[] = [];

    // A callback that throws stops the run: if it ran after a deployment had
    // been sent, the block number would have moved.
    await assert.rejects(
      deployWithExternalParts({
        viem: s.viem,
        confirmation: undefined,
        settings: deploySettingsFrom({}),
        usdc: usdc.address,
        priceFeed: feed.address,
        onChecked: (check) => {
          seen.push(check);
          throw new ScriptError("stop here");
        },
      }),
      /stop here/,
    );

    assert.equal(seen.length, 1);
    assert.equal(await s.blockNumber(), blockBefore);
  });

  for (const which of ["USDC", "price feed"] as const) {
    it(`sends nothing and names ${which === "USDC" ? VARIABLES.usdcAddress : VARIABLES.priceFeedAddress} and its address when nothing is deployed at the ${which} address`, async () => {
      const s = await setUpScripts();
      const usdc = await s.viem.deployContract("MockUSDC");
      const feed = await s.viem.deployContract("MockPriceFeed", [8, 1n]);
      const empty = emptyAddress();
      const variable =
        which === "USDC" ? VARIABLES.usdcAddress : VARIABLES.priceFeedAddress;
      const blockBefore = await s.blockNumber();

      await assert.rejects(
        deployWithExternalParts({
          viem: s.viem,
          confirmation: undefined,
          settings: deploySettingsFrom({}),
          usdc: which === "USDC" ? empty : usdc.address,
          priceFeed: which === "USDC" ? feed.address : empty,
        }),
        (error) =>
          error instanceof ScriptError &&
          error.message.startsWith(
            `${variable} (${empty}) holds no contract code`,
          ) &&
          error.message.includes("Nothing was sent"),
      );
      assert.equal(await s.blockNumber(), blockBefore);
    });
  }

  it("sends nothing when the USDC address holds a contract that is not a token, or the feed address one that is not a feed", async () => {
    const s = await setUpScripts();
    const { usdc, feed, trigger } = await s.withParts();
    const blockBefore = await s.blockNumber();

    await assert.rejects(
      deployWithExternalParts({
        viem: s.viem,
        confirmation: undefined,
        settings: deploySettingsFrom({}),
        usdc: trigger.address,
        priceFeed: feed.address,
      }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(`${VARIABLES.usdcAddress} (`) &&
        error.message.includes("like a token"),
    );
    await assert.rejects(
      deployWithExternalParts({
        viem: s.viem,
        confirmation: undefined,
        settings: deploySettingsFrom({}),
        usdc: usdc.address,
        priceFeed: usdc.address,
      }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(`${VARIABLES.priceFeedAddress} (`) &&
        error.message.includes("like a price feed"),
    );
    assert.equal(await s.blockNumber(), blockBefore);
  });
});

describe("the sepolia network in the Hardhat configuration", () => {
  it("names configuration variables for the node URL and the private key and holds no value, with Sepolia's chain ID", () => {
    const sepolia = userConfig.networks?.sepolia;
    assert.ok(sepolia !== undefined && sepolia.type === "http");
    assert.equal(sepolia.chainId, 11_155_111);
    assert.deepEqual(sepolia.url, {
      _type: "ConfigurationVariable",
      name: "TRIGGER_SEPOLIA_RPC_URL",
      format: "{variable}",
    });
    assert.deepEqual(sepolia.accounts, [
      {
        _type: "ConfigurationVariable",
        name: "TRIGGER_SEPOLIA_PRIVATE_KEY",
        format: "{variable}",
      },
    ]);
  });

  it("is the only network the configuration adds", () => {
    assert.deepEqual(Object.keys(userConfig.networks ?? {}), ["sepolia"]);
  });
});
