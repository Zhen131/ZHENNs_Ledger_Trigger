// "My orders" and the order lookup: one row per order, with Fill now and
// Cancel buttons. Rows are kept and updated in place, so a refresh never
// makes them flicker or restarts the pulsing dot.
//
// Fill now and Cancel simulate the call on the local node first, from the
// connected account. If the contract would reject it, the error shows in red
// under the row and the wallet is never asked. Only a call that would pass is
// sent.

import { readSnapshot } from "./chain.ts";
import { TRIGGER_ABI } from "./contracts.ts";
import { byId, formatDateTime, make, setShown, setText } from "./dom.ts";
import { InputError, parseWhole } from "./lib/amounts.ts";
import { OrderStatus } from "../../keeper/names.ts";
import {
  clearsRowMessage,
  myOrderIds,
  myOrderRows,
  orderRow,
  rowCondition,
  type CreatedOrder,
  type OrderRow,
  type OrderSnapshot,
  type RowCondition,
} from "./lib/orders.ts";
import { describeFailure } from "./lib/revert.ts";
import { isBusy } from "./lib/txState.ts";
import { sendBlocker, type Page } from "./page.ts";
import {
  clearStep,
  createStep,
  runTransaction,
  type TxStep,
} from "./txLine.ts";
import { sendCall } from "./wallet.ts";

const FLASH_MS = 800;
const COLUMNS = 6;

const Action = { Fill: "fill", Cancel: "cancel" } as const;
type ActionName = (typeof Action)[keyof typeof Action];

type RowParts = {
  readonly orderId: bigint;
  readonly main: HTMLTableRowElement;
  readonly note: HTMLTableRowElement;
  readonly id: HTMLElement;
  readonly badge: HTMLElement;
  readonly amount: HTMLElement;
  readonly target: HTMLElement;
  readonly expiry: HTMLElement;
  readonly status: HTMLElement;
  readonly dot: HTMLElement;
  readonly statusText: HTMLElement;
  readonly fill: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly message: HTMLElement;
  readonly step: TxStep;
  busy: boolean;
  /** What the row showed when the red message appeared, if one is shown. */
  messageShownAt: RowCondition | undefined;
};

const snapshots = new Map<bigint, OrderSnapshot>();
const myRows = new Map<bigint, RowParts>();
let lookupRow: RowParts | undefined;
let lookupId: bigint | undefined;
const flashing = new Set<bigint>();

/** The status and the reason the row of `snapshot` shows. */
function conditionOf(
  snapshot: OrderSnapshot | undefined,
): RowCondition | undefined {
  return snapshot === undefined
    ? undefined
    : { status: snapshot.status, reason: snapshot.check.reason };
}

function isFinal(snapshot: OrderSnapshot | undefined): boolean {
  return (
    snapshot !== undefined &&
    (snapshot.status === OrderStatus.Filled ||
      snapshot.status === OrderStatus.Cancelled)
  );
}

function createRow(page: Page, orderId: bigint): RowParts {
  const main = make("tr", "order-row");
  const note = make("tr", "note-row");
  const cell = (className = "") => make("td", className);
  const idCell = cell("order-id");
  const id = make("span", "", `#${orderId}`);
  const badge = make("span", "badge", "not yours");
  idCell.append(id, badge);
  const amount = cell("num");
  const target = cell("num");
  const expiry = cell("mono");
  const statusCell = cell();
  const status = make("span", "status");
  const dot = make("span", "dot");
  dot.setAttribute("aria-hidden", "true");
  const statusText = make("span");
  status.append(dot, statusText);
  statusCell.append(status);
  const actionsCell = cell();
  const actions = make("div", "row-actions");
  const fill = make(
    "button",
    "button button-secondary button-small",
    "Fill now",
  );
  const cancel = make(
    "button",
    "button button-secondary button-small button-danger",
    "Cancel",
  );
  fill.type = "button";
  cancel.type = "button";
  actions.append(fill, cancel);
  actionsCell.append(actions);
  main.append(idCell, amount, target, expiry, statusCell, actionsCell);

  const noteCell = cell();
  noteCell.colSpan = COLUMNS;
  const message = make("p", "message message-error");
  message.setAttribute("role", "alert");
  message.hidden = true;
  const stepLine = make("div");
  noteCell.append(message, stepLine);
  note.append(noteCell);
  note.hidden = true;

  const parts: RowParts = {
    orderId,
    main,
    note,
    id,
    badge,
    amount,
    target,
    expiry,
    status,
    dot,
    statusText,
    fill,
    cancel,
    message,
    step: createStep(stepLine),
    busy: false,
    messageShownAt: undefined,
  };
  fill.addEventListener("click", () => void act(page, parts, Action.Fill));
  cancel.addEventListener("click", () => void act(page, parts, Action.Cancel));
  return parts;
}

