import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FillBlocker, OrderStatus } from "../keeper/names.ts";
import {
  approvalFor,
  clearsRowMessage,
  isMine,
  myOrderIds,
  myOrderRows,
  orderRow,
  type CreatedOrder,
  type OrderSnapshot,
} from "../web/src/lib/orders.ts";
import {
  Tone,
  actionsFor,
  statusView,
  type FillCheck,
} from "../web/src/lib/status.ts";

// "My orders" is built from the OrderCreated events and, for each order, what
// getOrder, statusOf and canFill say. These tests feed made-up chain answers
// in and check the rows and the status words that come out.

const DECIMALS = { usdc: 6, price: 8 };
const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const EXECUTOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const WAITING: FillCheck = {
  fillable: false,
  reason: FillBlocker.PriceAboveTarget,
};
const READY: FillCheck = { fillable: true, reason: FillBlocker.None };

function snapshot(
  orderId: bigint,
  owner: `0x${string}`,
  status: number,
  check = WAITING,
): OrderSnapshot {
  return {
    orderId,
    order: {
      owner,
      executor: EXECUTOR,
      recipient: RECIPIENT,
      usdcAmount: 100_000_000n,
      targetPrice: 150_000_000_000n,
      createdAt: 1_000n,
      expiry: 4_600n,
    },
    status,
    check,
  };
}

describe("web status words: every OrderStatus and FillBlocker name", () => {
  it("an open order that can be filled now says so, without a pulsing dot", () => {
    assert.deepEqual(statusView(OrderStatus.Open, READY), {
      text: "Open · can be filled now",
      tone: Tone.Ready,
      pulse: false,
    });
  });

  it("an open order that cannot be filled names the reason, with a pulsing dot, for every FillBlocker", () => {
    for (const [name, value] of Object.entries(FillBlocker)) {
      if (value === FillBlocker.None) continue;
      assert.deepEqual(
        statusView(OrderStatus.Open, { fillable: false, reason: value }),
        { text: `Open · waiting: ${name}`, tone: Tone.Waiting, pulse: true },
        name,
      );
    }
  });

  it("Filled is green, Cancelled grey, Expired amber; None and unknown values are named", () => {
    const expected: Record<string, { text: string; tone: string }> = {
      None: { text: "None", tone: Tone.Unknown },
      Filled: { text: "Filled", tone: Tone.Filled },
      Cancelled: { text: "Cancelled", tone: Tone.Cancelled },
      Expired: { text: "Expired", tone: Tone.Expired },
    };
    for (const [name, value] of Object.entries(OrderStatus)) {
      if (value === OrderStatus.Open) continue;
      const view = statusView(value, WAITING);
      assert.equal(view.text, expected[name]?.text, name);
      assert.equal(view.tone, expected[name]?.tone, name);
      assert.equal(view.pulse, false, name);
    }
    assert.equal(statusView(9, WAITING).text, "unknown(9)");
  });

  it("Fill now only for Open; Cancel for Open and Expired", () => {
    assert.deepEqual(actionsFor(OrderStatus.Open), {
      fill: true,
      cancel: true,
    });
    assert.deepEqual(actionsFor(OrderStatus.Expired), {
      fill: false,
      cancel: true,
    });
    for (const status of [
      OrderStatus.None,
      OrderStatus.Filled,
      OrderStatus.Cancelled,
    ]) {
      assert.deepEqual(actionsFor(status), { fill: false, cancel: false });
    }
  });
});

