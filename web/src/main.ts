// Entry point of the web page: builds the page, loads the contract, connects
// the wallet and keeps everything up to date.
//
// Every read goes to the local node (http://127.0.0.1:8545 unless the
// address bar names another loopback node with ?rpc=). The wallet only gives
// the account and signs transactions. The page refreshes on every new block
// and, as a fallback, every 2 seconds, but only while it is visible.

import { createReader, loadTrigger } from "./chain.ts";
import { byId, remember, remembered, setShown, setText } from "./dom.ts";
import {
  createdOrders,
  feedEntries,
  pullEvents,
  resetEvents,
} from "./events.ts";
import { renderFeed } from "./feedList.ts";
import { shortAddress } from "./lib/format.ts";
import { limitsText } from "./lib/limits.ts";
import { DEFAULT_RPC_URL, rpcUrlFrom } from "./lib/loopback.ts";
import {
  NO_SESSION,
  Reset,
  accountsChanged,
  chainChanged,
  checkChain,
  type ResetName,
} from "./lib/session.ts";
import { PAGE_MARKUP } from "./markup.ts";
import { refreshMetrics, resetMetrics, resetMyBalances } from "./metrics.ts";
import {
  initOrderForm,
  isPlacing,
  resetOrderMessage,
  updateTierControls,
} from "./orderForm.ts";
import {
  initOrders,
  redrawOrders,
  refreshOrders,
  resetAllOrders,
  resetMyOrders,
  resetRowMessages,
} from "./ordersCard.ts";
import { sendBlocker, type Page } from "./page.ts";
import {
  findWallet,
  requestAccounts,
  walletChainId,
  watchWallet,
} from "./wallet.ts";

const CONTRACT_KEY = "ledger-trigger.contract";
const FALLBACK_REFRESH_MS = 2000;

byId("app").innerHTML = PAGE_MARKUP;

const notice = byId("page-notice");

/** What is wrong right now, by source; each is cleared once it is fixed. */
const problems: {
  settings?: string | undefined;
  node?: string | undefined;
  contract?: string | undefined;
  wallet?: string | undefined;
} = {};

/**
 * Shows the most important problem under the contract and wallet bar, or
 * hides the line: an error with the settings, the node or the contract
 * first, then the wallet, then the wallet's chain.
 */
function renderNotice(): void {
  const error = problems.settings ?? problems.node ?? problems.contract;
  const text = error ?? problems.wallet ?? page.chainProblem;
  setShown(notice, text !== undefined);
  setText(notice, text ?? "");
  notice.className = `notice notice-${error === undefined ? "warning" : "error"}`;
}

const rpc = rpcUrlFrom(window.location.search);
const page: Page = {
  reader: createReader(rpc.ok ? rpc.url : DEFAULT_RPC_URL),
  rpcUrl: rpc.ok ? rpc.url : DEFAULT_RPC_URL,
  wallet: findWallet(),
  trigger: undefined,
  session: NO_SESSION,
  nodeChainId: undefined,
  chainProblem: undefined,
  latest: undefined,
  requestRefresh: () => void refresh(),
};

// ---------------------------------------------------------------------------
// Controls that depend on the wallet and the contract.
// ---------------------------------------------------------------------------

function updateControls(): void {
  const connect = byId<HTMLButtonElement>("connect");
  if (page.wallet === undefined) {
    connect.disabled = true;
    setText(byId("connect-label"), "No wallet found in this browser");
  } else {
    connect.disabled = false;
    setText(
      byId("connect-label"),
      page.session.account === undefined ? "Connect wallet" : "Connected",
    );
  }
  const account = page.session.account;
  setText(
    byId("wallet-status"),
    account === undefined
      ? "Not connected"
      : `${shortAddress(account)} · chain ${page.session.walletChainId ?? "?"}`,
  );
  byId("wallet-status").title = account ?? "";
  const blocker = sendBlocker(page);
  const submit = byId<HTMLButtonElement>("order-submit");
  submit.disabled = blocker !== undefined || isPlacing();
  setText(byId("order-hint"), blocker ?? "");
  updateTierControls(page);
  redrawOrders(page, createdOrders());
}

// ---------------------------------------------------------------------------
// Refreshing.
// ---------------------------------------------------------------------------

let refreshing = false;
let refreshAgain = false;

