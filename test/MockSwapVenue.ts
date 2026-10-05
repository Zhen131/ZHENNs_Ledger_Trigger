import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import type { Hash } from "viem";

const ONE_USDC = 1_000_000n; // MockUSDC has 6 decimals.
const USDC_DECIMALS = 6n;
const ONE_ETH = 10n ** 18n;
const BPS = 10_000n;

/** A price with `decimals` decimals, from whole dollars. */
const usd = (dollars: bigint, decimals = 8) =>
  dollars * 10n ** BigInt(decimals);

/**
 * What the venue should pay, worked out here with bigint and without asking
 * the venue: k = 18 + feed decimals - USDC decimals;
 * gross = floor(usdcAmount * 10^k / price);
 * ethOut = floor(gross * (10000 - feeBps) / 10000).
 */
function expectedEthOut(
  usdcAmount: bigint,
  price: bigint,
  feedDecimals: number,
  feeBps: bigint,
): bigint {
  const k = 18n + BigInt(feedDecimals) - USDC_DECIMALS;
  const gross = (usdcAmount * 10n ** k) / price;
  return (gross * (BPS - feeBps)) / BPS;
}

type Setup = {
  readonly feedDecimals?: number;
  readonly price?: bigint;
  readonly feeBps?: bigint;
  /** ETH sent to the venue right after deployment. */
  readonly ethStock?: bigint;
};

// Every test gets a brand-new local chain. Prices are set by the test itself.
async function deployFixture(setup: Setup = {}) {
  const feedDecimals = setup.feedDecimals ?? 8;
  const price = setup.price ?? usd(2_000n, feedDecimals);
  const feeBps = setup.feeBps ?? 0n;
  const ethStock = setup.ethStock ?? 10n * ONE_ETH;

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [stocker, trader, stranger] = await viem.getWalletClients();
  if (stocker === undefined || trader === undefined || stranger === undefined) {
    throw new Error(
      "the local chain must provide at least three test accounts",
    );
  }
  // Closures below use these, since narrowing does not reach into them.
  const traderAccount = trader.account;
  const traderAddress = trader.account.address;
  const usdc = await viem.deployContract("MockUSDC");
  const feed = await viem.deployContract("MockPriceFeed", [
    feedDecimals,
    price,
  ]);
  const venue = await viem.deployContract("MockSwapVenue", [
    usdc.address,
    feed.address,
    feeBps,
  ]);

  async function mined(hash: Hash) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

  if (ethStock > 0n) {
    await mined(
      await stocker.sendTransaction({ to: venue.address, value: ethStock }),
    );
  }

  /** Gives the trader `amount` USDC and approves the venue for `allowance`. */
  async function fundTrader(amount: bigint, allowance: bigint) {
    await mined(await usdc.write.mint([amount], { account: traderAccount }));
    await mined(
      await usdc.write.approve([venue.address, allowance], {
        account: traderAccount,
      }),
    );
  }

  async function snapshot() {
    return {
      traderUsdc: await usdc.read.balanceOf([traderAddress]),
      venueUsdc: await usdc.read.balanceOf([venue.address]),
      traderEth: await publicClient.getBalance({
        address: traderAddress,
      }),
      venueEth: await publicClient.getBalance({ address: venue.address }),
      allowance: await usdc.read.allowance([traderAddress, venue.address]),
    };
  }

  /**
   * Swaps as the trader. Returns the value the call reports and the ETH the
   * trader actually received, with the trader's own gas cost added back.
   */
  async function swap(usdcAmount: bigint, minEthOut: bigint) {
    const { result: reported } = await venue.simulate.swapUsdcForEth(
      [usdcAmount, minEthOut],
      { account: traderAddress },
    );
    const before = await snapshot();
    const receipt = await mined(
      await venue.write.swapUsdcForEth([usdcAmount, minEthOut], {
        account: traderAccount,
      }),
    );
    assert.equal(receipt.status, "success");
    const after = await snapshot();
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    return {
      reported,
      received: after.traderEth - before.traderEth + gasCost,
      before,
      after,
    };
  }

  return {
    viem,
    publicClient,
    usdc,
    feed,
    venue,
    stocker,
    trader,
    stranger,
    feedDecimals,
    price,
    feeBps,
    fundTrader,
    snapshot,
    swap,
    mined,
  };
}