describe("web order list: my orders from events and snapshots", () => {
  const created: CreatedOrder[] = [
    { orderId: 1n, owner: ME },
    { orderId: 2n, owner: OTHER },
    { orderId: 3n, owner: ME.toLowerCase() as `0x${string}` },
  ];

  it("keeps only the orders I placed, newest first, in any letter case", () => {
    assert.deepEqual(myOrderIds(created, ME), [3n, 1n]);
    assert.deepEqual(
      myOrderIds(created, ME.toUpperCase().replace("0X", "0x")),
      [3n, 1n],
    );
  });

  it("someone else's orders do not enter my list", () => {
    assert.deepEqual(myOrderIds(created, OTHER), [2n]);
    const snapshots = new Map([
      [1n, snapshot(1n, ME, OrderStatus.Open)],
      [2n, snapshot(2n, OTHER, OrderStatus.Open)],
      [3n, snapshot(3n, ME, OrderStatus.Open)],
    ]);
    const rows = myOrderRows(created, snapshots, ME, DECIMALS);
    assert.deepEqual(
      rows.map((row) => row.orderId),
      [3n, 1n],
    );
    assert.ok(rows.every((row) => row.mine));
  });

  it("without a connected account the list is empty", () => {
    assert.deepEqual(myOrderIds(created, undefined), []);
    assert.deepEqual(myOrderRows(created, new Map(), undefined, DECIMALS), []);
  });

  it("leaves out an order whose snapshot has not been read yet", () => {
    const snapshots = new Map([[1n, snapshot(1n, ME, OrderStatus.Open)]]);
    assert.deepEqual(
      myOrderRows(created, snapshots, ME, DECIMALS).map((row) => row.orderId),
      [1n],
    );
  });

  it("writes the amount and the target price in USDC and USD", () => {
    const row = orderRow(snapshot(1n, ME, OrderStatus.Open), ME, DECIMALS);
    assert.equal(row.amount, "100.00");
    assert.equal(row.targetPrice, "1500.00");
    assert.equal(row.expiry, 4_600n);
    assert.equal(row.status.text, "Open · waiting: PriceAboveTarget");
    assert.deepEqual(row.actions, { fill: true, cancel: true });
  });

  it("after a fill the same order shows Filled, in green, with no buttons", () => {
    const before = orderRow(
      snapshot(1n, ME, OrderStatus.Open, READY),
      ME,
      DECIMALS,
    );
    assert.equal(before.status.text, "Open · can be filled now");
    const after = orderRow(snapshot(1n, ME, OrderStatus.Filled), ME, DECIMALS);
    assert.equal(after.status.text, "Filled");
    assert.equal(after.status.tone, Tone.Filled);
    assert.deepEqual(after.actions, { fill: false, cancel: false });
  });

  it("an expired order still gets a Cancel button, since it still takes a slot", () => {
    const row = orderRow(snapshot(1n, ME, OrderStatus.Expired), ME, DECIMALS);
    assert.equal(row.status.text, "Expired");
    assert.deepEqual(row.actions, { fill: false, cancel: true });
  });

  it("a looked-up order placed by someone else is marked as not mine", () => {
    const row = orderRow(snapshot(2n, OTHER, OrderStatus.Open), ME, DECIMALS);
    assert.equal(row.mine, false);
    assert.deepEqual(row.actions, { fill: true, cancel: true });
    assert.equal(isMine(OTHER, undefined), false);
    assert.equal(isMine(OTHER.toLowerCase(), OTHER), true);
  });
});

describe("web approval: approve only when the allowance falls short", () => {
  it("approves openOrderTotal + amount when the allowance is below it", () => {
    assert.deepEqual(approvalFor(0n, 0n, 100n), {
      needed: true,
      allowance: 100n,
    });
    assert.deepEqual(approvalFor(150n, 100n, 100n), {
      needed: true,
      allowance: 200n,
    });
  });

  it("sends no approval when the allowance already covers it", () => {
    assert.deepEqual(approvalFor(200n, 100n, 100n), {
      needed: false,
      allowance: 200n,
    });
    assert.deepEqual(approvalFor(500n, 100n, 100n), {
      needed: false,
      allowance: 200n,
    });
  });
});

describe("web row message: a refusal goes once the order's status changes", () => {
  it("goes when the order leaves Open: Filled, Cancelled or Expired", () => {
    for (const now of [
      OrderStatus.Filled,
      OrderStatus.Cancelled,
      OrderStatus.Expired,
    ]) {
      assert.equal(clearsRowMessage(OrderStatus.Open, now), true, String(now));
    }
  });

  it("stays while the status is the same, even if the reason to wait changed", () => {
    assert.equal(clearsRowMessage(OrderStatus.Open, OrderStatus.Open), false);
    assert.equal(
      clearsRowMessage(OrderStatus.Expired, OrderStatus.Expired),
      false,
    );
  });

  it("nothing to clear when no message is shown", () => {
    assert.equal(clearsRowMessage(undefined, OrderStatus.Filled), false);
  });

  it("each row carries the statusOf value it was built from", () => {
    assert.equal(
      orderRow(snapshot(1n, ME, OrderStatus.Open), ME, DECIMALS).statusValue,
      OrderStatus.Open,
    );
    assert.equal(
      orderRow(snapshot(1n, ME, OrderStatus.Filled), ME, DECIMALS).statusValue,
      OrderStatus.Filled,
    );
  });
});
