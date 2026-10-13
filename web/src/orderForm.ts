// The order form: four kinds of order, placed in the same three steps as the
// place-order scripts:
//
// 1. Simulate the call that places the order (`createOrder`,
//    `createDormantOrder`, `createDcaOrder` or `createLadderOrder`) on the
//    local node, from the connected account. It does not look at the
//    allowance, so it works before approving. If the contract would reject
//    the order, its error is shown under the form and nothing is sent: the
//    wallet is not even asked.
// 2. Approve USDC only when the allowance falls short of the open orders
//    after this one (`openOrderTotal` plus this order's whole budget), to
//    exactly that sum.
// 3. Place the order.
//
// Each transaction shows its own line of steps. The form keeps what was
// typed, also when another kind is picked.

import { readOpenOrders, readUsdc } from "./chain.ts";
import { TRIGGER_ABI, USDC_ABI } from "./contracts.ts";
import { byId, make, remember, remembered, setShown, setText } from "./dom.ts";
import { InputError } from "./lib/amounts.ts";
import {
  budgetOf,
  canAddTier,
  canRemoveTier,
  parseDcaForm,
  parseDormantForm,
  parseLadderForm,
} from "./lib/kindForms.ts";
import { FormKind, type FormKindName } from "./lib/kinds.ts";
import { expiryFrom, parseOrderForm } from "./lib/orderForm.ts";
import { approvalFor, type Decimals } from "./lib/orders.ts";
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

/** Tier rows the Ladder form starts with. */
const FIRST_TIER_ROWS = 2;

/** What the card says under its title, for each kind. */
const LEDE: Readonly<Record<FormKindName, string>> = {
  [FormKind.Limit]:
    "Buys ETH with this USDC in one fill once the price is at or below the target. Placing moves no money; the fill does.",
  [FormKind.DormantLimit]:
    "Sleeps until the price rises to the activation price and you or the executor activate it; from then on it is a limit order that buys once the price is at or below the target. Placing moves no money; the fill does.",
  [FormKind.Dca]:
    "Buys the same amount once in every period, from the block that places it, whenever the price is at or below the cap; a period missed is skipped. With an activation price it sleeps first. Placing moves no money; each fill moves one period's USDC.",
  [FormKind.Ladder]:
    "Buys tier by tier, in order, each time the price falls to the next tier's price; prices must go down from tier to tier. With an activation price it sleeps first. Placing moves no money; each fill moves one tier's USDC.",
};

type TierRow = {
  readonly element: HTMLElement;
  readonly priceLabel: HTMLElement;
  readonly price: HTMLInputElement;
  readonly amountLabel: HTMLElement;
  readonly amount: HTMLInputElement;
  readonly remove: HTMLButtonElement;
};

let busy = false;
let approveStep: TxStep | undefined;
let placeStep: TxStep | undefined;
let kind: FormKindName = FormKind.Limit;
const tierRows: TierRow[] = [];

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

function value(id: string): string {
  return input(id).value;
}

// ---------------------------------------------------------------------------
// The kind and the fields it shows.
// ---------------------------------------------------------------------------

function isFormKind(text: string): text is FormKindName {
  return (Object.values(FormKind) as string[]).includes(text);
}

/** Shows the fields of `kind` and hides the others; keeps what was typed. */
function showKind(): void {
  setText(byId("order-lede"), LEDE[kind]);
  for (const element of byId("order-form").querySelectorAll<HTMLElement>(
    "[data-kinds]",
  )) {
    const kinds = (element.dataset["kinds"] ?? "").split(" ");
    setShown(element, kinds.includes(kind));
  }
}

// ---------------------------------------------------------------------------
// The Ladder form's tier rows.
// ---------------------------------------------------------------------------

/** Labels each row with its number, from 0, as the contract counts tiers. */
function renumberTiers(): void {
  for (const [index, row] of tierRows.entries()) {
    setText(row.priceLabel, `Tier ${index} price (USD)`);
    setText(row.amountLabel, `Tier ${index} amount (USDC)`);
    row.remove.setAttribute("aria-label", `Remove tier ${index}`);
  }
}

/** Greys out Add tier at the contract's most tiers, and Remove at one row. */
export function updateTierControls(page: Page): void {
  const most = page.trigger?.limits.maxTiersPerOrder;
  byId<HTMLButtonElement>("tier-add").disabled = !canAddTier(
    tierRows.length,
    most,
  );
  setText(
    byId("tier-limit"),
    most !== undefined && BigInt(tierRows.length) >= most
      ? `at most ${most} tiers`
      : "",
  );
  const removable = canRemoveTier(tierRows.length);
  for (const row of tierRows) row.remove.disabled = !removable;
}

function tierField(): {
  readonly label: HTMLLabelElement;
  readonly text: HTMLElement;
  readonly input: HTMLInputElement;
} {
  const label = make("label", "field");
  const text = make("span", "field-label");
  const field = make("input", "input num");
  field.inputMode = "decimal";
  field.autocomplete = "off";
  label.append(text, field);
  return { label, text, input: field };
}