describe("MockSwapVenue: taking the USDC (approve, then pull)", () => {
  it("takes exactly usdcAmount and lowers the allowance by the same amount", async () => {
    const { fundTrader, swap } = await deployFixture();
    const amount = 400n * ONE_USDC;
    await fundTrader(1_000n * ONE_USDC, 700n * ONE_USDC);

    const { before, after } = await swap(amount, 0n);

    assert.equal(before.traderUsdc - after.traderUsdc, amount);
    assert.equal(after.venueUsdc - before.venueUsdc, amount);
    assert.equal(before.allowance - after.allowance, amount);
    assert.equal(after.allowance, 300n * ONE_USDC);
  });

  for (const [label, shortBy] of [
    ["no allowance at all", undefined],
    ["an allowance one unit short", 1n],
  ] as const) {
    it(`rejects a swap with ${label}, and nothing moves`, async () => {
      const { viem, usdc, venue, trader, fundTrader, snapshot } =
        await deployFixture();
      const amount = 250n * ONE_USDC;
      const allowance = shortBy === undefined ? 0n : amount - shortBy;
      await fundTrader(1_000n * ONE_USDC, allowance);
      const before = await snapshot();

      await viem.assertions.revertWithCustomErrorWithArgs(
        venue.write.swapUsdcForEth([amount, 0n], { account: trader.account }),
        usdc,
        "ERC20InsufficientAllowance",
        [venue.address, allowance, amount],
      );

      assert.deepEqual(await snapshot(), before);
    });
  }

  it("rejects a swap above the trader's USDC balance, and nothing moves", async () => {
    const { viem, usdc, venue, trader, fundTrader, snapshot } =
      await deployFixture();
    const balance = 100n * ONE_USDC;
    const amount = balance + 1n;
    await fundTrader(balance, amount);
    const before = await snapshot();

    await viem.assertions.revertWithCustomErrorWithArgs(
      venue.write.swapUsdcForEth([amount, 0n], { account: trader.account }),
      usdc,
      "ERC20InsufficientBalance",
      [trader.account.address, balance, amount],
    );

    assert.deepEqual(await snapshot(), before);
  });
});

describe("MockSwapVenue: swapping at the feed price, no fee", () => {
  for (const [label, usdcAmount, dollars, cents8] of [
    ["100 USDC at 2000 USD (divides evenly)", 100n * ONE_USDC, 2_000n, 0n],
    ["100.000001 USDC at 1999.12345678 USD", 100_000_001n, 1_999n, 12_345_678n],
    ["the smallest USDC unit at 3333.33333333 USD", 1n, 3_333n, 33_333_333n],
    ["500 USDC at 1234.56789012 USD", 500n * ONE_USDC, 1_234n, 56_789_012n],
  ] as const) {
    it(`pays exactly the worked-out amount: ${label}`, async () => {
      const price = usd(dollars) + cents8;
      const { fundTrader, swap } = await deployFixture({ price });
      await fundTrader(usdcAmount, usdcAmount);
      const expected = expectedEthOut(usdcAmount, price, 8, 0n);

      const { reported, received, before, after } = await swap(usdcAmount, 0n);

      assert.equal(received, expected);
      assert.equal(reported, expected);
      assert.equal(before.venueEth - after.venueEth, expected);
      assert.equal(after.venueUsdc - before.venueUsdc, usdcAmount);
      assert.equal(before.traderUsdc - after.traderUsdc, usdcAmount);
    });
  }

  it("pays to the wei at the target price when the amount does not divide evenly", async () => {
    // A limit order that is exactly at its target price: the order contract
    // will ask for at least floor(amount * 10^k / target). With no fee and the
    // feed at the target, the venue must pay exactly that, not one wei less.
    const target = usd(1_999n) + 12_345_678n;
    const usdcAmount = 100_000_001n;
    const k = 18n + 8n - USDC_DECIMALS;
    assert.notEqual(
      (usdcAmount * 10n ** k) % target,
      0n,
      "the sample must not divide evenly",
    );
    const atTargetMinimum = (usdcAmount * 10n ** k) / target;
    const { fundTrader, swap } = await deployFixture({ price: target });
    await fundTrader(usdcAmount, usdcAmount);

    const { received, before, after } = await swap(usdcAmount, atTargetMinimum);

    assert.equal(received, atTargetMinimum);
    assert.equal(before.venueEth - after.venueEth, atTargetMinimum);
    assert.ok(received * target <= usdcAmount * 10n ** k);
    assert.ok((received + 1n) * target > usdcAmount * 10n ** k);
  });
});

