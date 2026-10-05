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
// - A connection to Hardhat's in-process simulated chain passes. That chain
//   lives in this process only; nothing sent to it leaves the machine.
// - A request that only reads (READ_ONLY_METHODS) passes.
// - Anything else (sending a transaction or a deployment, signing, the
//   hardhat_ and evm_ methods that change a node's state, any method not in
//   the list) passes only when the connection's chain is Hardhat's local
//   chain (`isLocalChain`, the send gate's own rule), or when, in this
//   process, the send gate has already let a deployment or operation script
//   send on that chain (`gateConfirmedChain`). Otherwise it is refused with
//   an error that says why, and nothing is sent.
//
// The chain ID comes from the connection's configuration when it sets one
// (`sepolia` does); otherwise the node is asked once per connection with
// `eth_chainId`, which reads only. The keeper does not use Hardhat's network
// connections, so this guard does not touch it.

import { HardhatPluginError } from "hardhat/plugins";
import type { HookContext, NetworkHooks } from "hardhat/types/hooks";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";

import {
  LOCAL_CHAIN_ID,
  gateConfirmedChain,
  isLocalChain,
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
  return `Refused ${method} on network "${networkName}", chain ${chainId}: transactions go to Hardhat's local chain (chain ID ${LOCAL_CHAIN_ID}) only, unless a deployment or operation script has passed its send gate for that chain. Nothing was sent. To run the tests, select no network: no --network and no HARDHAT_NETWORK environment variable.`;
}

type Connection = NetworkConnection<string>;
type Next = (
  context: HookContext,
  connection: Connection,
  request: JsonRpcRequest,
) => Promise<JsonRpcResponse>;

/** The chain ID of each connection whose configuration sets none. */
const askedChainIds = new WeakMap<object, Promise<number>>();

function chainIdOf(
  context: HookContext,
  connection: Connection,
  next: Next,
): Promise<number> {
  const configured = connection.networkConfig.chainId;
  if (configured !== undefined) return Promise.resolve(configured);
  let known = askedChainIds.get(connection);
  if (known === undefined) {
    known = next(context, connection, {
      jsonrpc: "2.0",
      id: "network-guard-chain-id",
      method: "eth_chainId",
      params: [],
    }).then((response) => {
      if (!("result" in response) || typeof response.result !== "string") {
        throw new HardhatPluginError(
          NETWORK_GUARD_ID,
          `The node of network "${connection.networkName}" did not report its chain ID, so nothing was sent.`,
        );
      }
      return Number(response.result);
    });
    askedChainIds.set(connection, known);
  }
  return known;
}

/** The network hook: see the top of this file. */
async function onRequest(
  context: HookContext,
  connection: Connection,
  request: JsonRpcRequest,
  next: Next,
): Promise<JsonRpcResponse> {
  if (connection.networkConfig.type === "edr-simulated") {
    return next(context, connection, request);
  }
  if (READ_ONLY_METHODS.has(request.method)) {
    return next(context, connection, request);
  }
  const chainId = await chainIdOf(context, connection, next);
  if (isLocalChain(chainId) || gateConfirmedChain(chainId)) {
    return next(context, connection, request);
  }
  throw new HardhatPluginError(
    NETWORK_GUARD_ID,
    refusalReason(request.method, connection.networkName, chainId),
  );
}

export default async (): Promise<Partial<NetworkHooks>> => ({
  onRequest: onRequest as NetworkHooks["onRequest"],
});
