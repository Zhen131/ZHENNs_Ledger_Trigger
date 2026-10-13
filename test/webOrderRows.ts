import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ActivationBlocker,
  FillBlocker,
  OrderStatus,
} from "../keeper/names.ts";
import { OrderKind } from "../web/src/lib/kinds.ts";
import {
  clearsRowMessage,
  orderRow,
  rowCondition,
  type OrderSnapshot,
  type StoredOrder,
} from "../web/src/lib/orders.ts";
import type { ActivationCheck, FillCheck } from "../web/src/lib/status.ts";

// One row per order of each kind: its kind, its progress, its prices, and when
// the red message under it goes away.

const DECIMALS = { usdc: 6, price: 8 };
const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const EXECUTOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const USDC = (whole: bigint) => whole * 1_000_000n;
const USD = (whole: bigint) => whole * 100_000_000n;

const WAITING_PRICE: FillCheck = {
  fillable: false,
  reason: FillBlocker.PriceAboveTarget,
};
const DORMANT_FILL: FillCheck = {
  fillable: false,
  reason: FillBlocker.Dormant,
};
const BELOW: ActivationCheck = {
  activatable: false,
  reason: ActivationBlocker.PriceBelowActivation,
};
const CAN_ACTIVATE: ActivationCheck = {
  activatable: true,
  reason: ActivationBlocker.None,
};

function order(fields: Partial<StoredOrder>): StoredOrder {
  return {
    owner: ME,
    executor: EXECUTOR,
    recipient: RECIPIENT,
    kind: OrderKind.Limit,
    usdcAmount: USDC(100n),
    usdcRemaining: USDC(100n),
    targetPrice: USD(1500n),
    activationPrice: 0n,
    fillsTotal: 1n,
    fillsDone: 0n,
    createdAt: 1_000n,
    expiry: 4_600n,
    ...fields,
  };
}

function snapshot(
  stored: StoredOrder,
  status: number,
  check: FillCheck,
  activation?: ActivationCheck,
): OrderSnapshot {
  return activation === undefined
    ? { orderId: 1n, order: stored, status, check }
    : { orderId: 1n, order: stored, status, check, activation };
}

const DORMANT_LIMIT = order({
  targetPrice: USD(1900n),
  activationPrice: USD(2100n),
});
const DCA = order({
  kind: OrderKind.Dca,
  usdcAmount: USDC(30n),
  usdcRemaining: USDC(20n),
  targetPrice: USD(2100n),
  fillsTotal: 3n,
  fillsDone: 1n,
});
const LADDER = order({
  kind: OrderKind.Ladder,
  usdcAmount: USDC(45n),
  usdcRemaining: USDC(45n),
  targetPrice: USD(1950n),
  fillsTotal: 3n,
  fillsDone: 0n,
});

