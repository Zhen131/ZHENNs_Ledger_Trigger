// Reads one order and says where it stands: its kind and fields, how much of
// it is left and how many of its fills are done, its status worked out for now
// (`statusOf`), whether it can be filled right now (`canFill`) and if not the
// first reason why, and the price feed's latest price. A dormant order also
// says whether it can be activated now (`canActivate`) and if not why; a Dca
// order adds its schedule (`getSchedule`), a Ladder order its tiers
// (`getTiers`). Sends nothing, so it needs no gate.
//
// `getOrder` is read first. `canActivate` is asked only when the stored status
// is Dormant, `getSchedule` only for a Dca order and `getTiers` only for a
// Ladder order: the contract rejects the last two for any other kind. Kind
// names come from the web page's list (web/src/lib/kinds.ts), status and
// reason names from the keeper's lists; this file keeps no list of its own.

import type { NetworkConnection } from "hardhat/types/network";
import type { Address } from "viem";

import { formatDecimal, parseWhole } from "./amounts.ts";
import {
  OrderStatus,
  activationBlockerName,
  fillBlockerName,
  orderStatusName,
} from "../keeper/names.ts";
import { OrderKind, orderKindName } from "../web/src/lib/kinds.ts";
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

/** A Dca order's schedule, as `getSchedule` returns it. */
export type OrderSchedule = {
  /** When period 0 begins, in Unix seconds. */
  readonly startAt: bigint;
  /** Length of one period, in seconds. */
  readonly periodLength: bigint;
  /** USDC bought in each period, in the token's smallest unit. */
  readonly usdcPerPeriod: bigint;
  /** The earliest period a fill can still buy, counted from 0. */
  readonly filledThrough: bigint;
};

/** One tier of a Ladder order, as `getTiers` returns it. */
export type OrderTier = {
  readonly price: bigint;
  readonly usdcAmount: bigint;
};

export type OrderReport = {
  readonly orderId: bigint;
  /** Kind name: Limit, Dca or Ladder. */
  readonly kind: string;
  readonly owner: Address;
  readonly executor: Address;
  readonly recipient: Address;
  /** The whole order's budget. */
  readonly usdcAmount: bigint;
  /** The part of the budget not spent yet. */
  readonly usdcRemaining: bigint;
  readonly targetPrice: bigint;
  /** 0 when the order was placed without an activation price. */
  readonly activationPrice: bigint;
  readonly fillsDone: bigint;
  readonly fillsTotal: bigint;
  readonly createdAt: bigint;
  readonly expiry: bigint;
  /**
   * Stored status name. Never Expired: an order past its expiry keeps the
   * status it had, such as Open, Dormant or PartiallyFilled.
   */
  readonly storedStatus: string;
  /** Status name worked out for now, from `statusOf`. */
  readonly status: string;
  readonly fillable: boolean;
  /** Reason name from `canFill`; `None` when it can be filled. */
  readonly reason: string;
  /**
   * From `canActivate`, only when the stored status is Dormant: whether the
   * order can be activated now, and the reason name (`None` when it can).
   */
  readonly activation:
    { readonly activatable: boolean; readonly reason: string } | undefined;
  /** Only for a Dca order. */
  readonly schedule: OrderSchedule | undefined;
  /** Only for a Ladder order, tier 0 first. */
  readonly tiers: readonly OrderTier[] | undefined;
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
  const { client, trigger, usdcDecimals, priceDecimals } = await triggerAt(
    viem,
    settings.contract,
  );
  const order = await trigger.read.getOrder([settings.orderId]);
  const status = await trigger.read.statusOf([settings.orderId]);
  const [fillable, reason] = await trigger.read.canFill([settings.orderId]);
  let activation: OrderReport["activation"];
  if (order.status === OrderStatus.Dormant) {
    const [activatable, blocker] = await trigger.read.canActivate([
      settings.orderId,
    ]);
    activation = { activatable, reason: activationBlockerName(blocker) };
  }
  let schedule: OrderSchedule | undefined;
  if (order.kind === OrderKind.Dca) {
    const read = await trigger.read.getSchedule([settings.orderId]);
    schedule = {
      startAt: read.startAt,
      periodLength: read.periodLength,
      usdcPerPeriod: read.usdcPerPeriod,
      filledThrough: read.filledThrough,
    };
  }
  let tiers: OrderTier[] | undefined;
  if (order.kind === OrderKind.Ladder) {
    tiers = (await trigger.read.getTiers([settings.orderId])).map((tier) => ({
      price: tier.price,
      usdcAmount: tier.usdcAmount,
    }));
  }
  const feed = await viem.getContractAt(
    "IPriceFeed",
    await trigger.read.priceFeed(),
    { client },
  );
  const [, latestPrice] = await feed.read.latestRoundData();
  return {
    orderId: settings.orderId,
    kind: orderKindName(order.kind),
    owner: order.owner,
    executor: order.executor,
    recipient: order.recipient,
    usdcAmount: order.usdcAmount,
    usdcRemaining: order.usdcRemaining,
    targetPrice: order.targetPrice,
    activationPrice: order.activationPrice,
    fillsDone: order.fillsDone,
    fillsTotal: order.fillsTotal,
    createdAt: order.createdAt,
    expiry: order.expiry,
    storedStatus: orderStatusName(order.status),
    status: orderStatusName(status),
    fillable,
    reason: fillBlockerName(reason),
    activation,
    schedule,
    tiers,
    latestPrice,
    usdcDecimals,
    priceDecimals,
  };
}

