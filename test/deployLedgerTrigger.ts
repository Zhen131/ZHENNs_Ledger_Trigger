// Deploys the full set of parts LedgerTrigger needs, on a brand-new local
// chain: MockUSDC, MockPriceFeed, MockSwapVenue and LedgerTrigger itself.
//
// This file holds no tests; test files import `deployLedgerTrigger` from it.
// Every one of the seven deployment parameters can be replaced by the caller.
// The ones not given take the defaults below: the three mock parts deployed
// here, a 500 USDC order limit, 5 open orders per owner, a 75-minute price
// age and 1 % slippage.

import { network } from "hardhat";
import type { Address, Hash } from "viem";

/** One USDC in its smallest unit (6 decimals). */
export const ONE_USDC = 1_000_000n;

/** The seven deployment parameters of LedgerTrigger. */
export type LedgerTriggerParameters = {
  readonly usdc: Address;
  readonly priceFeed: Address;
  readonly swapVenue: Address;
  readonly maxOrderAmount: bigint;
  readonly maxOpenOrdersPerOwner: bigint;
  readonly maxPriceAge: bigint;
  readonly maxSlippageBps: bigint;
};

/** Defaults of the four numeric parameters. */
export const DEFAULT_LIMITS = {
  maxOrderAmount: 500n * ONE_USDC,
  maxOpenOrdersPerOwner: 5n,
  maxPriceAge: 75n * 60n,
  maxSlippageBps: 100n,
} as const;

export type DeployOptions = {
  /** Any of the seven parameters; the others keep their defaults. */
  readonly parameters?: Partial<LedgerTriggerParameters>;
  /** Decimals of the mock price feed. Default: 8, like Chainlink ETH / USD. */
  readonly feedDecimals?: number;
  /** First price of the mock price feed. Default: 2000 USD. */
  readonly initialPrice?: bigint;
  /** Fee of the mock swap venue, in basis points. Default: 0. */
  readonly venueFeeBps?: bigint;
};

/** A price in USD with `decimals` decimals, from whole dollars. */
export function usd(dollars: bigint, decimals = 8): bigint {
  return dollars * 10n ** BigInt(decimals);
}

/**
 * Deploys the mock parts and one LedgerTrigger on a new local chain.
 *
 * Accounts are Hardhat's built-in test accounts, by role: `deployer` deploys
 * everything; `owner` and `otherOwner` place orders; `executor` and
 * `recipient` are named in orders; `stranger` has no role at all.
 *
 * `deployTrigger(overrides)` deploys one more LedgerTrigger on the same
 * chain. Parameters not in `overrides` take the values the first one got.
 */
export async function deployLedgerTrigger(options: DeployOptions = {}) {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer, owner, executor, recipient, stranger, otherOwner] =
    await viem.getWalletClients();
  if (
    deployer === undefined ||
    owner === undefined ||
    executor === undefined ||
    recipient === undefined ||
    stranger === undefined ||
    otherOwner === undefined
  ) {
    throw new Error("the local chain must provide at least six test accounts");
  }

  const feedDecimals = options.feedDecimals ?? 8;
  const usdc = await viem.deployContract("MockUSDC");
  const feed = await viem.deployContract("MockPriceFeed", [
    feedDecimals,
    options.initialPrice ?? usd(2_000n, feedDecimals),
  ]);
  const venue = await viem.deployContract("MockSwapVenue", [
    usdc.address,
    feed.address,
    options.venueFeeBps ?? 0n,
  ]);

  const parameters: LedgerTriggerParameters = {
    usdc: usdc.address,
    priceFeed: feed.address,
    swapVenue: venue.address,
    ...DEFAULT_LIMITS,
    ...options.parameters,
  };

  function deployTrigger(overrides: Partial<LedgerTriggerParameters> = {}) {
    const p: LedgerTriggerParameters = { ...parameters, ...overrides };
    return viem.deployContract("LedgerTrigger", [
      p.usdc,
      p.priceFeed,
      p.swapVenue,
      p.maxOrderAmount,
      p.maxOpenOrdersPerOwner,
      p.maxPriceAge,
      p.maxSlippageBps,
    ]);
  }

  const trigger = await deployTrigger();

  async function mined(hash: Hash) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    viem,
    networkHelpers,
    publicClient,
    deployer,
    owner,
    executor,
    recipient,
    stranger,
    otherOwner,
    usdc,
    feed,
    venue,
    trigger,
    parameters,
    deployTrigger,
    mined,
  };
}