describe("web order rows: one row for each kind of order", () => {
  it("a limit order: Limit, fills 0 of 1, its target, no activation price", () => {
    const row = orderRow(
      snapshot(order({}), OrderStatus.Open, WAITING_PRICE),
      ME,
      DECIMALS,
    );
    assert.equal(row.kindValue, OrderKind.Limit);
    assert.equal(row.kind, "Limit");
    assert.equal(row.progress, "fills 0 of 1");
    assert.equal(row.amount, "100.00");
    assert.equal(row.remaining, "100.00");
    assert.equal(row.targetPrice, "1500.00");
    assert.equal(row.activationPrice, undefined);
    assert.equal(row.status.text, "Open · waiting: PriceAboveTarget");
  });

  it("a dormant limit order: Limit, its activation price under the target, and three buttons", () => {
    const row = orderRow(
      snapshot(DORMANT_LIMIT, OrderStatus.Dormant, DORMANT_FILL, BELOW),
      ME,
      DECIMALS,
    );
    assert.equal(row.kind, "Limit");
    assert.equal(row.progress, "fills 0 of 1");
    assert.equal(row.targetPrice, "1900.00");
    assert.equal(row.activationPrice, "2100.00");
    assert.equal(row.status.text, "Dormant · waiting: PriceBelowActivation");
    assert.equal(row.status.pulse, true);
    assert.deepEqual(row.actions, { activate: true, fill: true, cancel: true });
  });

  it("an activated order keeps showing its activation price", () => {
    const row = orderRow(
      snapshot(DORMANT_LIMIT, OrderStatus.Open, WAITING_PRICE, CAN_ACTIVATE),
      ME,
      DECIMALS,
    );
    assert.equal(row.activationPrice, "2100.00");
    assert.equal(row.status.text, "Open · waiting: PriceAboveTarget");
    assert.equal(row.activationValue, undefined);
  });

  it("a Dca order: Dca, the whole budget, what is left, the cap as its target, fills 1 of 3", () => {
    const row = orderRow(
      snapshot(DCA, OrderStatus.PartiallyFilled, {
        fillable: false,
        reason: FillBlocker.PeriodAlreadyFilled,
      }),
      ME,
      DECIMALS,
    );
    assert.equal(row.kindValue, OrderKind.Dca);
    assert.equal(row.kind, "Dca");
    assert.equal(row.amount, "30.00");
    assert.equal(row.remaining, "20.00");
    assert.equal(row.targetPrice, "2100.00");
    assert.equal(row.progress, "fills 1 of 3");
    assert.equal(
      row.status.text,
      "PartiallyFilled · waiting: PeriodAlreadyFilled",
    );
    assert.deepEqual(row.actions, {
      activate: false,
      fill: true,
      cancel: true,
    });
  });

  it("a Ladder order: Ladder, tier 0's price as its target, fills 0 of 3", () => {
    const row = orderRow(
      snapshot(LADDER, OrderStatus.Open, WAITING_PRICE),
      ME,
      DECIMALS,
    );
    assert.equal(row.kind, "Ladder");
    assert.equal(row.amount, "45.00");
    assert.equal(row.targetPrice, "1950.00");
    assert.equal(row.progress, "fills 0 of 3");
  });

  it("a kind the page does not know is named unknown(<value>)", () => {
    const row = orderRow(
      snapshot(order({ kind: 7 }), OrderStatus.Open, WAITING_PRICE),
      ME,
      DECIMALS,
    );
    assert.equal(row.kind, "unknown(7)");
  });
});

describe("web row message: a dormant order's activation reason counts too", () => {
  const dormant = (activation: ActivationCheck) =>
    rowCondition(
      orderRow(
        snapshot(DORMANT_LIMIT, OrderStatus.Dormant, DORMANT_FILL, activation),
        ME,
        DECIMALS,
      ),
    );

  it("a dormant row carries the activation reason it was built from", () => {
    assert.deepEqual(dormant(BELOW), {
      status: OrderStatus.Dormant,
      reason: FillBlocker.Dormant,
      activation: ActivationBlocker.PriceBelowActivation,
    });
  });

  it("goes when only the activation reason changes, the status staying Dormant", () => {
    assert.equal(clearsRowMessage(dormant(BELOW), dormant(CAN_ACTIVATE)), true);
    assert.equal(
      clearsRowMessage(
        dormant(BELOW),
        dormant({ activatable: false, reason: ActivationBlocker.StalePrice }),
      ),
      true,
    );
  });

  it("stays while the status and both reasons are the same", () => {
    assert.equal(clearsRowMessage(dormant(BELOW), dormant(BELOW)), false);
  });

  it("goes once a dormant order is activated", () => {
    const open = rowCondition(
      orderRow(
        snapshot(DORMANT_LIMIT, OrderStatus.Open, WAITING_PRICE),
        ME,
        DECIMALS,
      ),
    );
    assert.equal(clearsRowMessage(dormant(CAN_ACTIVATE), open), true);
  });

  it("any other order's row condition has exactly the two keys status and reason", () => {
    for (const [stored, status, check, activation] of [
      [order({}), OrderStatus.Open, WAITING_PRICE, undefined],
      [DORMANT_LIMIT, OrderStatus.Open, WAITING_PRICE, CAN_ACTIVATE],
      [DCA, OrderStatus.PartiallyFilled, WAITING_PRICE, undefined],
      [LADDER, OrderStatus.Filled, { fillable: false, reason: 1 }, undefined],
      [
        DORMANT_LIMIT,
        OrderStatus.Expired,
        { fillable: false, reason: 2 },
        BELOW,
      ],
    ] as const) {
      const condition = rowCondition(
        orderRow(snapshot(stored, status, check, activation), ME, DECIMALS),
      );
      assert.deepEqual(Object.keys(condition), ["status", "reason"]);
      assert.deepEqual(condition, { status, reason: check.reason });
    }
  });

  it("a dormant order whose activation check was not read has the two keys too", () => {
    const condition = rowCondition(
      orderRow(
        snapshot(DORMANT_LIMIT, OrderStatus.Dormant, DORMANT_FILL),
        ME,
        DECIMALS,
      ),
    );
    assert.deepEqual(Object.keys(condition), ["status", "reason"]);
  });
});
