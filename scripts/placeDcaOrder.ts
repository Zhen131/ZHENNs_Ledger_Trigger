// Approves and places one time-scheduled (Dca) order, from the first account
// of the network connection, which becomes the order's owner. Such an order
// buys a set amount of USDC's worth of ETH once in each period, for a number
// of periods, each time at no more than its price cap.
//
// It reads these environment variables:
//
// - TRIGGER_CONTRACT_ADDRESS (required): the deployed LedgerTrigger.
// - TRIGGER_USDC_PER_PERIOD (required): USDC to spend in each period, such as
//   10 or 2.5.
// - TRIGGER_TARGET_PRICE_USD (required): the price cap of every period, in
//   USD, such as 2000 or 2412.75.
// - TRIGGER_PERIOD_SECONDS (required): the length of one period, in seconds, a
//   whole number of at least 1.
// - TRIGGER_PERIOD_COUNT (required): the number of periods, a whole number of
//   at least 1.
// - TRIGGER_START_AT (optional): the Unix time, in seconds, at which period 0
//   begins, a whole number. Not set, or 0: the order's first period begins in
//   the block that places it; the contract stores that block's time. The
//   script never guesses the time of a block itself.
// - TRIGGER_ACTIVATION_PRICE_USD (optional): an activation price, in USD. Not
//   set: none, and the order is open once placed. Set: the order is placed
//   dormant and must be activated before it can be filled.
// - TRIGGER_RECIPIENT_ADDRESS (required): who receives the ETH.
// - TRIGGER_EXECUTOR_ADDRESS (required): who may activate and fill the order
//   besides its owner, such as the keeper's account.
//
// The amount is written in USDC and the prices in USD, as people write them;
// they are turned into whole numbers with the decimals LedgerTrigger reports
// for its token and its price feed.
//
// It first simulates placing the order, sending nothing: an order the
// contract would reject (an amount per period above the largest fill, more
// periods than allowed, a start time already past, one open order too many)
// stops the script before any transaction, so no allowance is left behind
// for an order that was never placed. Then it sets the owner's USDC allowance
// to LedgerTrigger to what the owner's open orders will add up to once this
// one is placed: `openOrderTotal` before it, plus the order's whole budget
// (the amount per period times the number of periods). Then it places the
// order and reads it and its schedule back from the contract.

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

export type PlaceDcaOrderSettings = {
  /** The deployed LedgerTrigger. */
  readonly contract: Address;
  /** USDC to spend in each period, for example "10" or "2.5". */
  readonly usdcPerPeriod: string;
  /** Price cap of every period in USD, for example "2000" or "2412.75". */
  readonly targetPriceUsd: string;
  /** Length of one period, in seconds. */
  readonly periodSeconds: bigint;
  /** Number of periods. */
  readonly periodCount: bigint;
  /** Unix time at which period 0 begins; 0 for the block that places it. */
  readonly startAt: bigint;
  /** Activation price in USD, or undefined for none. */
  readonly activationPriceUsd: string | undefined;
  /** Who receives the ETH. */
  readonly recipient: Address;
  /** Who may activate and fill the order besides its owner. */
  readonly executor: Address;
};

/**
 * The settings of place-dca-order, from `env`. TRIGGER_START_AT and
 * TRIGGER_ACTIVATION_PRICE_USD may be left unset; the others are required.
 */
export function placeDcaOrderSettingsFrom(
  env: Environment,
): PlaceDcaOrderSettings {
  const startAt = readText(env, VARIABLES.startAt);
  return {
    contract: requireAddress(env, VARIABLES.contractAddress),
    usdcPerPeriod: requireText(env, VARIABLES.usdcPerPeriod),
    targetPriceUsd: requireText(env, VARIABLES.targetPriceUsd),
    periodSeconds: parseWhole(
      requireText(env, VARIABLES.periodSeconds),
      1n,
      VARIABLES.periodSeconds,
    ),
    periodCount: parseWhole(
      requireText(env, VARIABLES.periodCount),
      1n,
      VARIABLES.periodCount,
    ),
    startAt:
      startAt === undefined ? 0n : parseWhole(startAt, 0n, VARIABLES.startAt),
    activationPriceUsd: readText(env, VARIABLES.activationPriceUsd),
    recipient: requireAddress(env, VARIABLES.recipientAddress),
    executor: requireAddress(env, VARIABLES.executorAddress),
  };
}

