// One line per transaction step, driven by the shared state machine
// (lib/txState.ts): a spinner while waiting for the wallet or the block, a
// tick once it is in a block (faded out after 4 seconds), a red reason when
// it failed, grey words when the user said no in the wallet.

import type { Hex } from "viem";

import { TRIGGER_ABI } from "./contracts.ts";
import { make, setText } from "./dom.ts";
import { CHECK_ICON, CROSS_ICON } from "./icons.ts";
import { describeFailure } from "./lib/revert.ts";
import {
  IDLE,
  TxLook,
  TxPhase,
  nextTxState,
  txView,
  type TxEvent,
  type TxState,
} from "./lib/txState.ts";
import type { Page } from "./page.ts";

const SHOW_CONFIRMED_MS = 4000;
const FADE_MS = 400;

export type TxStep = {
  readonly element: HTMLElement;
  state: TxState;
  /** Bumped on every change, so a late fade-out never clears a newer state. */
  version: number;
};

function render(step: TxStep, label: string): void {
  const view = txView(step.state);
  const element = step.element;
  element.className = `tx tx-${view.look}`;
  element.hidden = step.state.phase === TxPhase.Idle;
  element.replaceChildren();
  if (view.look === TxLook.Busy) {
    const spinner = make("span", "spinner");
    spinner.setAttribute("aria-hidden", "true");
    element.append(spinner);
  } else if (view.look === TxLook.Done) {
    element.insertAdjacentHTML("beforeend", CHECK_ICON);
  } else if (view.look === TxLook.Error || view.look === TxLook.Declined) {
    element.insertAdjacentHTML("beforeend", CROSS_ICON);
  }
  if (label !== "") element.append(make("span", "tx-label", `${label}:`));
  const text = make("span", "tx-text");
  setText(text, view.text);
  element.append(text);
}

/** A new, idle step whose line is `element`. */
export function createStep(element: HTMLElement): TxStep {
  const step: TxStep = { element, state: IDLE, version: 0 };
  element.hidden = true;
  return step;
}

function apply(step: TxStep, label: string, event: TxEvent): void {
  step.state = nextTxState(step.state, event);
  step.version += 1;
  render(step, label);
}

function fadeOutLater(step: TxStep, label: string): void {
  const version = step.version;
  window.setTimeout(() => {
    if (step.version !== version) return;
    step.element.classList.add("fading");
    window.setTimeout(() => {
      if (step.version === version) apply(step, label, { type: "reset" });
    }, FADE_MS);
  }, SHOW_CONFIRMED_MS);
}

/**
 * Walks `step` through the machine for one transaction: `send` asks the
 * wallet and resolves with the hash; then the page waits for the block on
 * the local node. Resolves true when the transaction succeeded.
 */
export async function runTransaction(
  page: Page,
  step: TxStep,
  label: string,
  send: () => Promise<Hex>,
): Promise<boolean> {
  const decimals = page.trigger?.decimals ?? { usdc: 6, price: 8 };
  const fail = (error: unknown): false => {
    const failure = describeFailure(error, TRIGGER_ABI, decimals);
    apply(
      step,
      label,
      failure.kind === "user-rejected"
        ? { type: "user-rejected" }
        : { type: "failed", reason: failure.text },
    );
    return false;
  };
  apply(step, label, { type: "start" });
  let hash: Hex;
  try {
    hash = await send();
  } catch (error) {
    return fail(error);
  }
  apply(step, label, { type: "sent", hash });
  try {
    const receipt = await page.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      apply(step, label, {
        type: "failed",
        reason: `Reverted on chain in block ${receipt.blockNumber}`,
      });
      return false;
    }
    apply(step, label, { type: "mined", blockNumber: receipt.blockNumber });
  } catch (error) {
    return fail(error);
  } finally {
    page.requestRefresh();
  }
  fadeOutLater(step, label);
  return true;
}

/** Clears a step at once, whatever it shows. */
export function clearStep(step: TxStep): void {
  step.state = IDLE;
  step.version += 1;
  step.element.hidden = true;
  step.element.replaceChildren();
}
