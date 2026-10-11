// What every part of the page shares: the node reader, the wallet, the
// contract once loaded, who is connected, and whether sending is possible.

import type { PublicClient } from "viem";

import type { Trigger } from "./chain.ts";
import type { Session } from "./lib/session.ts";
import type { WalletProvider } from "./wallet.ts";

export type Page = {
  readonly reader: PublicClient;
  readonly rpcUrl: string;
  /** The browser's wallet, or undefined when it has none. */
  readonly wallet: WalletProvider | undefined;
  trigger: Trigger | undefined;
  session: Session;
  /** The node's chain ID, once read. */
  nodeChainId: number | undefined;
  /** Why the wallet's chain cannot be used, or undefined when it can. */
  chainProblem: string | undefined;
  /** The latest block, as of the last refresh. */
  latest: { readonly number: bigint; readonly time: bigint } | undefined;
  /** Asks for a refresh of everything, as soon as possible. */
  requestRefresh(): void;
};

/** Why the page cannot send a transaction now, or undefined when it can. */
export function sendBlocker(page: Page): string | undefined {
  if (page.wallet === undefined) return "No wallet found in this browser";
  if (page.session.account === undefined) return "Connect your wallet first";
  if (page.chainProblem !== undefined) {
    return "The wallet is not on the local chain";
  }
  if (page.trigger === undefined) return "Load the contract first";
  return undefined;
}