function addTier(page: Page): void {
  const element = make("div", "tier-row");
  const price = tierField();
  const amount = tierField();
  const remove = make(
    "button",
    "button button-secondary button-small",
    "Remove",
  );
  remove.type = "button";
  element.append(price.label, amount.label, remove);
  const row: TierRow = {
    element,
    priceLabel: price.text,
    price: price.input,
    amountLabel: amount.text,
    amount: amount.input,
    remove,
  };
  remove.addEventListener("click", () => {
    if (!canRemoveTier(tierRows.length)) return;
    tierRows.splice(tierRows.indexOf(row), 1);
    element.remove();
    renumberTiers();
    updateTierControls(page);
  });
  tierRows.push(row);
  byId("tier-rows").append(element);
  renumberTiers();
  updateTierControls(page);
}

// ---------------------------------------------------------------------------
// Placing.
// ---------------------------------------------------------------------------

/** One call that places an order, before the expiry is known. */
type Planned = {
  readonly functionName: string;
  /** The arguments, given the latest block's time for the expiry. */
  readonly args: (latestBlockTime: bigint) => readonly unknown[];
  /** The order's whole budget, which the allowance must cover. */
  readonly budget: bigint;
};

/** Reads the form of the kind picked. Throws `InputError`. */
function planOrder(decimals: Decimals): Planned {
  const recipient = value("order-recipient");
  const executor = value("order-executor");
  switch (kind) {
    case FormKind.Limit: {
      const v = parseOrderForm(
        {
          usdc: value("order-usdc"),
          targetPriceUsd: value("order-target"),
          expiryMinutes: value("order-minutes"),
          recipient,
          executor,
        },
        decimals,
      );
      return {
        functionName: "createOrder",
        args: (time) => [
          v.usdcAmount,
          v.targetPrice,
          v.recipient,
          v.executor,
          expiryFrom(time, v.expiryMinutes),
        ],
        budget: budgetOf({ kind, usdcAmount: v.usdcAmount }),
      };
    }
    case FormKind.DormantLimit: {
      const v = parseDormantForm(
        {
          usdc: value("order-usdc"),
          targetPriceUsd: value("order-target"),
          activationPriceUsd: value("order-activation"),
          expiryMinutes: value("order-minutes"),
          recipient,
          executor,
        },
        decimals,
      );
      return {
        functionName: "createDormantOrder",
        args: (time) => [
          v.usdcAmount,
          v.targetPrice,
          v.activationPrice,
          v.recipient,
          v.executor,
          expiryFrom(time, v.expiryMinutes),
        ],
        budget: budgetOf({ kind, usdcAmount: v.usdcAmount }),
      };
    }
    case FormKind.Dca: {
      const v = parseDcaForm(
        {
          usdcPerPeriod: value("dca-usdc"),
          priceCapUsd: value("dca-cap"),
          everyDays: value("dca-days"),
          periods: value("dca-periods"),
          activationPriceUsd: value("dca-activation"),
          recipient,
          executor,
        },
        decimals,
      );
      return {
        functionName: "createDcaOrder",
        args: () => [v],
        budget: budgetOf({
          kind,
          usdcPerPeriod: v.usdcPerPeriod,
          periodCount: v.periodCount,
        }),
      };
    }
    case FormKind.Ladder: {
      const v = parseLadderForm(
        {
          tiers: tierRows.map((row) => ({
            priceUsd: row.price.value,
            usdc: row.amount.value,
          })),
          activationPriceUsd: value("ladder-activation"),
          expiryMinutes: value("order-minutes"),
          recipient,
          executor,
        },
        decimals,
      );
      return {
        functionName: "createLadderOrder",
        args: (time) => [
          {
            tiers: v.tiers,
            activationPrice: v.activationPrice,
            recipient: v.recipient,
            executor: v.executor,
            expiry: expiryFrom(time, v.expiryMinutes),
          },
        ],
        budget: budgetOf({ kind, tiers: v.tiers }),
      };
    }
  }
}

async function place(page: Page): Promise<void> {
  const trigger = page.trigger;
  const me = page.session.account;
  const wallet = page.wallet;
  if (sendBlocker(page) !== undefined || !trigger || !me || !wallet) return;
  showMessage(undefined);
  let planned: Planned;
  try {
    planned = planOrder(trigger.decimals);
  } catch (error) {
    if (error instanceof InputError) {
      showMessage(error.message);
      return;
    }
    throw error;
  }

  const latest = await page.reader.getBlock({ blockTag: "latest" });
  const args = planned.args(latest.timestamp);
  try {
    await page.reader.simulateContract({
      address: trigger.address,
      abi: TRIGGER_ABI,
      functionName: planned.functionName,
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
  const approval = approvalFor(allowance, total, planned.budget);
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
      functionName: planned.functionName,
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
  for (const radio of byId("order-form").querySelectorAll<HTMLInputElement>(
    'input[name="order-kind"]',
  )) {
    radio.addEventListener("change", () => {
      if (!radio.checked || !isFormKind(radio.value)) return;
      kind = radio.value;
      showMessage(undefined);
      showKind();
    });
  }
  byId("tier-add").addEventListener("click", () => {
    if (canAddTier(tierRows.length, page.trigger?.limits.maxTiersPerOrder)) {
      addTier(page);
    }
  });
  for (let i = 0; i < FIRST_TIER_ROWS; i += 1) addTier(page);
  showKind();
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