function updateNote(parts: RowParts): void {
  const shown = !parts.message.hidden || !parts.step.element.hidden;
  setShown(parts.note, shown);
}

/**
 * Shows the red message under a row, or clears it. `shownAt` is what the row
 * showed (status and reason) when the message appeared; the message goes
 * once either changes.
 */
function showRowMessage(
  parts: RowParts,
  text: string | undefined,
  shownAt?: RowCondition,
): void {
  parts.messageShownAt = text === undefined ? undefined : shownAt;
  setShown(parts.message, text !== undefined);
  setText(parts.message, text ?? "");
  updateNote(parts);
}

function updateRow(page: Page, parts: RowParts, row: OrderRow): void {
  if (clearsRowMessage(parts.messageShownAt, rowCondition(row))) {
    showRowMessage(parts, undefined);
  }
  setShown(parts.badge, !row.mine);
  setText(parts.amount, row.amount);
  setText(parts.target, row.targetPrice);
  setText(parts.expiry, formatDateTime(row.expiry));
  const statusClass = `status status-${row.status.tone}`;
  if (parts.status.className !== statusClass) {
    parts.status.className = statusClass;
  }
  setShown(parts.dot, row.status.pulse);
  setText(parts.statusText, row.status.text);
  setShown(parts.fill, row.actions.fill);
  setShown(parts.cancel, row.actions.cancel);
  const blocker = sendBlocker(page);
  const busy = parts.busy || isBusy(parts.step.state);
  for (const button of [parts.fill, parts.cancel]) {
    button.disabled = blocker !== undefined || busy;
    button.title = blocker ?? "";
  }
  if (flashing.has(row.orderId)) flash(parts);
  updateNote(parts);
}

function flash(parts: RowParts): void {
  parts.main.classList.remove("flash");
  void parts.main.offsetWidth;
  parts.main.classList.add("flash");
  window.setTimeout(() => parts.main.classList.remove("flash"), FLASH_MS);
}

async function act(
  page: Page,
  parts: RowParts,
  action: ActionName,
): Promise<void> {
  const trigger = page.trigger;
  const me = page.session.account;
  const wallet = page.wallet;
  if (parts.busy || sendBlocker(page) !== undefined) return;
  if (!trigger || !me || !wallet) return;
  parts.busy = true;
  parts.fill.disabled = true;
  parts.cancel.disabled = true;
  showRowMessage(parts, undefined);
  clearStep(parts.step);
  page.requestRefresh();
  const functionName = action === Action.Fill ? "fillOrder" : "cancelOrder";
  try {
    try {
      await page.reader.simulateContract({
        address: trigger.address,
        abi: TRIGGER_ABI,
        functionName,
        args: [parts.orderId],
        account: me,
      });
    } catch (error) {
      const failure = describeFailure(error, TRIGGER_ABI, trigger.decimals);
      showRowMessage(
        parts,
        failure.kind === "error" ? failure.text : "Not sent.",
        conditionOf(snapshots.get(parts.orderId)),
      );
      return;
    }
    const label = action === Action.Fill ? "Fill now" : "Cancel";
    const done = runTransaction(page, parts.step, label, () =>
      sendCall(wallet, me, {
        address: trigger.address,
        abi: TRIGGER_ABI,
        functionName,
        args: [parts.orderId],
      }),
    );
    updateNote(parts);
    await done;
  } finally {
    parts.busy = false;
    updateNote(parts);
    page.requestRefresh();
  }
}

async function readAll(page: Page, ids: readonly bigint[]): Promise<void> {
  const trigger = page.trigger;
  if (trigger === undefined) return;
  await Promise.allSettled(
    ids
      .filter((id) => !isFinal(snapshots.get(id)))
      .map(async (id) => {
        snapshots.set(id, await readSnapshot(page.reader, trigger, id));
      }),
  );
}

function emptyText(page: Page, count: number): string {
  if (page.wallet === undefined) {
    return "No wallet found in this browser, so there is no account to list orders for.";
  }
  if (page.session.account === undefined) {
    return "Connect a wallet to see your orders.";
  }
  return count === 0 ? "You have placed no orders on this contract yet." : "";
}

