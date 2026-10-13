// Approves and places one Ladder order, from the first account of the network
// connection, which becomes the order's owner. Such an order buys ETH one tier
// at a time, in order: each fill spends the amount of the next tier, at no
// more than that tier's price.
//
// It reads these environment variables:
//
// - TRIGGER_CONTRACT_ADDRESS (required): the deployed LedgerTrigger.
// - TRIGGER_TIERS (required): the tiers, in the order they are filled. Each
//   tier is written as price:amount, the price in USD and the amount in USDC,
//   and the tiers are separated by commas, such as 2000:100,1900:100,1800:100.
//   Spaces around each tier, and around each price and amount, are ignored.
//   The contract decides how many tiers an order may have, how large a tier
//   may be and that each price must be below the one before it.
// - TRIGGER_EXPIRY_MINUTES (required): minutes from the time of the latest
//   block until the order expires, a whole number of at least 1.
// - TRIGGER_ACTIVATION_PRICE_USD (optional): an activation price, in USD. Not
//   set: none, and the order is open once placed. Set: the order is placed
//   dormant and must be activated before it can be filled; the contract wants
//   it above the price of the first tier.
// - TRIGGER_RECIPIENT_ADDRESS (required): who receives the ETH.
// - TRIGGER_EXECUTOR_ADDRESS (required): who may activate and fill the order
//   besides its owner, such as the keeper's account.
//
// The amounts are written in USDC and the prices in USD, as people write them;
// they are turned into whole numbers with the decimals LedgerTrigger reports
// for its token and its price feed.
//
// It first simulates placing the order, sending nothing: an order the
// contract would reject (a tier above the largest fill, too many tiers,
// prices that do not fall, an activation price not above the first tier, one
// open order too many) stops the script before any transaction, so no
// allowance is set for it. The simulation runs on the latest block: as with
// place-order, if the node has been idle for longer than the expiry, the
// order can still be refused after the allowance is set. Then it sets the
// owner's USDC allowance to LedgerTrigger to what the owner's open orders will
// add up to once this one is placed: `openOrderTotal` before it, plus the
// order's whole budget (the amounts of its tiers added up). Then it places the
// order and reads it and its tiers back from the contract.

import type { NetworkConnection } from "hardhat/types/network";
import { erc20Abi, parseEventLogs, type Address } from "viem";

import { orderStatusName } from "../keeper/names.ts";
import { formatDecimal, parseDecimal, parseWhole } from "./amounts.ts";
import { mined } from "./mined.ts";
import { ScriptError } from "./scriptError.ts";
import { GatedScript, openSendGate } from "./sendGate.ts";
import {
  VARIABLES,
  readText,
  requireAddress,
  requireText,
  type Environment,
} from "./settings.ts";
import { triggerAt } from "./triggerAt.ts";

type Viem = NetworkConnection["viem"];

/** One tier as written in TRIGGER_TIERS, before it is turned into numbers. */
export type TierText = {
  /** The tier's price in USD, for example "2000" or "1912.5". */
  readonly priceUsd: string;
  /** The tier's amount in USDC, for example "100" or "2.5". */
  readonly usdc: string;
};

export type PlaceLadderOrderSettings = {
  /** The deployed LedgerTrigger. */
  readonly contract: Address;
  /** The tiers, in the order they are filled. */
  readonly tiers: readonly TierText[];
  /** Minutes from the latest block's time until the order expires. */
  readonly expiryMinutes: bigint;
  /** Activation price in USD, or undefined for none. */
  readonly activationPriceUsd: string | undefined;
  /** Who receives the ETH. */
  readonly recipient: Address;
  /** Who may activate and fill the order besides its owner. */
  readonly executor: Address;
};

/**
 * The tiers written in `text`, the value of TRIGGER_TIERS: price:amount
 * pairs separated by commas. Throws, naming the variable and the tier,
 * counting from 0, when a tier is empty or does not have exactly one colon.
 * The numbers themselves are checked once the decimals are known.
 */
export function tiersFrom(text: string): TierText[] {
  return text.split(",").map((written, index) => {
    const tier = written.trim();
    if (tier === "") {
      throw new ScriptError(
        `${VARIABLES.tiers} tier ${index} is empty: write the tiers as price:amount pairs separated by single commas, with no comma at the end.`,
      );
    }
    const parts = tier.split(":");
    const [priceUsd, usdc] = parts;
    if (parts.length !== 2 || priceUsd === undefined || usdc === undefined) {
      throw new ScriptError(
        `${VARIABLES.tiers} tier ${index} must be written as price:amount, with exactly one colon: the price in USD, then the amount in USDC.`,
      );
    }
    return { priceUsd: priceUsd.trim(), usdc: usdc.trim() };
  });
}

/**
 * The settings of place-ladder-order, from `env`.
 * TRIGGER_ACTIVATION_PRICE_USD may be left unset; the others are required.
 */
export function placeLadderOrderSettingsFrom(
  env: Environment,
): PlaceLadderOrderSettings {
  return {
    contract: requireAddress(env, VARIABLES.contractAddress),
    tiers: tiersFrom(requireText(env, VARIABLES.tiers)),
    expiryMinutes: parseWhole(
      requireText(env, VARIABLES.expiryMinutes),
      1n,
      VARIABLES.expiryMinutes,
    ),
    activationPriceUsd: readText(env, VARIABLES.activationPriceUsd),
    recipient: requireAddress(env, VARIABLES.recipientAddress),
    executor: requireAddress(env, VARIABLES.executorAddress),
  };
}

