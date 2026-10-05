// The network guard: keeps everything in this repository that talks to a
// chain through Hardhat's network connections, the tests above all, from
// sending transactions to any chain but Hardhat's local one.
//
// hardhat.config.ts loads this file as a Hardhat network hook. Hardhat calls
// `onRequest` for every JSON-RPC request on every network connection, however
// the code was started: `npx hardhat test`, `npm run check`, `node --test`,
// `node <file>`, `npx hardhat run <file>`, with the network chosen by
// `--network` or by the HARDHAT_NETWORK environment variable. So this is the
// one place that stops them all.
//
// The rule, for each request:
//
// - OPEN_GATE_METHOD, sent by the send gate's `openSendGate`, is answered here
//   and never reaches a node (see `openConnection`).
// - A connection to Hardhat's in-process simulated chain passes. That chain
//   lives in this process only; nothing sent to it leaves the machine.
// - A request that only reads (READ_ONLY_METHODS) passes.
// - Anything else (sending a transaction or a deployment, signing, the
//   hardhat_ and evm_ methods that change a node's state, any method not in
//   the list) is decided by `mayWrite`: it passes only when the connection's
//   chain is Hardhat's local chain (`isLocalChain`, the send gate's own rule),
//   or when the send gate has opened this very connection for the chain its
//   node serves now. Otherwise it is refused with an error that says why,
//   and nothing is sent.
//
// The guard keeps the opened connections itself, by connection object, in a
// WeakMap no other module can reach. A connection is opened only here, only
// for a single-use token the send gate issued after deciding, and only when
// the connection's own node then reports the chain the gate decided on.
// Opening one connection opens no other, not even one to the same chain.
//
// Chain IDs: when a connection's configuration sets a chain that is not local
// (`sepolia` does), a request on a connection the gate has not opened is
// refused on that alone, without contacting the node. In every other case the
// node is asked with `eth_chainId` (it only reads) before each request that is
// not a read, so a node swapped behind a connection is noticed, and a
// configuration that claims the local chain is not taken on trust. Hardhat's
// own chain ID check on networks that set one stays in place behind this.
//
// The keeper does not use Hardhat's network connections, so this guard does
// not touch it.

import { HardhatPluginError } from "hardhat/plugins";
import type { HookContext, NetworkHooks } from "hardhat/types/hooks";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";

import {
  LOCAL_CHAIN_ID,
  OPEN_GATE_METHOD,
  isLocalChain,
  redeemSendGateToken,
} from "./sendGate.ts";

/** Shown as the source of the error when the guard refuses a request. */
export const NETWORK_GUARD_ID = "local-only-transactions";

/** JSON-RPC methods that only read, and pass on any chain. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_accounts",
  "eth_blobBaseFee",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
  "net_listening",
  "net_peerCount",
  "net_version",
  "web3_clientVersion",
]);

/** Why a request was refused, in this project's own words. */
export function refusalReason(
  method: string,
  networkName: string,
  chainId: number,
): string {
  return `Refused ${method} on network "${networkName}", chain ${chainId}: transactions go to Hardhat's local chain (chain ID ${LOCAL_CHAIN_ID}) only, unless a deployment or operation script has passed its send gate on this very connection. Nothing was sent. To run the tests, select no network: no --network and no HARDHAT_NETWORK environment variable.`;
}

type Connection = NetworkConnection<string>;
type Next = (
  context: HookContext,
  connection: Connection,
  request: JsonRpcRequest,
) => Promise<JsonRpcResponse>;

/** The connections the send gate has opened, with the chain each was opened for. */
const openedConnections = new WeakMap<object, number>();

/** Asks the connection's node for its chain ID, now. It only reads. */
async function askChainId(
  context: HookContext,
  connection: Connection,
  next: Next,
): Promise<number> {
  const response = await next(context, connection, {
    jsonrpc: "2.0",
    id: "network-guard-chain-id",
    method: "eth_chainId",
    params: [],
  });
  if (!("result" in response) || typeof response.result !== "string") {
    throw new HardhatPluginError(
      NETWORK_GUARD_ID,
      `The node of network "${connection.networkName}" did not report its chain ID, so nothing was sent.`,
    );
  }
  return Number(response.result);
}

export type WriteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly chainId: number };

/**
 * Whether a request that is not a read may go out on a connection that is
 * not in-process. `configuredChainId` is the chain its configuration sets, if
 * any; `openedChainId` the chain the send gate opened it for, if it did;
 * `askChainId` asks its node now.
 */
export async function mayWrite(input: {
  readonly configuredChainId: number | undefined;
  readonly openedChainId: number | undefined;
  readonly askChainId: () => Promise<number>;
}): Promise<WriteDecision> {
  const { configuredChainId, openedChainId } = input;
  if (configuredChainId !== undefined && !isLocalChain(configuredChainId)) {
    if (openedChainId !== configuredChainId) {
      return { allowed: false, chainId: configuredChainId };
    }
  }
  const chainId = await input.askChainId();
  if (isLocalChain(chainId)) return { allowed: true };
  if (openedChainId !== undefined && openedChainId === chainId) {
    return { allowed: true };
  }
  return { allowed: false, chainId };
}

/**
 * Answers OPEN_GATE_METHOD: opens `connection` when the token is one the send
 * gate issued and has not been used, and the connection's node serves the
 * chain the gate decided on. Throws, opening nothing, otherwise.
 */
async function openConnection(
  context: HookContext,
  connection: Connection,
  request: JsonRpcRequest,
  next: Next,
): Promise<JsonRpcResponse> {
  const params: unknown = request.params;
  const token = Array.isArray(params) ? params[0] : undefined;
  const decidedChainId = redeemSendGateToken(token);
  if (decidedChainId === undefined) {
    throw new HardhatPluginError(
      NETWORK_GUARD_ID,
      "The send gate did not issue this request, so nothing was opened.",
    );
  }
  const chainId =
    connection.networkConfig.type === "edr-simulated"
      ? connection.networkConfig.chainId
      : await askChainId(context, connection, next);
  if (chainId !== decidedChainId) {
    throw new HardhatPluginError(
      NETWORK_GUARD_ID,
      `The send gate decided on chain ${decidedChainId}, but network "${connection.networkName}" serves chain ${chainId}, so nothing was opened.`,
    );
  }
  openedConnections.set(connection, chainId);
  return { jsonrpc: "2.0", id: request.id, result: true };
}

/** The network hook: see the top of this file. */
async function onRequest(
  context: HookContext,
  connection: Connection,
  request: JsonRpcRequest,
  next: Next,
): Promise<JsonRpcResponse> {
  if (request.method === OPEN_GATE_METHOD) {
    return openConnection(context, connection, request, next);
  }
  if (connection.networkConfig.type === "edr-simulated") {
    return next(context, connection, request);
  }
  if (READ_ONLY_METHODS.has(request.method)) {
    return next(context, connection, request);
  }
  const decision = await mayWrite({
    configuredChainId: connection.networkConfig.chainId,
    openedChainId: openedConnections.get(connection),
    askChainId: () => askChainId(context, connection, next),
  });
  if (decision.allowed) return next(context, connection, request);
  throw new HardhatPluginError(
    NETWORK_GUARD_ID,
    refusalReason(request.method, connection.networkName, decision.chainId),
  );
}

export default async (): Promise<Partial<NetworkHooks>> => ({
  onRequest: onRequest as NetworkHooks["onRequest"],
});
