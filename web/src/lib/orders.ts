// Builds the rows of the "My orders" table and of the order lookup from what
// the chain reports: the `OrderCreated` events, and for each order
// `getOrder`, `statusOf` and `canFill`, plus `canActivate` for a dormant
// order, `getSchedule` for a Dca order and `getTiers` for a Ladder order.
//
// The contract keeps no list of orders per owner, so the page reads every
// `OrderCreated` event and keeps the ones whose owner is the connected
// account.

import type { Address } from "viem";

import { OrderStatus } from "../../../keeper/names.ts";
import { formatAmount } from "./amounts.ts";
import { orderKindName } from "./kinds.ts";
import {
  actionsFor,
  statusView,
  type ActivationCheck,
  type FillCheck,
  type OrderActions,
  type StatusView,
} from "./status.ts";

/** The arguments of one `OrderCreated` event that the page uses. */
export type CreatedOrder = {
  readonly orderId: bigint;
  readonly owner: Address;
};

/** An order as `getOrder` returns it (the stored status is not used here). */
export type StoredOrder = {
  readonly owner: Address;
  readonly executor: Address;
  readonly recipient: Address;
  /** An OrderKind value. */
  readonly kind: number;
  /** The whole budget: the amount, every period's or every tier's added up. */
  readonly usdcAmount: bigint;
  /** The part of the budget not spent yet. */
  readonly usdcRemaining: bigint;
  /** Limit: the target; Dca: the cap of each period; Ladder: tier 0's price. */
  readonly targetPrice: bigint;
  /** 0 when the order was placed awake. */
  readonly activationPrice: bigint;
  /** Limit 1; Dca the number of periods; Ladder the number of tiers. */
  readonly fillsTotal: bigint;
  readonly fillsDone: bigint;
  readonly createdAt: bigint;
  readonly expiry: bigint;
};

/** A Dca order's schedule, as `getSchedule` returns it. */
export type ScheduleData = {
  /** Period 0 starts at this second (Unix time). */
  readonly startAt: bigint;
  /** Seconds in one period. */
  readonly periodLength: bigint;
  readonly usdcPerPeriod: bigint;
  /** The earliest period, counted from 0, that may still be bought. */
  readonly filledThrough: bigint;
};

/** One tier of a Ladder order, as `getTiers` returns it. */
export type TierData = {
  readonly price: bigint;
  readonly usdcAmount: bigint;
};

/** What the chain said about one order. */
export type OrderSnapshot = {
  readonly orderId: bigint;
  readonly order: StoredOrder;
  /** `statusOf`: an OrderStatus value. */
  readonly status: number;
  /** `canFill`. */
  readonly check: FillCheck;
  /** `canActivate`: read only when `statusOf` is Dormant. */
  readonly activation?: ActivationCheck;
  /** `getSchedule`: read only for a Dca order. */
  readonly schedule?: ScheduleData;
  /** `getTiers`: read only for a Ladder order. */
  readonly tiers?: readonly TierData[];
};

export type Decimals = {
  readonly usdc: number;
  readonly price: number;
};

/** One row of the table. */
export type OrderRow = {
  readonly orderId: bigint;
  readonly owner: Address;
  /** True when the connected account placed the order. */
  readonly mine: boolean;
  /** The OrderKind value. */
  readonly kindValue: number;
  /** The kind's name: "Limit", "Dca" or "Ladder". */
  readonly kind: string;
  /** The whole budget in USDC, for example "100.00". */
  readonly amount: string;
  /** The part of the budget not spent yet, in USDC. */
  readonly remaining: string;
  /** Target price in USD, for example "1500.00". */
  readonly targetPrice: string;
  /** The activation price in USD, or undefined when the order has none. */
  readonly activationPrice: string | undefined;
  /** "fills <done> of <total>". */
  readonly progress: string;
  /** Last second, in Unix time, at which the order is valid. */
  readonly expiry: bigint;
  /** `statusOf`: an OrderStatus value. */
  readonly statusValue: number;
  /** The reason `canFill` gave: a FillBlocker value. */
  readonly reasonValue: number;
  /**
   * The reason `canActivate` gave, an ActivationBlocker value: only for a
   * dormant order whose activation check was read.
   */
  readonly activationValue: number | undefined;
  readonly status: StatusView;
  readonly actions: OrderActions;
};

/** True when `owner` is `me`, ignoring letter case; false without `me`. */
export function isMine(owner: string, me: string | undefined): boolean {
  return me !== undefined && owner.toLowerCase() === me.toLowerCase();
}