describe("MockSwapVenue: fee", () => {
  for (const feeBps of [30n, 250n, 9_999n]) {
    it(`pays less by the fee (${feeBps} basis points), exactly as worked out`, async () => {
      const price = usd(1_999n) + 12_345_678n;
      const usdcAmount = 100_000_001n;
      const { fundTrader, swap, venue } = await deployFixture({
        price,
        feeBps,
      });
      await fundTrader(usdcAmount, usdcAmount);
      const expected = expectedEthOut(usdcAmount, price, 8, feeBps);
      const withoutFee = expectedEthOut(usdcAmount, price, 8, 0n);

      const { received, before, after } = await swap(usdcAmount, 0n);

      assert.equal(await venue.read.feeBps(), feeBps);
      assert.equal(received, expected);
      assert.ok(received < withoutFee);
      assert.equal(before.venueEth - after.venueEth, expected);
      assert.equal(after.venueUsdc - before.venueUsdc, usdcAmount);
    });
  }

  it("rounds down twice, first the gross amount and then the fee, not once at the end", async () => {
    const price = usd(1_999n) + 12_345_678n;
    const usdcAmount = 100_000_001n;
    const feeBps = 30n;
    const k = 18n + 8n - USDC_DECIMALS;
    const twoSteps = expectedEthOut(usdcAmount, price, 8, feeBps);
    const oneStep = (usdcAmount * 10n ** k * (BPS - feeBps)) / (price * BPS);
    assert.notEqual(twoSteps, oneStep, "the sample must tell the two apart");
    const { fundTrader, swap } = await deployFixture({ price, feeBps });
    await fundTrader(usdcAmount, usdcAmount);

    const { received } = await swap(usdcAmount, 0n);

    assert.equal(received, twoSteps);
  });
});

describe("MockSwapVenue: minimum output", () => {
  it("rejects a swap that would pay less than minEthOut, and nothing moves", async () => {
    const { viem, venue, trader, price, fundTrader, snapshot } =
      await deployFixture({ feeBps: 30n });
    const usdcAmount = 150n * ONE_USDC;
    await fundTrader(usdcAmount, usdcAmount);
    const expected = expectedEthOut(usdcAmount, price, 8, 30n);
    const before = await snapshot();

    await viem.assertions.revertWithCustomErrorWithArgs(
      venue.write.swapUsdcForEth([usdcAmount, expected + 1n], {
        account: trader.account,
      }),
      venue,
      "InsufficientOutput",
      [expected, expected + 1n],
    );

    assert.deepEqual(await snapshot(), before);
  });

  it("accepts a swap whose payout equals minEthOut exactly", async () => {
    const { price, fundTrader, swap } = await deployFixture();
    const usdcAmount = 150n * ONE_USDC;
    await fundTrader(usdcAmount, usdcAmount);
    const expected = expectedEthOut(usdcAmount, price, 8, 0n);

    const { received } = await swap(usdcAmount, expected);

    assert.equal(received, expected);
  });
});

describe("MockSwapVenue: other rejections", () => {
  it("rejects a swap when it holds less ETH than the payout, and nothing moves", async () => {
    const usdcAmount = 100n * ONE_USDC;
    const price = usd(2_000n);
    const payout = expectedEthOut(usdcAmount, price, 8, 0n);
    const { viem, venue, trader, fundTrader, snapshot } = await deployFixture({
      price,
      ethStock: payout - 1n,
    });
    await fundTrader(usdcAmount, usdcAmount);
    const before = await snapshot();

    await viem.assertions.revertWithCustomErrorWithArgs(
      venue.write.swapUsdcForEth([usdcAmount, 0n], { account: trader.account }),
      venue,
      "InsufficientEthReserve",
      [payout - 1n, payout],
    );

    assert.deepEqual(await snapshot(), before);
  });

  it("pays out its last wei when it holds exactly the payout", async () => {
    const usdcAmount = 100n * ONE_USDC;
    const price = usd(2_000n);
    const payout = expectedEthOut(usdcAmount, price, 8, 0n);
    const { fundTrader, swap } = await deployFixture({
      price,
      ethStock: payout,
    });
    await fundTrader(usdcAmount, usdcAmount);

    const { received, after } = await swap(usdcAmount, 0n);

    assert.equal(received, payout);
    assert.equal(after.venueEth, 0n);
  });

  for (const [label, badPrice] of [
    ["zero", 0n],
    ["minus one", -1n],
    ["a large negative number", -usd(2_000n)],
  ] as const) {
    it(`rejects a swap when the feed reports ${label}, and nothing moves`, async () => {
      const { viem, feed, venue, trader, fundTrader, snapshot, mined } =
        await deployFixture();
      const usdcAmount = 100n * ONE_USDC;
      await fundTrader(usdcAmount, usdcAmount);
      await mined(await feed.write.setAnswer([badPrice]));
      const before = await snapshot();

      await viem.assertions.revertWithCustomErrorWithArgs(
        venue.write.swapUsdcForEth([usdcAmount, 0n], {
          account: trader.account,
        }),
        venue,
        "NonPositivePrice",
        [badPrice],
      );

      assert.deepEqual(await snapshot(), before);
    });
  }

  it("accepts ETH from any account", async () => {
    const { publicClient, venue, stranger, mined } = await deployFixture({
      ethStock: 0n,
    });

    await mined(
      await stranger.sendTransaction({ to: venue.address, value: ONE_ETH }),
    );

    assert.equal(
      await publicClient.getBalance({ address: venue.address }),
      ONE_ETH,
    );
  });
});