async function refreshOnce(): Promise<void> {
  if (page.trigger === undefined) return;
  try {
    const block = await page.reader.getBlock({ blockTag: "latest" });
    page.latest = { number: block.number, time: block.timestamp };
  } catch {
    problems.node = `The local node at ${page.rpcUrl} does not answer. Start it with npx hardhat node.`;
    renderNotice();
    return;
  }
  if (problems.node !== undefined) {
    problems.node = undefined;
    renderNotice();
  }
  await refreshMetrics(page);
  let pulled;
  try {
    pulled = await pullEvents(page);
  } catch {
    pulled = { filled: [], restarted: false };
  }
  if (pulled.restarted && page.trigger !== undefined) {
    // The node was restarted: what was read belongs to the old chain.
    void loadContract(page.trigger.address);
    return;
  }
  renderFeed(feedEntries());
  await refreshOrders(page, createdOrders(), pulled.filled);
}

/** Refreshes everything; calls that come in meanwhile run once afterwards. */
async function refresh(): Promise<void> {
  if (document.visibilityState !== "visible") return;
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      await refreshOnce();
      updateControls();
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}

function startWatching(): void {
  page.reader.watchBlockNumber({
    onBlockNumber: () => void refresh(),
    onError: () => undefined,
    poll: true,
  });
  window.setInterval(() => void refresh(), FALLBACK_REFRESH_MS);
  document.addEventListener("visibilitychange", () => void refresh());
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

/** The line of the contract's limits, shown while a contract is loaded. */
function showLimits(): void {
  const line = byId("contract-limits");
  const trigger = page.trigger;
  setShown(line, trigger !== undefined);
  setText(
    line,
    trigger === undefined
      ? ""
      : limitsText(trigger.limits, trigger.decimals.usdc),
  );
}

async function loadContract(text: string): Promise<void> {
  resetEvents();
  resetAllOrders();
  renderFeed([]);
  const result = await loadTrigger(page.reader, text);
  if (!result.ok) {
    page.trigger = undefined;
    showLimits();
    resetMetrics();
    problems.contract = result.message;
    renderNotice();
    updateControls();
    return;
  }
  page.trigger = result.trigger;
  showLimits();
  remember(CONTRACT_KEY, result.trigger.address);
  byId<HTMLInputElement>("contract-input").value = result.trigger.address;
  problems.contract = undefined;
  renderNotice();
  updateControls();
  await refresh();
}

byId("contract-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadContract(byId<HTMLInputElement>("contract-input").value);
});

// ---------------------------------------------------------------------------
// The wallet.
// ---------------------------------------------------------------------------

function applyResets(resets: readonly ResetName[]): void {
  if (resets.includes(Reset.MyBalances)) resetMyBalances();
  if (resets.includes(Reset.FormMessage)) resetOrderMessage();
  if (resets.includes(Reset.MyOrders)) resetMyOrders();
  if (resets.includes(Reset.RowMessages)) resetRowMessages();
  // Reset.LookupOwnership: the next redraw marks the looked-up order with
  // the new account (updateControls below redraws it).
}

function applyAccounts(accounts: readonly unknown[]): void {
  const { session, resets } = accountsChanged(page.session, accounts);
  page.session = session;
  applyResets(resets);
  updateControls();
  if (resets.length > 0) void refresh();
}

async function checkWalletChain(chainId?: unknown): Promise<void> {
  const wallet = page.wallet;
  if (wallet === undefined) return;
  try {
    const reported = chainId ?? (await walletChainId(wallet));
    page.session = chainChanged(page.session, reported).session;
    page.nodeChainId ??= await page.reader.getChainId();
    const check = checkChain(page.session.walletChainId, page.nodeChainId);
    page.chainProblem = check.ok ? undefined : check.message;
  } catch {
    page.chainProblem =
      "The wallet's chain or the local node's chain could not be read.";
  }
  renderNotice();
  updateControls();
}

async function connect(): Promise<void> {
  const wallet = page.wallet;
  if (wallet === undefined) return;
  try {
    applyAccounts(await requestAccounts(wallet));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    problems.wallet =
      code === 4001
        ? "You did not connect the wallet."
        : "The wallet did not connect.";
    renderNotice();
    return;
  }
  problems.wallet = undefined;
  await checkWalletChain();
}

byId("connect").addEventListener("click", () => void connect());

if (page.wallet !== undefined) {
  watchWallet(
    page.wallet,
    (accounts) => applyAccounts(accounts),
    (chainId) => {
      if (chainChanged(page.session, chainId).recheck) {
        void checkWalletChain(chainId);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Start.
// ---------------------------------------------------------------------------

initOrderForm(page, updateControls);
initOrders(page);

updateControls();
if (!rpc.ok) {
  problems.settings = rpc.message;
  renderNotice();
} else {
  const fromAddress = new URLSearchParams(window.location.search).get(
    "contract",
  );
  const start = fromAddress ?? remembered(CONTRACT_KEY);
  if (start !== undefined && start !== "") {
    byId<HTMLInputElement>("contract-input").value = start;
    void loadContract(start);
  }
  startWatching();
}
