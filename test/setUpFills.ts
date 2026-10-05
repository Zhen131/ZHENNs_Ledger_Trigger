// Sets up a brand-new local chain on which orders can be filled, for the fill
// tests. On top of `deployLedgerTrigger` it stocks the mock swap venue with
// ETH, gives `owner` and `otherOwner` 1000 USDC each with a matching allowance
// to LedgerTrigger, and adds helpers to place, fill and inspect orders.
//
// This file holds no tests; test files import `setUpFills` from it.
//
// Expected amounts are worked out here with bigint from the formulas in the
// contract's documentation, never by asking the contract.

import assert from "node:assert/strict";

import { parseEventLogs, type Address, type Hash } from "viem";

import {
  ONE_USDC,
  deployLedgerTrigger,
  usd,
  type DeployOptions,
} from "./deployLedgerTrigger.ts";

/** One ETH in wei. */
export const ONE_ETH = 10n ** 18n;
/** Basis points in 100 %. */
export const BPS = 10_000n;
const USDC_DECIMALS = 6n;

/**
 * Gas sent with every fill. With a fixed gas limit the transaction is mined
 * even when it reverts, so a rejected fill is a real reverted transaction in
 * a block, not only a failed gas estimate.
 */
export const FILL_GAS = 1_000_000n;

/** Values of the contract's OrderStatus, in declaration order. */
export const Status = {
  None: 0,
  Open: 1,
  Filled: 2,
  Cancelled: 3,
  Expired: 4,
} as const;

/** Values of the contract's FillBlocker, in declaration order. */
export const FillBlocker = {
  None: 0,
  NotOpen: 1,
  Expired: 2,
  InvalidPrice: 3,
  StalePrice: 4,
  PriceAboveTarget: 5,
  InsufficientAllowance: 6,
  InsufficientBalance: 7,
} as const;

/** 10^k with k = 18 + feed decimals - USDC decimals. */
function scale(feedDecimals: number): bigint {
  return 10n ** (18n + BigInt(feedDecimals) - USDC_DECIMALS);
}

/**
 * The two lower bounds on the ETH a fill accepts, each worked out in full and
 * rounded down once:
 * notAboveTarget = floor(usdcAmount * 10^k / targetPrice);
 * withinSlippage = floor(usdcAmount * 10^k * (10000 - maxSlippageBps)
 *                        / (price * 10000)).
 */
export function minEthOutParts(
  usdcAmount: bigint,
  targetPrice: bigint,
  price: bigint,
  maxSlippageBps: bigint,
  feedDecimals = 8,
) {
  const k = scale(feedDecimals);
  return {
    notAboveTarget: (usdcAmount * k) / targetPrice,
    withinSlippage: (usdcAmount * k * (BPS - maxSlippageBps)) / (price * BPS),
  };
}

/** The smallest ETH output a fill accepts: the larger of the two bounds. */
export function minEthOut(
  usdcAmount: bigint,
  targetPrice: bigint,
  price: bigint,
  maxSlippageBps: bigint,
  feedDecimals = 8,
): bigint {
  const { notAboveTarget, withinSlippage } = minEthOutParts(
    usdcAmount,
    targetPrice,
    price,
    maxSlippageBps,
    feedDecimals,
  );
  return notAboveTarget > withinSlippage ? notAboveTarget : withinSlippage;
}

/**
 * What MockSwapVenue pays for `usdcAmount`:
 * floor(floor(usdcAmount * 10^k / price) * (10000 - feeBps) / 10000).
 */
export function venueEthOut(
  usdcAmount: bigint,
  price: bigint,
  feeBps = 0n,
  feedDecimals = 8,
): bigint {
  const gross = (usdcAmount * scale(feedDecimals)) / price;
  return (gross * (BPS - feeBps)) / BPS;
}

/** The five inputs of createOrder. */
export type OrderInput = {
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly recipient: Address;
  readonly executor: Address;
  readonly expiry: bigint;
};

export type SetUpOptions = DeployOptions & {
  /** ETH sent to the mock swap venue after deployment. Default: 100 ETH. */
  readonly venueEth?: bigint;
};

type Fixture = Awaited<ReturnType<typeof deployLedgerTrigger>>;
export type Wallet = Fixture["owner"];
export type Trigger = Fixture["trigger"];

/**
 * Deploys the full set on a new chain and prepares it for fills. The price
 * feed starts at 2000 USD, and the default order is 100 USDC at a target of
 * 2000 USD, so it can be filled straight away. Times and prices are set by
 * the tests themselves.
 */
