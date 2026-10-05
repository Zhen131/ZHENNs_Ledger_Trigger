// Reads one order and says where it stands: its fields, its status worked out
// for now (`statusOf`), whether it can be filled right now (`canFill`) and if
// not the first reason why, and the price feed's latest price. Sends nothing,
// so it needs no gate. Status and reason names come from the keeper's lists.

import type { NetworkConnection } from "hardhat/types/network";
import type { Address } from "viem";

import { formatDecimal, parseWhole } from "./amounts.ts";
import { fillBlockerName, orderStatusName } from "../keeper/names.ts";
import {
  VARIABLES,
  requireAddress,
  requireText,
  type Environment,
} from "./settings.ts";
import { triggerAt } from "./triggerAt.ts";

type Viem = NetworkConnection["viem"];

export type OrderStatusSettings = {
  readonly contract: Address;
  readonly orderId: bigint;
};

/** The settings of order-status, from `env`. Both are required. */
export function orderStatusSettingsFrom(env: Environment): OrderStatusSettings {
  return {
    contract: requireAddress(env, VARIABLES.contractAddress),
    orderId: parseWhole(
      requireText(env, VARIABLES.orderId),
      1n,
      VARIABLES.orderId,
    ),
  };
}

export type OrderReport = {
  readonly orderId: bigint;
  readonly owner: Address;
  readonly executor: Address;
  readonly recipient: Address;
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly createdAt: bigint;
  readonly expiry: bigint;
  /** Stored status name (an expired order is still stored as Open). */
  readonly storedStatus: string;
  /** Status name worked out for now, from `statusOf`. */
  readonly status: string;
  readonly fillable: boolean;
  /** Reason name from `canFill`; `None` when it can be filled. */
  readonly reason: string;
  readonly latestPrice: bigint;
  readonly usdcDecimals: number;
  readonly priceDecimals: number;
};

/** Reads the order. */
export async function orderStatus(input: {
  readonly viem: Viem;
  readonly settings: OrderStatusSettings;
}): Promise<OrderReport> {
  const { viem, settings } = input;
  const { trigger, usdcDecimals, priceDecimals } = await triggerAt(
    viem,
    settings.contract,
  );
  const order = await trigger.read.getOrder([settings.orderId]);
  const status = await trigger.read.statusOf([settings.orderId]);
  const [fillable, reason] = await trigger.read.canFill([settings.orderId]);
  const feed = await viem.getContractAt(
    "IPriceFeed",
    await trigger.read.priceFeed(),
  );
  const [, latestPrice] = await feed.read.latestRoundData();
  return {
    orderId: settings.orderId,
    owner: order.owner,
    executor: order.executor,
    recipient: order.recipient,
    usdcAmount: order.usdcAmount,
    targetPrice: order.targetPrice,
    createdAt: order.createdAt,
    expiry: order.expiry,
    storedStatus: orderStatusName(order.status),
    status: orderStatusName(status),
    fillable,
    reason: fillBlockerName(reason),
    latestPrice,
    usdcDecimals,
    priceDecimals,
  };
}

/** A Unix time as an ISO date in UTC, with the number itself. */
function time(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString()} (Unix ${seconds})`;
}

/** The report as lines to print. */
export function formatOrderReport(report: OrderReport): string[] {
  const usdc = (value: bigint) =>
    `${formatDecimal(value, report.usdcDecimals)} USDC (${value})`;
  const usd = (value: bigint) =>
    `${formatDecimal(value, report.priceDecimals)} USD (${value})`;
  return [
    `Order ${report.orderId}:`,
    `  owner          ${report.owner}`,
    `  executor       ${report.executor}`,
    `  recipient      ${report.recipient}`,
    `  amount         ${usdc(report.usdcAmount)}`,
    `  target price   ${usd(report.targetPrice)}`,
    `  placed at      ${time(report.createdAt)}`,
    `  expires after  ${time(report.expiry)}`,
    `  stored status  ${report.storedStatus}`,
    `  status now     ${report.status}  (statusOf)`,
    `  can fill now   ${report.fillable ? "yes" : "no"}, reason ${report.reason}  (canFill)`,
    `  feed price     ${usd(report.latestPrice)}`,
  ];
}
