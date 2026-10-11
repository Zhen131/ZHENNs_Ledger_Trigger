// The steps every button that sends a transaction goes through, shared by
// all of them:
//
//   idle -> confirming -> pending -> confirmed
//                 |           |
//                 +-----------+----> rejected
//
// confirming: waiting for the wallet. pending: sent, waiting for the block.
// confirmed: in a block; the page fades it out after 4 seconds (reset).
// rejected: the user said no in the wallet, or the transaction failed.
// A call that the simulation already rejects never enters this machine.

import type { Hex } from "viem";

import { shortHash } from "./format.ts";

export const TxPhase = {
  Idle: "idle",
  Confirming: "confirming",
  Pending: "pending",
  Confirmed: "confirmed",
  Rejected: "rejected",
} as const;

export type TxState =
  | { readonly phase: typeof TxPhase.Idle }
  | { readonly phase: typeof TxPhase.Confirming }
  | { readonly phase: typeof TxPhase.Pending; readonly hash: Hex }
  | {
      readonly phase: typeof TxPhase.Confirmed;
      readonly hash: Hex;
      readonly blockNumber: bigint;
    }
  | {
      readonly phase: typeof TxPhase.Rejected;
      /** True when the user said no in the wallet. */
      readonly byUser: boolean;
      /** Why it failed; empty when `byUser`. */
      readonly reason: string;
    };

export type TxEvent =
  /** The button was pressed; the wallet is asked. */
  | { readonly type: "start" }
  /** The wallet sent it. */
  | { readonly type: "sent"; readonly hash: Hex }
  /** It is in a block and succeeded. */
  | { readonly type: "mined"; readonly blockNumber: bigint }
  /** The user said no in the wallet. */
  | { readonly type: "user-rejected" }
  /** It failed: refused by the wallet or the node, or reverted on chain. */
  | { readonly type: "failed"; readonly reason: string }
  /** Clear the step: after the fade-out, or before a new try. */
  | { readonly type: "reset" };

export const IDLE: TxState = { phase: TxPhase.Idle };

/**
 * The state after `event`. A pair not in the diagram above leaves the state
 * as it is: for example a late "mined" for a step already reset.
 */
export function nextTxState(state: TxState, event: TxEvent): TxState {
  switch (state.phase) {
    case TxPhase.Idle:
      return event.type === "start" ? { phase: TxPhase.Confirming } : state;
    case TxPhase.Confirming:
      if (event.type === "sent") {
        return { phase: TxPhase.Pending, hash: event.hash };
      }
      if (event.type === "user-rejected") {
        return { phase: TxPhase.Rejected, byUser: true, reason: "" };
      }
      if (event.type === "failed") {
        return { phase: TxPhase.Rejected, byUser: false, reason: event.reason };
      }
      return state;
    case TxPhase.Pending:
      if (event.type === "mined") {
        return {
          phase: TxPhase.Confirmed,
          hash: state.hash,
          blockNumber: event.blockNumber,
        };
      }
      if (event.type === "failed") {
        return { phase: TxPhase.Rejected, byUser: false, reason: event.reason };
      }
      return state;
    case TxPhase.Confirmed:
    case TxPhase.Rejected:
      if (event.type === "reset") return IDLE;
      if (event.type === "start") return { phase: TxPhase.Confirming };
      return state;
  }
}

/** True while the step waits for the wallet or for the block. */
export function isBusy(state: TxState): boolean {
  return state.phase === TxPhase.Confirming || state.phase === TxPhase.Pending;
}

/** How a step is shown. Each `look` is also a CSS class suffix. */
export const TxLook = {
  None: "none",
  Busy: "busy",
  Done: "done",
  Error: "error",
  Declined: "declined",
} as const;

export type TxView = {
  readonly text: string;
  readonly look: (typeof TxLook)[keyof typeof TxLook];
};

/** The words and the look of a step. */
export function txView(state: TxState): TxView {
  switch (state.phase) {
    case TxPhase.Idle:
      return { text: "", look: TxLook.None };
    case TxPhase.Confirming:
      return { text: "Confirm in your wallet…", look: TxLook.Busy };
    case TxPhase.Pending:
      return {
        text: `Sent, waiting for the block… ${shortHash(state.hash)}`,
        look: TxLook.Busy,
      };
    case TxPhase.Confirmed:
      return {
        text: `Confirmed in block ${state.blockNumber}`,
        look: TxLook.Done,
      };
    case TxPhase.Rejected:
      return state.byUser
        ? { text: "You rejected it in the wallet", look: TxLook.Declined }
        : { text: state.reason, look: TxLook.Error };
  }
}
