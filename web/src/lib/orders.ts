// Builds the rows of the "My orders" table and of the order lookup from what
// the chain reports: the `OrderCreated` events, and for each order
// `getOrder`, `statusOf` and `canFill`.
//
// The contract keeps no list of orders per owner, so the page reads every
// `OrderCreated` event and keeps the ones whose owner is the connected
// account.

import type { Address } from "viem";

import { formatAmount } from "./amounts.ts";
import {
  actionsFor,
  statusView,
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
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly createdAt: bigint;
  readonly expiry: bigint;
};

/** What the chain said about one order. */
export type OrderSnapshot = {
  readonly orderId: bigint;
  readonly order: StoredOrder;
  /** `statusOf`: an OrderStatus value. */
  readonly status: number;
  /** `canFill`. */
  readonly check: FillCheck;
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
  /** USDC amount, for example "100.00". */
  readonly amount: string;
  /** Target price in USD, for example "1500.00". */
  readonly targetPrice: string;
  /** Last second, in Unix time, at which the order is valid. */
  readonly expiry: bigint;
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
  return {
    orderId: snapshot.orderId,
    owner: snapshot.order.owner,
    mine: isMine(snapshot.order.owner, me),
    amount: formatAmount(snapshot.order.usdcAmount, decimals.usdc),
    targetPrice: formatAmount(snapshot.order.targetPrice, decimals.price),
    expiry: snapshot.order.expiry,
    status: statusView(snapshot.status, snapshot.check),
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
