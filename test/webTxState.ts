import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IDLE,
  TxLook,
  TxPhase,
  isBusy,
  nextTxState,
  txView,
  type TxEvent,
  type TxState,
} from "../web/src/lib/txState.ts";

// Every button that sends a transaction walks the same steps. One test per
// arrow of the diagram in web/src/lib/txState.ts, then the pairs that must
// change nothing, then the words shown for each step.

const HASH = "0xabcdef0123456789";
const CONFIRMING: TxState = { phase: TxPhase.Confirming };
const PENDING: TxState = { phase: TxPhase.Pending, hash: HASH };
const CONFIRMED: TxState = {
  phase: TxPhase.Confirmed,
  hash: HASH,
  blockNumber: 12n,
};
const BY_USER: TxState = { phase: TxPhase.Rejected, byUser: true, reason: "" };
const FAILED: TxState = {
  phase: TxPhase.Rejected,
  byUser: false,
  reason: "OrderNotOpen(orderId: 1, status: 2)",
};

const START: TxEvent = { type: "start" };
const SENT: TxEvent = { type: "sent", hash: HASH };
const MINED: TxEvent = { type: "mined", blockNumber: 12n };
const USER_REJECTED: TxEvent = { type: "user-rejected" };
const FAIL: TxEvent = {
  type: "failed",
  reason: "OrderNotOpen(orderId: 1, status: 2)",
};
const RESET: TxEvent = { type: "reset" };

describe("web transaction steps: every arrow", () => {
  it("idle -> confirming when the button is pressed", () => {
    assert.deepEqual(nextTxState(IDLE, START), CONFIRMING);
  });
  it("confirming -> pending when the wallet sends it, keeping the hash", () => {
    assert.deepEqual(nextTxState(CONFIRMING, SENT), PENDING);
  });
  it("confirming -> rejected (by the user) when the user says no", () => {
    assert.deepEqual(nextTxState(CONFIRMING, USER_REJECTED), BY_USER);
  });
  it("confirming -> rejected (with the reason) when the wallet or node refuses", () => {
    assert.deepEqual(nextTxState(CONFIRMING, FAIL), FAILED);
  });
  it("pending -> confirmed when it is in a block", () => {
    assert.deepEqual(nextTxState(PENDING, MINED), CONFIRMED);
  });
  it("pending -> rejected when it reverts on chain", () => {
    assert.deepEqual(nextTxState(PENDING, FAIL), FAILED);
  });
  it("confirmed -> idle after the fade-out", () => {
    assert.deepEqual(nextTxState(CONFIRMED, RESET), IDLE);
  });
  it("rejected -> idle when cleared", () => {
    assert.deepEqual(nextTxState(BY_USER, RESET), IDLE);
    assert.deepEqual(nextTxState(FAILED, RESET), IDLE);
  });
  it("confirmed or rejected -> confirming when the button is pressed again", () => {
    assert.deepEqual(nextTxState(CONFIRMED, START), CONFIRMING);
    assert.deepEqual(nextTxState(BY_USER, START), CONFIRMING);
    assert.deepEqual(nextTxState(FAILED, START), CONFIRMING);
  });
});

describe("web transaction steps: pairs that change nothing", () => {
  const cases: [string, TxState, TxEvent][] = [
    ["idle, sent", IDLE, SENT],
    ["idle, mined", IDLE, MINED],
    ["idle, failed", IDLE, FAIL],
    ["idle, user-rejected", IDLE, USER_REJECTED],
    ["idle, reset", IDLE, RESET],
    ["confirming, start", CONFIRMING, START],
    ["confirming, mined", CONFIRMING, MINED],
    ["confirming, reset", CONFIRMING, RESET],
    ["pending, start", PENDING, START],
    ["pending, sent", PENDING, SENT],
    ["pending, user-rejected", PENDING, USER_REJECTED],
    ["pending, reset", PENDING, RESET],
    ["confirmed, mined", CONFIRMED, MINED],
    ["confirmed, failed", CONFIRMED, FAIL],
    ["rejected, sent", FAILED, SENT],
    ["rejected, mined", FAILED, MINED],
  ];
  for (const [title, state, event] of cases) {
    it(title, () => {
      assert.equal(nextTxState(state, event), state);
    });
  }
});

describe("web transaction steps: what is shown", () => {
  it("busy while waiting for the wallet or the block, not otherwise", () => {
    assert.equal(isBusy(CONFIRMING), true);
    assert.equal(isBusy(PENDING), true);
    for (const state of [IDLE, CONFIRMED, BY_USER, FAILED]) {
      assert.equal(isBusy(state), false);
    }
  });

  it("the words and the look of each step", () => {
    assert.deepEqual(txView(IDLE), { text: "", look: TxLook.None });
    assert.deepEqual(txView(CONFIRMING), {
      text: "Confirm in your wallet…",
      look: TxLook.Busy,
    });
    assert.deepEqual(txView(PENDING), {
      text: "Sent, waiting for the block… 0xabcd…6789",
      look: TxLook.Busy,
    });
    assert.deepEqual(txView(CONFIRMED), {
      text: "Confirmed in block 12",
      look: TxLook.Done,
    });
    assert.deepEqual(txView(BY_USER), {
      text: "You rejected it in the wallet",
      look: TxLook.Declined,
    });
    assert.deepEqual(txView(FAILED), {
      text: "OrderNotOpen(orderId: 1, status: 2)",
      look: TxLook.Error,
    });
  });
});
