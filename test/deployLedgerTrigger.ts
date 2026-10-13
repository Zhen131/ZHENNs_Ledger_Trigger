// Deploys the full set of parts LedgerTrigger needs, on a brand-new local
// chain: MockUSDC, MockPriceFeed, MockSwapVenue, a FillReceipt and
// LedgerTrigger itself.
//
// This file holds no tests; test files import `deployLedgerTrigger` from it.
// Every one of the nine deployment parameters besides the receipt contract can
// be replaced by the caller. The ones not given take the defaults below: the
// three mock parts deployed here, a 500 USDC order limit, 5 open orders per
// owner, a 75-minute price age, 1 % slippage, 52 periods per order and 5 tiers
// per order. Each LedgerTrigger gets a receipt contract of its own, bound to it
// (see `deployTrigger`).

import { network } from "hardhat";
import { getContractAddress, type Address, type Hash } from "viem";

/** One USDC in its smallest unit (6 decimals). */
export const ONE_USDC = 1_000_000n;

/**
 * The nine deployment parameters of LedgerTrigger besides the receipt
 * contract.
 */
export type LedgerTriggerParameters = {
  readonly usdc: Address;
  readonly priceFeed: Address;
  readonly swapVenue: Address;
  readonly maxOrderAmount: bigint;
  readonly maxOpenOrdersPerOwner: bigint;
  readonly maxPriceAge: bigint;
  readonly maxSlippageBps: bigint;
  readonly maxPeriodsPerOrder: bigint;
  readonly maxTiersPerOrder: bigint;
};

/** Defaults of the six numeric parameters. */
export const DEFAULT_LIMITS = {
  maxOrderAmount: 500n * ONE_USDC,
  maxOpenOrdersPerOwner: 5n,
  maxPriceAge: 75n * 60n,
  maxSlippageBps: 100n,
  maxPeriodsPerOrder: 52n,
  maxTiersPerOrder: 5n,
} as const;

/**
 * What `deployTrigger` takes: any of the nine parameters, and a receipt
 * contract.
 */
export type TriggerOverrides = Partial<LedgerTriggerParameters> & {
  /** The receipt contract to use as it is; by default a new one is deployed. */
  readonly receipt?: Address;
};

export type DeployOptions = {
  /**
   * Any of the nine parameters besides the receipt contract; the others keep
   * their defaults.
   */
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
 * Unless `overrides` names a receipt contract, it first deploys a new
 * FillReceipt bound to the address that LedgerTrigger is about to get, worked
 * out from the deployer's transaction count, and then LedgerTrigger with it:
 * two transactions from the deployer, one right after the other. Each
 * LedgerTrigger deployed this way has a receipt contract of its own. A
 * receipt contract given in `overrides` is used as it is, with nothing else
 * deployed. `fillReceipt` is the receipt contract of `trigger`.
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

  const deployerAddress = deployer.account.address;

  /**
   * Deploys a FillReceipt bound to the address of the deployer's next
   * deployment after this one; returns its address.
   */
  async function deployReceiptForNextTrigger(): Promise<Address> {
    const nonce = await publicClient.getTransactionCount({
      address: deployerAddress,
      blockTag: "pending",
    });
    const triggerAddress = getContractAddress({
      from: deployerAddress,
      nonce: BigInt(nonce) + 1n,
    });
    const fillReceipt = await viem.deployContract("FillReceipt", [
      triggerAddress,
    ]);
    return fillReceipt.address;
  }

  async function deployTrigger(overrides: TriggerOverrides = {}) {
    const { receipt, ...given } = overrides;
    const p: LedgerTriggerParameters = { ...parameters, ...given };
    const receiptAddress = receipt ?? (await deployReceiptForNextTrigger());
    return viem.deployContract("LedgerTrigger", [
      p.usdc,
      p.priceFeed,
      p.swapVenue,
      p.maxOrderAmount,
      p.maxOpenOrdersPerOwner,
      p.maxPriceAge,
      p.maxSlippageBps,
      p.maxPeriodsPerOrder,
      p.maxTiersPerOrder,
      receiptAddress,
    ]);
  }

  const trigger = await deployTrigger();
  const fillReceipt = await viem.getContractAt(
    "FillReceipt",
    await trigger.read.receipt(),
  );

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
    fillReceipt,
    parameters,
    deployTrigger,
    mined,
  };
}