/**
 * The IDs of the orders `me` placed, newest first, each once. Orders placed
 * by anyone else are left out; without `me` the list is empty.
 */
export function myOrderIds(
  created: readonly CreatedOrder[],
  me: string | undefined,
): bigint[] {
  const ids = new Set<bigint>();
  for (const event of created) {
    if (isMine(event.owner, me)) ids.add(event.orderId);
  }
  return [...ids].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

/** The table row for one order, as seen by `me`. */
export function orderRow(
  snapshot: OrderSnapshot,
  me: string | undefined,
  decimals: Decimals,
): OrderRow {
  const order = snapshot.order;
  const activation =
    snapshot.status === OrderStatus.Dormant ? snapshot.activation : undefined;
  return {
    orderId: snapshot.orderId,
    owner: order.owner,
    mine: isMine(order.owner, me),
    kindValue: order.kind,
    kind: orderKindName(order.kind),
    amount: formatAmount(order.usdcAmount, decimals.usdc),
    remaining: formatAmount(order.usdcRemaining, decimals.usdc),
    targetPrice: formatAmount(order.targetPrice, decimals.price),
    activationPrice:
      order.activationPrice > 0n
        ? formatAmount(order.activationPrice, decimals.price)
        : undefined,
    progress: `fills ${order.fillsDone} of ${order.fillsTotal}`,
    expiry: order.expiry,
    statusValue: snapshot.status,
    reasonValue: snapshot.check.reason,
    activationValue: activation?.reason,
    status: statusView(snapshot.status, snapshot.check, activation),
    actions: actionsFor(snapshot.status),
  };
}

/**
 * The rows of "My orders": one per order `me` placed, newest first, built
 * from the latest snapshot of each. An order whose snapshot has not been read
 * yet is left out until it has.
 */
export function myOrderRows(
  created: readonly CreatedOrder[],
  snapshots: ReadonlyMap<bigint, OrderSnapshot>,
  me: string | undefined,
  decimals: Decimals,
): OrderRow[] {
  const rows: OrderRow[] = [];
  for (const id of myOrderIds(created, me)) {
    const snapshot = snapshots.get(id);
    if (snapshot !== undefined) rows.push(orderRow(snapshot, me, decimals));
  }
  return rows;
}

/**
 * The allowance to set before placing an order of `amount`: the owner's open
 * orders after this one, `openOrderTotal + amount`. `needed` is false when
 * the current allowance already covers that, so no approval is sent.
 */
export function approvalFor(
  allowance: bigint,
  openOrderTotal: bigint,
  amount: bigint,
): { readonly needed: boolean; readonly allowance: bigint } {
  const target = openOrderTotal + amount;
  return { needed: allowance < target, allowance: target };
}

/**
 * What a row shows about an order: its status and the reason from `canFill`,
 * and for a dormant order the reason from `canActivate`.
 */
export type RowCondition = {
  /** `statusOf`: an OrderStatus value. */
  readonly status: number;
  /** `canFill`'s reason: a FillBlocker value. */
  readonly reason: number;
  /** `canActivate`'s reason, an ActivationBlocker value: dormant orders only. */
  readonly activation?: number;
};

/**
 * The status and the reasons a row shows: `{ status, reason }`, and for a
 * dormant order whose activation check was read `{ status, reason,
 * activation }`.
 */
export function rowCondition(row: OrderRow): RowCondition {
  return row.activationValue === undefined
    ? { status: row.statusValue, reason: row.reasonValue }
    : {
        status: row.statusValue,
        reason: row.reasonValue,
        activation: row.activationValue,
      };
}

/**
 * Whether the red message under an order's row goes away now. The message
 * says why the contract refused a call while the row showed `shownAt`
 * (undefined when no message is shown). Once the row shows something else,
 * `now`, the message no longer fits it, so it goes: when the status changed,
 * such as Filled after Open, and also when only a reason changed, such as
 * "can be filled now" after "waiting: PriceAboveTarget", or for a dormant
 * order "can be activated now" after "waiting: PriceBelowActivation". It
 * stays only while the status and the reasons are all the same.
 */
export function clearsRowMessage(
  shownAt: RowCondition | undefined,
  now: RowCondition,
): boolean {
  return (
    shownAt !== undefined &&
    (shownAt.status !== now.status ||
      shownAt.reason !== now.reason ||
      shownAt.activation !== now.activation)
  );
}
