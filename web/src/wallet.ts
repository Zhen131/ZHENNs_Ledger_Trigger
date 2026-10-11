// The wallet (`window.ethereum`, such as MetaMask) does two things only: it
// says which account is connected, and it signs and sends transactions.
// Everything the page reads comes from the local node instead (chain.ts).

import {
  createWalletClient,
  custom,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

import { POLLING_MS } from "./chain.ts";

/** The part of an EIP-1193 wallet the page uses. */
export type WalletProvider = {
  request(args: {
    readonly method: string;
    readonly params?: unknown;
  }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
};

/** The browser's wallet, or undefined when there is none. */
export function findWallet(): WalletProvider | undefined {
  const candidate = (window as unknown as { ethereum?: unknown }).ethereum;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "request" in candidate &&
    typeof candidate.request === "function"
  ) {
    return candidate as WalletProvider;
  }
  return undefined;
}

/** Asks the wallet to connect; resolves with the accounts it gives. */
export async function requestAccounts(
  wallet: WalletProvider,
): Promise<readonly unknown[]> {
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  return Array.isArray(accounts) ? accounts : [];
}

/** The wallet's chain ID, as the wallet reports it. */
export function walletChainId(wallet: WalletProvider): Promise<unknown> {
  return wallet.request({ method: "eth_chainId" });
}

/** Calls `onAccounts` and `onChain` when the user switches in the wallet. */
export function watchWallet(
  wallet: WalletProvider,
  onAccounts: (accounts: readonly unknown[]) => void,
  onChain: (chainId: unknown) => void,
): void {
  wallet.on?.("accountsChanged", (accounts) => {
    onAccounts(Array.isArray(accounts) ? accounts : []);
  });
  wallet.on?.("chainChanged", (chainId) => onChain(chainId));
}

let client: WalletClient | undefined;

function walletClient(wallet: WalletProvider): WalletClient {
  client ??= createWalletClient({
    transport: custom(wallet),
    pollingInterval: POLLING_MS,
    ccipRead: false,
  });
  return client;
}

/** Has the wallet sign and send a contract call from `account`. */
export function sendCall(
  wallet: WalletProvider,
  account: Address,
  call: {
    readonly address: Address;
    readonly abi: Abi;
    readonly functionName: string;
    readonly args: readonly unknown[];
  },
): Promise<Hex> {
  return walletClient(wallet).writeContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    account,
    chain: null,
  });
}