describe("MockSwapVenue: the fee is fixed at deployment", () => {
  for (const feeBps of [10_000n, 10_001n, 2n ** 256n - 1n]) {
    it(`refuses to deploy with a fee of ${feeBps} basis points (100 % or more)`, async () => {
      const { viem, usdc, feed, venue } = await deployFixture();

      await viem.assertions.revertWithCustomErrorWithArgs(
        viem
          .deployContract("MockSwapVenue", [usdc.address, feed.address, feeBps])
          .then((deployed) => deployed.address),
        venue,
        "FeeTooHigh",
        [feeBps],
      );
    });
  }

  it("deploys with a fee just under 100 %", async () => {
    const { viem, usdc, feed } = await deployFixture();

    const venue = await viem.deployContract("MockSwapVenue", [
      usdc.address,
      feed.address,
      9_999n,
    ]);

    assert.equal(await venue.read.feeBps(), 9_999n);
  });

  it("has no function that could change the fee, or anything else, apart from swapping", async () => {
    const { venue } = await deployFixture();
    const abi: readonly {
      readonly type: string;
      readonly name?: string;
      readonly stateMutability?: string;
    }[] = venue.abi;

    const stateChanging = abi
      .filter(
        (entry) =>
          entry.type === "function" &&
          entry.stateMutability !== "view" &&
          entry.stateMutability !== "pure",
      )
      .map((entry) => entry.name);
    // "fee" anywhere in the name, except inside "priceFeed".
    const feeRelated = abi
      .filter(
        (entry) =>
          entry.type === "function" && /fee(?!d)/i.test(entry.name ?? ""),
      )
      .map((entry) => `${entry.name ?? ""} ${entry.stateMutability ?? ""}`);

    assert.deepEqual(stateChanging, ["swapUsdcForEth"]);
    assert.deepEqual(feeRelated, ["feeBps view"]);
    assert.ok(abi.some((entry) => entry.type === "receive"));
    assert.ok(!abi.some((entry) => entry.type === "fallback"));
  });
});

describe("MockSwapVenue: decimals are read, not assumed", () => {
  for (const [feedDecimals, price] of [
    [18, usd(2_000n, 18) + 7n],
    [6, usd(1_999n, 6) + 123_457n],
    [0, 1_999n],
  ] as const) {
    it(`pays exactly the worked-out amount with a ${feedDecimals}-decimal feed`, async () => {
      const { venue, fundTrader, swap } = await deployFixture({
        feedDecimals,
        price,
      });
      const usdcAmount = 123_456_789n;
      await fundTrader(usdcAmount, usdcAmount);
      const expected = expectedEthOut(usdcAmount, price, feedDecimals, 0n);

      const { received, before, after } = await swap(usdcAmount, 0n);

      assert.equal(await venue.read.priceDecimals(), feedDecimals);
      assert.equal(await venue.read.usdcDecimals(), Number(USDC_DECIMALS));
      assert.equal(received, expected);
      assert.equal(before.venueEth - after.venueEth, expected);
    });
  }

  it("refuses to deploy when the decimals do not fit a uint256 scale factor", async () => {
    const { viem, usdc, venue } = await deployFixture();
    // 18 + 66 - 6 = 78, and 10^78 does not fit in a uint256.
    const tooPrecise = await viem.deployContract("MockPriceFeed", [66, 1n]);
    // 18 + 65 - 6 = 77 still fits.
    const justFits = await viem.deployContract("MockPriceFeed", [65, 1n]);

    await viem.assertions.revertWithCustomErrorWithArgs(
      viem
        .deployContract("MockSwapVenue", [usdc.address, tooPrecise.address, 0n])
        .then((deployed) => deployed.address),
      venue,
      "UnsupportedDecimals",
      [6, 66],
    );
    const deployed = await viem.deployContract("MockSwapVenue", [
      usdc.address,
      justFits.address,
      0n,
    ]);
    assert.equal(await deployed.read.priceDecimals(), 65);
  });
});
