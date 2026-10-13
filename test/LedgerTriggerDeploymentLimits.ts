import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { ONE_USDC, deployLedgerTrigger } from "./deployLedgerTrigger.ts";

// The two deployment parameters that bound later kinds of order:
// maxPeriodsPerOrder and maxTiersPerOrder. Like the other limits they are
// fixed at deployment, readable by anyone and must be above zero.

describe("LedgerTrigger deployment: the period and tier limits", () => {
  for (const [parameter, error] of [
    ["maxPeriodsPerOrder", "ZeroMaxPeriodsPerOrder"],
    ["maxTiersPerOrder", "ZeroMaxTiersPerOrder"],
  ] as const) {
    it(`refuses to deploy when ${parameter} is zero, with ${error}`, async () => {
      const { viem, trigger, deployTrigger } = await deployLedgerTrigger();

      await viem.assertions.revertWithCustomError(
        deployTrigger({ [parameter]: 0n }).then((deployed) => deployed.address),
        trigger,
        error,
      );
    });
  }

  it("checks the two limits after the slippage and before reading any decimals, the period limit first", async () => {
    const { viem, trigger, stranger, deployTrigger } =
      await deployLedgerTrigger();
    const noCode = stranger.account.address;

    await viem.assertions.revertWithCustomErrorWithArgs(
      deployTrigger({
        maxSlippageBps: 10_000n,
        maxPeriodsPerOrder: 0n,
        maxTiersPerOrder: 0n,
      }).then((deployed) => deployed.address),
      trigger,
      "SlippageTooHigh",
      [10_000n],
    );
    await viem.assertions.revertWithCustomError(
      deployTrigger({ maxPeriodsPerOrder: 0n, maxTiersPerOrder: 0n }).then(
        (deployed) => deployed.address,
      ),
      trigger,
      "ZeroMaxPeriodsPerOrder",
    );
    await viem.assertions.revertWithCustomError(
      deployTrigger({ maxPeriodsPerOrder: 0n, priceFeed: noCode }).then(
        (deployed) => deployed.address,
      ),
      trigger,
      "ZeroMaxPeriodsPerOrder",
    );
    await viem.assertions.revertWithCustomError(
      deployTrigger({ maxTiersPerOrder: 0n, usdc: noCode }).then(
        (deployed) => deployed.address,
      ),
      trigger,
      "ZeroMaxTiersPerOrder",
    );
  });

  it("stores all nine parameters exactly as given, none of them a default", async () => {
    const { viem, usdc, feed, deployTrigger } = await deployLedgerTrigger();
    const otherVenue = await viem.deployContract("MockSwapVenue", [
      usdc.address,
      feed.address,
      25n,
    ]);
    const given = {
      usdc: getAddress(usdc.address),
      priceFeed: getAddress(feed.address),
      swapVenue: getAddress(otherVenue.address),
      maxOrderAmount: 77n * ONE_USDC + 1n,
      maxOpenOrdersPerOwner: 9n,
      maxPriceAge: 1_234n,
      maxSlippageBps: 42n,
      maxPeriodsPerOrder: 104n,
      maxTiersPerOrder: 3n,
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
        maxPeriodsPerOrder: await deployed.read.maxPeriodsPerOrder(),
        maxTiersPerOrder: await deployed.read.maxTiersPerOrder(),
      },
      given,
    );
  });

  it("deploys by default with 52 periods and 5 tiers per order", async () => {
    const { trigger } = await deployLedgerTrigger();

    assert.equal(await trigger.read.maxPeriodsPerOrder(), 52n);
    assert.equal(await trigger.read.maxTiersPerOrder(), 5n);
  });

  it("deploys with one period and one tier per order, the smallest values allowed", async () => {
    const { deployTrigger } = await deployLedgerTrigger();

    const deployed = await deployTrigger({
      maxPeriodsPerOrder: 1n,
      maxTiersPerOrder: 1n,
    });

    assert.equal(await deployed.read.maxPeriodsPerOrder(), 1n);
    assert.equal(await deployed.read.maxTiersPerOrder(), 1n);
  });
});
