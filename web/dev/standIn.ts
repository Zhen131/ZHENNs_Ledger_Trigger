// A stand-in for a browser wallet, for development and checks only. It is
// loaded by dev.html and never by the real page, and it is not part of the
// build.
//
// It answers the page's wallet requests (EIP-1193 `request`) by passing them
// on to the local Hardhat node. The node signs transactions itself with its
// own unlocked test accounts, so the stand-in holds no private key at all.
//
// - `eth_requestAccounts` connects test account N of the node (`?account=N`,
//   default 0); `eth_accounts` returns it once connected, nothing before.
// - `eth_sendTransaction` is passed to the node with `from` set to that
//   account, or refused with code 4001 ("the user rejected it") when the
//   address bar has `?reject=1`.
// - `wallet_*` methods are refused as not supported; every other method is
//   passed to the node as it is.
// - `?switchTo=N`: 3 seconds after connecting, it switches to test account N
//   and tells the page through an `accountsChanged` event, as a wallet does
//   when the user picks another account.
// - It only talks to a node on this computer (`?rpc=`, loopback addresses
//   only), and refuses to work when the node is not Hardhat's local chain
//   (chain ID 31337).
// - It records the name of every method it is asked for, in `calls`, so a
//   check can tell whether the page sent a transaction.

import { rpcUrlFrom } from "../src/lib/loopback.ts";

/** Marks the stand-in. A check searches the build for this text: it must not be there. */
export const STAND_IN_MARK = "local-node-stand-in";

const LOCAL_CHAIN_ID = 31337;
const SWITCH_DELAY_MS = 3000;

/** EIP-1193 error codes. */
const USER_REJECTED = 4001;
const UNAUTHORIZED = 4100;
const UNSUPPORTED_METHOD = 4200;
const DISCONNECTED = 4900;

export type StandInOptions = {
  readonly rpcUrl: string;
  readonly accountIndex: number;
  readonly reject: boolean;
  /** Test account to switch to 3 seconds after connecting, if any. */
  readonly switchTo: number | undefined;
};

type Listener = (...args: unknown[]) => void;

export type StandIn = {
  readonly isLocalNodeStandIn: true;
  /** Every method asked for, in order. */
  readonly calls: string[];
  request(args: {
    readonly method: string;
    readonly params?: unknown;
  }): Promise<unknown>;
  on(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
  /** Resolves when the node is Hardhat's local chain; rejects with why not. */
  checkChain(): Promise<void>;
};

function accountNumber(text: string | null, name: string): number | undefined {
  if (text === null) return undefined;
  if (!/^\d+$/.test(text) || Number(text) > 19) {
    throw new Error(`${name} must be a test account number from 0 to 19.`);
  }
  return Number(text);
}

/** The stand-in's settings from the page's query string, or why they are wrong. */
export function standInOptionsFrom(
  search: string,
):
  | { readonly ok: true; readonly options: StandInOptions }
  | { readonly ok: false; readonly message: string } {
  const rpc = rpcUrlFrom(search);
  if (!rpc.ok) return rpc;
  const query = new URLSearchParams(search);
  try {
    return {
      ok: true,
      options: {
        rpcUrl: rpc.url,
        accountIndex: accountNumber(query.get("account"), "account") ?? 0,
        reject: query.get("reject") === "1",
        switchTo: accountNumber(query.get("switchTo"), "switchTo"),
      },
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function providerError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, data });
}

/** A new stand-in. Nothing is sent to the node until the page asks. */
export function createStandIn(options: StandInOptions): StandIn {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  let account: string | undefined;
  let nextId = 1;
  let chainChecked: Promise<void> | undefined;

  async function node(method: string, params: unknown): Promise<unknown> {
    const response = await fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params: params ?? [],
      }),
    });
    const body = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error !== undefined) {
      throw providerError(body.error.code, body.error.message, body.error.data);
    }
    return body.result;
  }

  function checkChain(): Promise<void> {
    chainChecked ??= (async () => {
      const id = Number.parseInt(String(await node("eth_chainId", [])), 16);
      if (id !== LOCAL_CHAIN_ID) {
        throw providerError(
          DISCONNECTED,
          `The ${STAND_IN_MARK} wallet only works with Hardhat's local chain (${LOCAL_CHAIN_ID}); this node is chain ${id}.`,
        );
      }
    })();
    return chainChecked;
  }

  async function testAccount(index: number): Promise<string> {
    const accounts = (await node("eth_accounts", [])) as string[];
    const found = accounts[index];
    if (found === undefined) {
      throw providerError(
        UNAUTHORIZED,
        `The node has no test account #${index}.`,
      );
    }
    return found;
  }

  function emit(event: string, ...args: unknown[]): void {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  }

  function scheduleSwitch(): void {
    const target = options.switchTo;
    if (target === undefined) return;
    setTimeout(() => {
      testAccount(target).then(
        (next) => {
          account = next;
          emit("accountsChanged", [next]);
        },
        () => undefined,
      );
    }, SWITCH_DELAY_MS);
  }

  async function request(args: {
    readonly method: string;
    readonly params?: unknown;
  }): Promise<unknown> {
    const { method, params } = args;
    calls.push(method);
    if (method.startsWith("wallet_")) {
      throw providerError(
        UNSUPPORTED_METHOD,
        `${method} is not supported by the stand-in wallet.`,
      );
    }
    await checkChain();
    switch (method) {
      case "eth_requestAccounts": {
        const first = account === undefined;
        account ??= await testAccount(options.accountIndex);
        if (first) scheduleSwitch();
        return [account];
      }
      case "eth_accounts":
        return account === undefined ? [] : [account];
      case "eth_sendTransaction": {
        if (account === undefined) {
          throw providerError(UNAUTHORIZED, "Connect the wallet first.");
        }
        if (options.reject) {
          throw providerError(USER_REJECTED, "User rejected the request.");
        }
        const [transaction] = (params ?? []) as [Record<string, unknown>];
        return node("eth_sendTransaction", [{ ...transaction, from: account }]);
      }
      default:
        return node(method, params);
    }
  }

  return {
    isLocalNodeStandIn: true,
    calls,
    request,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    checkChain,
  };
}
