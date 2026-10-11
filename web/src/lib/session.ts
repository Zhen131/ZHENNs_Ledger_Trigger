// Who "me" is and which chain the wallet is on, and what the page must read
// again when either changes.
//
// When the wallet switches to another account, everything that belongs to
// the old account is stale: its order list, its balance and allowance,
// whether the looked-up order is "not yours", and the messages shown under
// the rows and the form. When the wallet switches chains, the chain check is
// done again.

import { getAddress, isAddress, type Address } from "viem";

export type Session = {
  /** The connected account, or undefined when none is connected. */
  readonly account: Address | undefined;
  /** The wallet's chain ID, or undefined before it was asked. */
  readonly walletChainId: number | undefined;
};

export const NO_SESSION: Session = {
  account: undefined,
  walletChainId: undefined,
};

/** What the page clears and reads again. Each value names one part. */
export const Reset = {
  MyOrders: "my-orders",
  MyBalances: "my-balances",
  LookupOwnership: "lookup-ownership",
  RowMessages: "row-messages",
  FormMessage: "form-message",
} as const;

export type ResetName = (typeof Reset)[keyof typeof Reset];

/** Every part that belongs to the connected account. */
export const ACCOUNT_RESETS: readonly ResetName[] = [
  Reset.MyOrders,
  Reset.MyBalances,
  Reset.LookupOwnership,
  Reset.RowMessages,
  Reset.FormMessage,
];

function sameAccount(a: Address | undefined, b: Address | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The session after the wallet reports `accounts` (from
 * `eth_requestAccounts` or an `accountsChanged` event): the first account,
 * or none when the list is empty or the first entry is not an address; and
 * the parts to reset, which is every part of ACCOUNT_RESETS when the account
 * changed and none when it stayed the same.
 */
export function accountsChanged(
  session: Session,
  accounts: readonly unknown[],
): { readonly session: Session; readonly resets: readonly ResetName[] } {
  const first = accounts[0];
  const account =
    typeof first === "string" && isAddress(first, { strict: false })
      ? getAddress(first)
      : undefined;
  const resets = sameAccount(session.account, account) ? [] : ACCOUNT_RESETS;
  return { session: { ...session, account }, resets };
}

/**
 * The session after the wallet reports chain `chainId` (a hex string such as
 * "0x7a69", or a number). `recheck` is true when the chain is new or could
 * not be read, so the chain check must be done again.
 */
export function chainChanged(
  session: Session,
  chainId: unknown,
): { readonly session: Session; readonly recheck: boolean } {
  const parsed =
    typeof chainId === "number"
      ? chainId
      : typeof chainId === "string" && /^0x[0-9a-fA-F]+$/.test(chainId)
        ? Number.parseInt(chainId, 16)
        : undefined;
  return {
    session: { ...session, walletChainId: parsed },
    recheck: parsed === undefined || parsed !== session.walletChainId,
  };
}

export type ChainCheck =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Whether the wallet's chain is the node's chain, and if not what to say. */
export function checkChain(
  walletChainId: number | undefined,
  nodeChainId: number,
): ChainCheck {
  if (walletChainId === nodeChainId) return { ok: true };
  const wallet =
    walletChainId === undefined ? "an unknown chain" : `chain ${walletChainId}`;
  return {
    ok: false,
    message: `Your wallet is on ${wallet}, but the local node is chain ${nodeChainId}. Switch the wallet to the local network to send transactions.`,
  };
}
