// The order form. Placing an order takes the same three steps as the
// place-order script:
//
// 1. Simulate `createOrder` on the local node, from the connected account.
//    It does not look at the allowance, so it works before approving. If the
//    contract would reject the order, its error is shown under the form and
//    nothing is sent: the wallet is not even asked.
// 2. Approve USDC only when the allowance falls short of the open orders
//    after this one (`openOrderTotal + amount`), to exactly that sum.
// 3. Place the order.
//
// Each transaction shows its own line of steps. The form keeps what was typed.

import { readOpenOrders, readUsdc } from "./chain.ts";
import { TRIGGER_ABI, USDC_ABI } from "./contracts.ts";
import { byId, remember, remembered, setShown, setText } from "./dom.ts";
import { InputError } from "./lib/amounts.ts";
import { expiryFrom, parseOrderForm } from "./lib/orderForm.ts";
import { approvalFor } from "./lib/orders.ts";
import { describeFailure } from "./lib/revert.ts";
import { sendBlocker, type Page } from "./page.ts";
import {
  clearStep,
  createStep,
  runTransaction,
  type TxStep,
} from "./txLine.ts";
import { sendCall } from "./wallet.ts";

const RECIPIENT_KEY = "ledger-trigger.recipient";
const EXECUTOR_KEY = "ledger-trigger.executor";

let busy = false;
let approveStep: TxStep | undefined;
let placeStep: TxStep | undefined;

/** True while an order is being placed. */
export function isPlacing(): boolean {
  return busy;
}

function showMessage(text: string | undefined): void {
  const message = byId("order-message");
  setShown(message, text !== undefined);
  setText(message, text ?? "");
}

/** Clears the red message under the form. */
export function resetOrderMessage(): void {
  showMessage(undefined);
}

function input(id: string): HTMLInputElement {
  return byId<HTMLInputElement>(id);
}

async function place(page: Page): Promise<void> {
  const trigger = page.trigger;
  const me = page.session.account;
  const wallet = page.wallet;
  if (sendBlocker(page) !== undefined || !trigger || !me || !wallet) return;
  showMessage(undefined);
  let values;
  try {
    values = parseOrderForm(
      {
        usdc: input("order-usdc").value,
        targetPriceUsd: input("order-target").value,
        expiryMinutes: input("order-minutes").value,
        recipient: input("order-recipient").value,
        executor: input("order-executor").value,
      },
      trigger.decimals,
    );
  } catch (error) {
    if (error instanceof InputError) {
      showMessage(error.message);
      return;
    }
    throw error;
  }

  const latest = await page.reader.getBlock({ blockTag: "latest" });
  const args = [
    values.usdcAmount,
    values.targetPrice,
    values.recipient,
    values.executor,
    expiryFrom(latest.timestamp, values.expiryMinutes),
  ] as const;
  try {
    await page.reader.simulateContract({
      address: trigger.address,
      abi: TRIGGER_ABI,
      functionName: "createOrder",
      args,
      account: me,
    });
  } catch (error) {
    const failure = describeFailure(error, TRIGGER_ABI, trigger.decimals);
    showMessage(
      failure.kind === "error" ? failure.text : "The order was not placed.",
    );
    return;
  }

  const [{ allowance }, { total }] = await Promise.all([
    readUsdc(page.reader, trigger, me),
    readOpenOrders(page.reader, trigger, me),
  ]);
  const approval = approvalFor(allowance, total, values.usdcAmount);
  const steps = byId("order-steps");
  steps.replaceChildren();
  if (approval.needed) {
    approveStep = createStep(steps.appendChild(document.createElement("div")));
    const approved = await runTransaction(
      page,
      approveStep,
      "Approve USDC",
      () =>
        sendCall(wallet, me, {
          address: trigger.usdc,
          abi: USDC_ABI,
          functionName: "approve",
          args: [trigger.address, approval.allowance],
        }),
    );
    if (!approved) return;
  }
  placeStep = createStep(steps.appendChild(document.createElement("div")));
  await runTransaction(page, placeStep, "Place order", () =>
    sendCall(wallet, me, {
      address: trigger.address,
      abi: TRIGGER_ABI,
      functionName: "createOrder",
      args,
    }),
  );
}

/** Wires the form up. `changed` is called when the controls may need updating. */
export function initOrderForm(page: Page, changed: () => void): void {
  for (const [id, key] of [
    ["order-recipient", RECIPIENT_KEY],
    ["order-executor", EXECUTOR_KEY],
  ] as const) {
    const field = input(id);
    field.value = remembered(key) ?? "";
    field.addEventListener("change", () => {
      remember(key, field.value.trim());
      page.requestRefresh();
    });
  }
  byId("order-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    for (const step of [approveStep, placeStep]) {
      if (step !== undefined) clearStep(step);
    }
    changed();
    place(page)
      .catch(() => {
        showMessage(
          `The local node at ${page.rpcUrl} does not answer. Start it with npx hardhat node.`,
        );
      })
      .finally(() => {
        busy = false;
        changed();
      });
  });
}