export type PlacedDcaOrder = {
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
  /** The schedule as the contract stores it. */
  readonly startAt: bigint;
  readonly periodLength: bigint;
  readonly usdcPerPeriod: bigint;
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
export async function placeDcaOrder(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: PlaceDcaOrderSettings;
}): Promise<PlacedDcaOrder> {
  const { viem, settings } = input;
  const { publicClient, walletClients, trigger, usdcDecimals, priceDecimals } =
    await triggerAt(viem, settings.contract);
  await openSendGate(
    publicClient,
    GatedScript.PlaceDcaOrder,
    input.confirmation,
  );
  const [owner] = walletClients;
  if (owner === undefined) {
    throw new ScriptError(
      "The network has no account to place the order from.",
    );
  }
  const usdcPerPeriod = parseDecimal(
    settings.usdcPerPeriod,
    usdcDecimals,
    VARIABLES.usdcPerPeriod,
  );
  const targetPrice = parseDecimal(
    settings.targetPriceUsd,
    priceDecimals,
    VARIABLES.targetPriceUsd,
  );
  const activationPrice =
    settings.activationPriceUsd === undefined
      ? 0n
      : parseDecimal(
          settings.activationPriceUsd,
          priceDecimals,
          VARIABLES.activationPriceUsd,
        );
  const ownerAddress = owner.account.address;
  const usdc = await trigger.read.usdc();

  const params = {
    usdcPerPeriod,
    targetPrice,
    periodLength: settings.periodSeconds,
    periodCount: settings.periodCount,
    startAt: settings.startAt,
    activationPrice,
    recipient: settings.recipient,
    executor: settings.executor,
  } as const;
  await trigger.simulate.createDcaOrder([params], { account: ownerAddress });

  const budget = usdcPerPeriod * settings.periodCount;
  const allowance =
    (await trigger.read.openOrderTotal([ownerAddress])) + budget;
  const approval = await owner.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [trigger.address, allowance],
  });
  await mined(publicClient, approval);

  const placing = await trigger.write.createDcaOrder([params], {
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
  const schedule = await trigger.read.getSchedule([orderId]);
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
    startAt: schedule.startAt,
    periodLength: schedule.periodLength,
    usdcPerPeriod: schedule.usdcPerPeriod,
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
export function formatPlacedDcaOrder(result: PlacedDcaOrder): string[] {
  const usdc = (value: bigint) =>
    `${formatDecimal(value, result.usdcDecimals)} USDC (${value})`;
  const usd = (value: bigint) =>
    `${formatDecimal(value, result.priceDecimals)} USD (${value})`;
  const activation =
    result.activationPrice === 0n
      ? "none: the order is open once placed"
      : `${usd(result.activationPrice)}: the order waits, dormant, until it is activated`;
  return [
    `Placed time-scheduled order ${result.orderId} from account ${result.owner}, now ${result.status}.`,
    `  per period        ${usdc(result.usdcPerPeriod)}`,
    `  price cap         ${usd(result.targetPrice)}`,
    `  periods           ${result.fillsTotal} of ${result.periodLength} seconds each`,
    `  budget            ${usdc(result.usdcAmount)}`,
    `  activation price  ${activation}`,
    `  period 0 begins   ${time(result.startAt)}, ${result.startAt - result.placedAt} seconds after the block that placed the order`,
    `  last second       ${time(result.expiry)}, the end of the last period`,
    `  allowance         ${usdc(result.allowance)}, equal to the open-order total ${usdc(result.openOrderTotal)}`,
    `  USDC balance      ${usdc(result.balance)}`,
  ];
}
