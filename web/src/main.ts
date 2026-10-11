// Entry point of the web page: builds the page, loads the contract, connects
// the wallet and keeps everything up to date.
//
// Every read goes to the local node (http://127.0.0.1:8545 unless the
// address bar names another loopback node with ?rpc=). The wallet only gives
// the account and signs transactions. The page refreshes on every new block
// and, as a fallback, every 2 seconds, but only while it is visible.

import { createReader, loadTrigger } from "./chain.ts";
import { byId, remember, remembered, setShown, setText } from "./dom.ts";
import { shortAddress } from "./lib/format.ts";
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
import { refreshMetrics, resetMyBalances } from "./metrics.ts";
import { initOrderForm, isPlacing, resetOrderMessage } from "./orderForm.ts";
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

/** Shows a sentence under the contract and wallet bar, or hides it. */
function showNotice(text: string | undefined, tone = "warning"): void {
  setShown(notice, text !== undefined);
  setText(notice, text ?? "");
  notice.className = `notice notice-${tone}`;
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
    showNotice(
      `The local node at ${page.rpcUrl} does not answer. Start it with npx hardhat node.`,
      "error",
    );
    return;
  }
  await refreshMetrics(page);
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

async function loadContract(text: string): Promise<void> {
  const result = await loadTrigger(page.reader, text);
  if (!result.ok) {
    page.trigger = undefined;
    showNotice(result.message, "error");
    updateControls();
    return;
  }
  page.trigger = result.trigger;
  remember(CONTRACT_KEY, result.trigger.address);
  byId<HTMLInputElement>("contract-input").value = result.trigger.address;
  showNotice(page.chainProblem);
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
  showNotice(page.chainProblem);
  updateControls();
}

async function connect(): Promise<void> {
  const wallet = page.wallet;
  if (wallet === undefined) return;
  try {
    applyAccounts(await requestAccounts(wallet));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    showNotice(
      code === 4001
        ? "You did not connect the wallet."
        : "The wallet did not connect.",
    );
    return;
  }
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

updateControls();
if (!rpc.ok) {
  showNotice(rpc.message, "error");
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
