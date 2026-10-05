// Approves and places one order, from the first account of the network
// connection, which becomes the order's owner.
//
// The amount is written in USDC and the target price in USD, as people write
// them; both are turned into whole numbers with the decimals LedgerTrigger
// reports for its token and its price feed. The expiry is written as a number
// of minutes from now, where "now" is the time of the latest block.
//
// It first simulates placing the order, sending nothing: an order the
// contract would reject (above the largest order, one open order too many, an
// expiry already past) stops the script before any transaction, so no
// allowance is left behind for an order that was never placed. Then it sets
// the owner's USDC allowance to LedgerTrigger to what the owner's open orders
// will add up to once this one is placed: `openOrderTotal` after the order,
// which is exactly the allowance the owner's open orders need. Then it places
// the order and reads it back.

import type { NetworkConnection } from "hardhat/types/network";
import { erc20Abi, parseEventLogs, type Address } from "viem";

import { parseDecimal, parseWhole } from "./amounts.ts";
import { mined } from "./mined.ts";
import { ScriptError } from "./scriptError.ts";
import { GatedScript, openSendGate } from "./sendGate.ts";
import {
  VARIABLES,
  requireAddress,
  requireText,
  type Environment,
} from "./settings.ts";
import { triggerAt } from "./triggerAt.ts";

type Viem = NetworkConnection["viem"];

export type PlaceOrderSettings = {
  /** The deployed LedgerTrigger. */
  readonly contract: Address;
  /** USDC to spend, for example "100" or "2.5". */
  readonly usdc: string;
  /** Target price in USD, for example "2000" or "2412.75". */
  readonly targetPriceUsd: string;
  /** Minutes from the latest block's time until the order expires. */
  readonly expiryMinutes: bigint;
  /** Who receives the ETH. */
  readonly recipient: Address;
  /** Who may fill the order besides its owner, such as the keeper's account. */
  readonly executor: Address;
};

/** The settings of place-order, from `env`. All are required. */
export function placeOrderSettingsFrom(env: Environment): PlaceOrderSettings {
  return {
    contract: requireAddress(env, VARIABLES.contractAddress),
    usdc: requireText(env, VARIABLES.orderUsdc),
    targetPriceUsd: requireText(env, VARIABLES.targetPriceUsd),
    expiryMinutes: parseWhole(
      requireText(env, VARIABLES.expiryMinutes),
      1n,
      VARIABLES.expiryMinutes,
    ),
    recipient: requireAddress(env, VARIABLES.recipientAddress),
    executor: requireAddress(env, VARIABLES.executorAddress),
  };
}

export type PlacedOrder = {
  readonly orderId: bigint;
  readonly owner: Address;
  /** The whole numbers the order was placed with. */
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly expiry: bigint;
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
export async function placeOrder(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: PlaceOrderSettings;
}): Promise<PlacedOrder> {
  const { viem, settings } = input;
  const { publicClient, walletClients, trigger, usdcDecimals, priceDecimals } =
    await triggerAt(viem, settings.contract);
  await openSendGate(publicClient, GatedScript.PlaceOrder, input.confirmation);
  const [owner] = walletClients;
  if (owner === undefined) {
    throw new ScriptError(
      "The network has no account to place the order from.",
    );
  }
  const usdcAmount = parseDecimal(
    settings.usdc,
    usdcDecimals,
    VARIABLES.orderUsdc,
  );
  const targetPrice = parseDecimal(
    settings.targetPriceUsd,
    priceDecimals,
    VARIABLES.targetPriceUsd,
  );
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  const expiry = latest.timestamp + settings.expiryMinutes * 60n;
  const ownerAddress = owner.account.address;
  const usdc = await trigger.read.usdc();

  const orderArguments = [
    usdcAmount,
    targetPrice,
    settings.recipient,
    settings.executor,
    expiry,
  ] as const;
  await trigger.simulate.createOrder(orderArguments, {
    account: ownerAddress,
  });

  const allowance =
    (await trigger.read.openOrderTotal([ownerAddress])) + usdcAmount;
  const approval = await owner.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [trigger.address, allowance],
  });
  await mined(publicClient, approval);

  const placing = await trigger.write.createOrder(orderArguments, {
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
  return {
    orderId: created.args.orderId,
    owner: ownerAddress,
    usdcAmount,
    targetPrice,
    expiry,
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
