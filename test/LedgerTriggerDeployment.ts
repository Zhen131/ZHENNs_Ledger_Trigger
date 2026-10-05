import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, zeroAddress } from "viem";

import {
  DEFAULT_LIMITS,
  ONE_USDC,
  deployLedgerTrigger,
  usd,
} from "./deployLedgerTrigger.ts";

const MAX_UINT256 = 2n ** 256n - 1n;

describe("LedgerTrigger deployment: rejected parameters", () => {
  for (const [label, parameter, error] of [
    ["the USDC address", "usdc", "ZeroUsdc"],
    ["the price feed address", "priceFeed", "ZeroPriceFeed"],
    ["the swap venue address", "swapVenue", "ZeroSwapVenue"],
  ] as const) {
    it(`refuses to deploy when ${label} is the zero address`, async () => {
      const { viem, trigger, deployTrigger } = await deployLedgerTrigger();

      await viem.assertions.revertWithCustomError(
        deployTrigger({ [parameter]: zeroAddress }).then(
          (deployed) => deployed.address,
        ),
        trigger,
        error,
      );
    });
  }

  it("refuses to deploy when all three addresses are zero, naming the USDC address first", async () => {
    const { viem, trigger, deployTrigger } = await deployLedgerTrigger();

    await viem.assertions.revertWithCustomError(
      deployTrigger({
        usdc: zeroAddress,
        priceFeed: zeroAddress,
        swapVenue: zeroAddress,
      }).then((deployed) => deployed.address),
      trigger,
      "ZeroUsdc",
    );
  });

  for (const [parameter, error] of [
    ["maxOrderAmount", "ZeroMaxOrderAmount"],
    ["maxOpenOrdersPerOwner", "ZeroMaxOpenOrdersPerOwner"],
    ["maxPriceAge", "ZeroMaxPriceAge"],
  ] as const) {
    it(`refuses to deploy when ${parameter} is zero`, async () => {
      const { viem, trigger, deployTrigger } = await deployLedgerTrigger();

      await viem.assertions.revertWithCustomError(
        deployTrigger({ [parameter]: 0n }).then((deployed) => deployed.address),
        trigger,
        error,
      );
    });
  }

  for (const [label, slippage] of [
    ["10000 basis points (exactly 100 %)", 10_000n],
    ["10001 basis points", 10_001n],
    ["the largest uint256", MAX_UINT256],
  ] as const) {
    it(`refuses to deploy with a slippage of ${label}`, async () => {
      const { viem, trigger, deployTrigger } = await deployLedgerTrigger();

      await viem.assertions.revertWithCustomErrorWithArgs(
        deployTrigger({ maxSlippageBps: slippage }).then(
          (deployed) => deployed.address,
        ),
        trigger,
        "SlippageTooHigh",
        [slippage],
      );
    });
  }
});

describe("LedgerTrigger deployment: accepted parameters", () => {
  it("stores the seven parameters exactly as given", async () => {
    const { usdc, feed, venue, deployTrigger } = await deployLedgerTrigger();
    const given = {
      usdc: getAddress(usdc.address),
      priceFeed: getAddress(feed.address),
      swapVenue: getAddress(venue.address),
      maxOrderAmount: 123n * ONE_USDC + 456n,
      maxOpenOrdersPerOwner: 3n,
      maxPriceAge: 600n,
      maxSlippageBps: 250n,
    };

    const deployed = await deployTrigger(given);

    assert.deepEqual(
      {
        usdc: await deployed.read.usdc(),
        priceFeed: await deployed.read.priceFeed(),
        swapVenue: await deployed.read.swapVenue(),
        maxOrderAmount: await deployed.read.maxOrderAmount(),
        maxOpenOrdersPerOwner: await deployed.read.maxOpenOrdersPerOwner(),
        maxPriceAge: await deployed.read.maxPriceAge(),
        maxSlippageBps: await deployed.read.maxSlippageBps(),
      },
      given,
    );
  });

  it("deploys with the default limits: 500 USDC, 5 open orders, 75 minutes, 1 %", async () => {
    const { trigger, usdc, feed, venue } = await deployLedgerTrigger();

    assert.equal(await trigger.read.usdc(), getAddress(usdc.address));
    assert.equal(await trigger.read.priceFeed(), getAddress(feed.address));
    assert.equal(await trigger.read.swapVenue(), getAddress(venue.address));
    assert.equal(await trigger.read.maxOrderAmount(), 500_000_000n);
    assert.equal(await trigger.read.maxOpenOrdersPerOwner(), 5n);
    assert.equal(await trigger.read.maxPriceAge(), 4_500n);
    assert.equal(await trigger.read.maxSlippageBps(), 100n);
    assert.deepEqual(DEFAULT_LIMITS, {
      maxOrderAmount: 500_000_000n,
      maxOpenOrdersPerOwner: 5n,
      maxPriceAge: 4_500n,
      maxSlippageBps: 100n,
    });
  });

  for (const slippage of [0n, 9_999n]) {
    it(`deploys with a slippage of ${slippage} basis points`, async () => {
      const { deployTrigger } = await deployLedgerTrigger();

      const deployed = await deployTrigger({ maxSlippageBps: slippage });

      assert.equal(await deployed.read.maxSlippageBps(), slippage);
    });
  }

  it("deploys with the smallest non-zero limits", async () => {
    const { deployTrigger } = await deployLedgerTrigger();

    const deployed = await deployTrigger({
      maxOrderAmount: 1n,
      maxOpenOrdersPerOwner: 1n,
      maxPriceAge: 1n,
    });

    assert.equal(await deployed.read.maxOrderAmount(), 1n);
    assert.equal(await deployed.read.maxOpenOrdersPerOwner(), 1n);
    assert.equal(await deployed.read.maxPriceAge(), 1n);
  });
});

describe("LedgerTrigger deployment: decimals are read, not assumed", () => {
  it("stores the decimals the token and the feed report (6 and 8)", async () => {
    const { trigger, usdc, feed } = await deployLedgerTrigger();

    assert.equal(await trigger.read.usdcDecimals(), await usdc.read.decimals());
    assert.equal(
      await trigger.read.priceDecimals(),
      await feed.read.decimals(),
    );
    assert.equal(await trigger.read.usdcDecimals(), 6);
    assert.equal(await trigger.read.priceDecimals(), 8);
  });

  for (const feedDecimals of [18, 0]) {
    it(`stores the decimals of a feed with ${feedDecimals} decimals`, async () => {
      const { trigger } = await deployLedgerTrigger({
        feedDecimals,
        initialPrice: usd(2_000n, feedDecimals),
      });

      assert.equal(await trigger.read.priceDecimals(), feedDecimals);
      assert.equal(await trigger.read.usdcDecimals(), 6);
    });
  }
});