/** A Unix time as an ISO date in UTC, with the number itself. */
function time(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString()} (Unix ${seconds})`;
}

/**
 * The report as lines to print. A dormant order adds a `can activate` line, a
 * Dca order four lines of schedule, a Ladder order one line per tier.
 */
export function formatOrderReport(report: OrderReport): string[] {
  const usdc = (value: bigint) =>
    `${formatDecimal(value, report.usdcDecimals)} USDC (${value})`;
  const usd = (value: bigint) =>
    `${formatDecimal(value, report.priceDecimals)} USD (${value})`;
  const { activation, schedule, tiers } = report;
  return [
    `Order ${report.orderId}:`,
    `  kind           ${report.kind}`,
    `  owner          ${report.owner}`,
    `  executor       ${report.executor}`,
    `  recipient      ${report.recipient}`,
    `  amount         ${usdc(report.usdcAmount)}`,
    `  remaining      ${usdc(report.usdcRemaining)}`,
    `  target price   ${usd(report.targetPrice)}`,
    `  activation     ${report.activationPrice === 0n ? "none" : usd(report.activationPrice)}`,
    `  fills done     ${report.fillsDone} of ${report.fillsTotal}`,
    `  placed at      ${time(report.createdAt)}`,
    `  expires after  ${time(report.expiry)}`,
    `  stored status  ${report.storedStatus}`,
    `  status now     ${report.status}  (statusOf)`,
    `  can fill now   ${report.fillable ? "yes" : "no"}, reason ${report.reason}  (canFill)`,
    ...(activation === undefined
      ? []
      : [
          `  can activate   ${activation.activatable ? "yes" : "no"}, reason ${activation.reason}  (canActivate)`,
        ]),
    `  feed price     ${usd(report.latestPrice)}`,
    ...(schedule === undefined
      ? []
      : [
          `  per period     ${usdc(schedule.usdcPerPeriod)}`,
          `  period length  ${schedule.periodLength} seconds`,
          `  period 0 from  ${time(schedule.startAt)}`,
          `  next period    ${schedule.filledThrough} (earliest period a fill can buy)`,
        ]),
    ...(tiers ?? []).map(
      (tier, index) =>
        `  ${`tier ${index}`.padEnd(15)}${usdc(tier.usdcAmount)} at no more than ${usd(tier.price)}, ${BigInt(index) < report.fillsDone ? "filled" : "not filled"}`,
    ),
  ];
}