/** One tier as the contract stores it. */
export type PlacedTier = {
  readonly price: bigint;
  readonly usdcAmount: bigint;
};

export type PlacedLadderOrder = {
  readonly orderId: bigint;
  readonly owner: Address;
  /** The order's stored status name: Open, or Dormant with an activation price. */
  readonly status: string;
  /** The order as the contract stores it. */
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly activationPrice: bigint;
  readonly fillsTotal: bigint;
  readonly expiry: bigint;
  /** The tiers as the contract stores them. */
  readonly tiers: readonly PlacedTier[];
  /** Time of the block that placed the order. */
  readonly placedAt: bigint;
  /** The allowance set before placing, in the token's smallest unit. */
  readonly allowance: bigint;
  /** `openOrderTotal` of the owner after placing. */
  readonly openOrderTotal: bigint;
  /** The owner's USDC balance, in the token's smallest unit. */
  readonly balance: bigint;
  readonly usdcDecimals: number;
  readonly priceDecimals: number;
};

/** Approves and places the order. Passes the send gate first. */
export async function placeLadderOrder(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: PlaceLadderOrderSettings;
}): Promise<PlacedLadderOrder> {
  const { viem, settings } = input;
  const { publicClient, walletClients, trigger, usdcDecimals, priceDecimals } =
    await triggerAt(viem, settings.contract);
  await openSendGate(
    publicClient,
    GatedScript.PlaceLadderOrder,
    input.confirmation,
  );
  const [owner] = walletClients;
  if (owner === undefined) {
    throw new ScriptError(
      "The network has no account to place the order from.",
    );
  }
  const tiers = settings.tiers.map((tier, index) => ({
    price: parseDecimal(
      tier.priceUsd,
      priceDecimals,
      `${VARIABLES.tiers} tier ${index} price`,
    ),
    usdcAmount: parseDecimal(
      tier.usdc,
      usdcDecimals,
      `${VARIABLES.tiers} tier ${index} amount`,
    ),
  }));
  const activationPrice =
    settings.activationPriceUsd === undefined
      ? 0n
      : parseDecimal(
          settings.activationPriceUsd,
          priceDecimals,
          VARIABLES.activationPriceUsd,
        );
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  const expiry = latest.timestamp + settings.expiryMinutes * 60n;
  const ownerAddress = owner.account.address;
  const usdc = await trigger.read.usdc();

  const params = {
    tiers,
    activationPrice,
    recipient: settings.recipient,
    executor: settings.executor,
    expiry,
  } as const;
  await trigger.simulate.createLadderOrder([params], {
    account: ownerAddress,
  });

  const budget = tiers.reduce((sum, tier) => sum + tier.usdcAmount, 0n);
  const allowance =
    (await trigger.read.openOrderTotal([ownerAddress])) + budget;
  const approval = await owner.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [trigger.address, allowance],
  });
  await mined(publicClient, approval);

  const placing = await trigger.write.createLadderOrder([params], {
    account: owner.account,
  });
  const receipt = await mined(publicClient, placing);
  const [created] = parseEventLogs({
    abi: trigger.abi,
    logs: receipt.logs,
    eventName: "OrderCreated",
  });
  if (created === undefined) {
    throw new ScriptError(
      "The order was placed but no OrderCreated event came back.",
    );
  }
  const orderId = created.args.orderId;
  const order = await trigger.read.getOrder([orderId]);
  const stored = await trigger.read.getTiers([orderId]);
  const block = await publicClient.getBlock({
    blockNumber: receipt.blockNumber,
  });
  return {
    orderId,
    owner: ownerAddress,
    status: orderStatusName(order.status),
    usdcAmount: order.usdcAmount,
    targetPrice: order.targetPrice,
    activationPrice: order.activationPrice,
    fillsTotal: order.fillsTotal,
    expiry: order.expiry,
    tiers: stored.map((tier) => ({
      price: tier.price,
      usdcAmount: tier.usdcAmount,
    })),
    placedAt: block.timestamp,
    allowance: await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [ownerAddress, trigger.address],
    }),
    openOrderTotal: await trigger.read.openOrderTotal([ownerAddress]),
    balance: await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [ownerAddress],
    }),
    usdcDecimals,
    priceDecimals,
  };
}

/** A Unix time as an ISO date and the number itself. */
function time(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString()} (Unix ${seconds})`;
}

/** The result as lines to print. */
export function formatPlacedLadderOrder(result: PlacedLadderOrder): string[] {
  const usdc = (value: bigint) =>
    `${formatDecimal(value, result.usdcDecimals)} USDC (${value})`;
  const usd = (value: bigint) =>
    `${formatDecimal(value, result.priceDecimals)} USD (${value})`;
  const activation =
    result.activationPrice === 0n
      ? "none: the order is open once placed"
      : `${usd(result.activationPrice)}: the order waits, dormant, until it is activated`;
  return [
    `Placed Ladder order ${result.orderId} from account ${result.owner}, now ${result.status}.`,
    `  tiers             ${result.fillsTotal}, filled one at a time from tier 0`,
    ...result.tiers.map(
      (tier, index) =>
        `  tier ${index}            ${usdc(tier.usdcAmount)} at no more than ${usd(tier.price)}`,
    ),
    `  budget            ${usdc(result.usdcAmount)}`,
    `  activation price  ${activation}`,
    `  expiry            ${time(result.expiry)}, ${result.expiry - result.placedAt} seconds after the block that placed the order`,
    `  allowance         ${usdc(result.allowance)}, equal to the open-order total ${usdc(result.openOrderTotal)}`,
    `  USDC balance      ${usdc(result.balance)}`,
  ];
}