export async function setUpFills(options: SetUpOptions = {}) {
  const fixture = await deployLedgerTrigger(options);
  const {
    networkHelpers,
    publicClient,
    deployer,
    owner,
    otherOwner,
    executor,
    recipient,
    usdc,
    feed,
    venue,
    trigger,
    mined,
  } = fixture;

  await mined(
    await deployer.sendTransaction({
      to: venue.address,
      value: options.venueEth ?? 100n * ONE_ETH,
    }),
  );

  /** Sets the USDC allowance `wallet` gives to the address `to`. */
  async function approve(wallet: Wallet, amount: bigint, to: Address) {
    await mined(
      await usdc.write.approve([to, amount], { account: wallet.account }),
    );
  }

  for (const wallet of [owner, otherOwner]) {
    await mined(
      await usdc.write.mint([1_000n * ONE_USDC], { account: wallet.account }),
    );
    await approve(wallet, 1_000n * ONE_USDC, trigger.address);
  }

  async function now(): Promise<bigint> {
    return BigInt(await networkHelpers.time.latest());
  }

  /** Sets a new price; its update time becomes the next block's time. */
  async function setPrice(price: bigint) {
    await mined(await feed.write.setAnswer([price]));
  }

  /** Sets the feed's update time, leaving the price alone. */
  async function setUpdatedAt(updatedAt: bigint) {
    await mined(await feed.write.setUpdatedAt([updatedAt]));
  }

  /** The feed's current price. */
  async function price(): Promise<bigint> {
    const [, answer] = await feed.read.latestRoundData();
    return answer;
  }

  /** 100 USDC at a target of 2000 USD, valid for one day. */
  async function defaultInput(): Promise<OrderInput> {
    return {
      usdcAmount: 100n * ONE_USDC,
      targetPrice: usd(2_000n),
      recipient: recipient.account.address,
      executor: executor.account.address,
      expiry: (await now()) + 86_400n,
    };
  }

  /**
   * Places an order with the default input changed by `changes`, as `from`,
   * on `on` (default: the main LedgerTrigger). Returns its ID and the input.
   */
  async function place(
    changes: Partial<OrderInput> = {},
    from: Wallet = owner,
    on: Trigger = trigger,
  ) {
    const input = { ...(await defaultInput()), ...changes };
    const receipt = await mined(
      await on.write.createOrder(
        [
          input.usdcAmount,
          input.targetPrice,
          input.recipient,
          input.executor,
          input.expiry,
        ],
        { account: from.account },
      ),
    );
    const events = parseEventLogs({
      abi: on.abi,
      logs: receipt.logs,
      eventName: "OrderCreated",
    });
    assert.equal(events.length, 1);
    const event = events[0];
    if (event === undefined) throw new Error("no OrderCreated event");
    return { orderId: event.args.orderId, input };
  }

  /**
   * Sends fillOrder as `from` (default: the executor) to `on` (default: the
   * main LedgerTrigger), with a fixed gas limit. Returns the hash promise.
   */
  function sendFill(
    orderId: bigint,
    from: Wallet = executor,
    on: Trigger = trigger,
  ): Promise<Hash> {
    return on.write.fillOrder([orderId], {
      account: from.account,
      gas: FILL_GAS,
    });
  }

  /** ETH and USDC balances of `address`. */
  async function balancesOf(address: Address) {
    return {
      eth: await publicClient.getBalance({ address }),
      usdc: await usdc.read.balanceOf([address]),
    };
  }

  /**
   * Fills an order as `from` (default: the executor) on `on` (default: the
   * main LedgerTrigger) and checks that it succeeded with exactly one
   * OrderFilled event, and that the contract's own USDC and ETH balances are
   * the same before and after (the contract keeps no money). Returns the
   * event, the receipt and the change of the caller's ETH balance with its
   * gas cost added back.
   */
  async function fill(
    orderId: bigint,
    from: Wallet = executor,
    on: Trigger = trigger,
  ) {
    const contractBefore = await balancesOf(on.address);
    const callerBefore = await balancesOf(from.account.address);
    const receipt = await mined(await sendFill(orderId, from, on));
    assert.equal(receipt.status, "success");
    const events = parseEventLogs({
      abi: on.abi,
      logs: receipt.logs,
      eventName: "OrderFilled",
    });
    assert.equal(events.length, 1);
    const event = events[0];
    if (event === undefined) throw new Error("no OrderFilled event");
    assert.deepEqual(await balancesOf(on.address), contractBefore);
    const callerAfter = await balancesOf(from.account.address);
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    return {
      event,
      receipt,
      callerEthChange: callerAfter.eth - callerBefore.eth + gasCost,
    };
  }

  /** What canFill reports, as `from` (default: a stranger) on `on`. */
  async function canFill(
    orderId: bigint,
    from: Wallet = fixture.stranger,
    on: Trigger = trigger,
  ) {
    const [fillable, reason] = await on.read.canFill([orderId], {
      account: from.account,
    });
    return { fillable, reason };
  }

  /** The two per-owner numbers the contract keeps. */
  async function bookOf(wallet: Wallet, on: Trigger = trigger) {
    const address = wallet.account.address;
    return {
      count: await on.read.openOrderCount([address]),
      total: await on.read.openOrderTotal([address]),
    };
  }

  return {
    ...fixture,
    approve,
    now,
    setPrice,
    setUpdatedAt,
    price,
    defaultInput,
    place,
    sendFill,
    balancesOf,
    fill,
    canFill,
    bookOf,
  };
}