function renderMine(page: Page, created: readonly CreatedOrder[]): void {
  const trigger = page.trigger;
  const body = byId("my-orders");
  const rows =
    trigger === undefined
      ? []
      : myOrderRows(created, snapshots, page.session.account, trigger.decimals);
  const wanted = new Set(rows.map((row) => row.orderId));
  for (const [id, parts] of myRows) {
    if (!wanted.has(id)) {
      parts.main.remove();
      parts.note.remove();
      myRows.delete(id);
    }
  }
  let previous: Element | null = null;
  for (const row of rows) {
    let parts = myRows.get(row.orderId);
    if (parts === undefined) {
      parts = createRow(page, row.orderId);
      myRows.set(row.orderId, parts);
    }
    updateRow(page, parts, row);
    const before: ChildNode | null =
      previous === null ? body.firstChild : previous.nextSibling;
    if (before !== parts.main) body.insertBefore(parts.main, before);
    if (parts.main.nextSibling !== parts.note) parts.main.after(parts.note);
    previous = parts.note;
  }
  setText(byId("my-orders-empty"), emptyText(page, rows.length));
}

function renderLookup(page: Page): void {
  const trigger = page.trigger;
  const snapshot = lookupId === undefined ? undefined : snapshots.get(lookupId);
  if (trigger === undefined || snapshot === undefined || !lookupRow) return;
  updateRow(
    page,
    lookupRow,
    orderRow(snapshot, page.session.account, trigger.decimals),
  );
}

/**
 * Reads my orders and the looked-up one again and redraws them. `filled`
 * holds the orders whose fill just arrived: their rows flash once.
 */
export async function refreshOrders(
  page: Page,
  created: readonly CreatedOrder[],
  filled: readonly bigint[],
): Promise<void> {
  const ids = myOrderIds(created, page.session.account);
  if (lookupId !== undefined) ids.push(lookupId);
  await readAll(page, ids);
  for (const id of filled) flashing.add(id);
  renderMine(page, created);
  renderLookup(page);
  flashing.clear();
}

/** Redraws without reading, for example after the controls changed. */
export function redrawOrders(
  page: Page,
  created: readonly CreatedOrder[],
): void {
  renderMine(page, created);
  renderLookup(page);
}

function showLookupError(text: string): void {
  lookupId = undefined;
  lookupRow = undefined;
  const result = byId("lookup-result");
  const message = make("p", "message message-error", text);
  message.setAttribute("role", "alert");
  result.replaceChildren(message);
  setShown(result, true);
}

async function lookUp(page: Page): Promise<void> {
  const trigger = page.trigger;
  const text = byId<HTMLInputElement>("lookup-input").value;
  if (trigger === undefined) {
    showLookupError("Load the contract first.");
    return;
  }
  let id: bigint;
  try {
    id = parseWhole(text, 0n, "The order number");
  } catch (error) {
    showLookupError(
      error instanceof InputError ? error.message : String(error),
    );
    return;
  }
  let snapshot: OrderSnapshot;
  try {
    snapshot = await readSnapshot(page.reader, trigger, id);
  } catch (error) {
    const failure = describeFailure(error, TRIGGER_ABI, trigger.decimals);
    showLookupError(failure.kind === "error" ? failure.text : "Not found.");
    return;
  }
  snapshots.set(id, snapshot);
  lookupId = id;
  lookupRow = createRow(page, id);
  const table = make("table", "table");
  const head = make("thead");
  head.innerHTML =
    byId("my-orders").parentElement?.querySelector("thead")?.innerHTML ?? "";
  const body = make("tbody");
  body.append(lookupRow.main, lookupRow.note);
  table.append(head, body);
  const wrap = make("div", "table-wrap");
  wrap.append(table);
  const result = byId("lookup-result");
  result.replaceChildren(wrap);
  setShown(result, true);
  renderLookup(page);
}

/** Wires up the lookup form. */
export function initOrders(page: Page): void {
  byId("lookup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void lookUp(page);
  });
}

/** Forgets my rows, after the account changed. */
export function resetMyOrders(): void {
  for (const parts of myRows.values()) {
    parts.main.remove();
    parts.note.remove();
  }
  myRows.clear();
}

/** Clears the messages and transaction lines under every row. */
export function resetRowMessages(): void {
  for (const parts of [...myRows.values(), ...(lookupRow ? [lookupRow] : [])]) {
    showRowMessage(parts, undefined);
    clearStep(parts.step);
    updateNote(parts);
  }
}

/** Forgets everything, for another contract or a restarted chain. */
export function resetAllOrders(): void {
  resetMyOrders();
  snapshots.clear();
  lookupId = undefined;
  lookupRow = undefined;
  byId("lookup-result").replaceChildren();
  setShown(byId("lookup-result"), false);
}
