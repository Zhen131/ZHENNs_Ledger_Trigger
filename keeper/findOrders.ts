// Finds the orders that name a given executor, from the contract's
// `OrderCreated` events. The event indexes the executor, so the node filters
// by it. The contract keeps no list of orders per executor, and the keeper
// stores nothing between rounds, so every round reads the events again.
//
// Many node services limit how many blocks one event request may span, so the
// blocks are read in pieces of at most `maxBlockRange` blocks.

import type { Address, Chain, PublicClient, Transport } from "viem";

import type { LedgerTriggerAbi } from "./abi.ts";

export type FindOrdersInput = {
  readonly publicClient: PublicClient<Transport, Chain | undefined>;
  readonly abi: LedgerTriggerAbi;
  readonly contractAddress: Address;
  readonly executor: Address;
  /** First block to read, inclusive. */
  readonly fromBlock: bigint;
  /** Last block to read, inclusive. */
  readonly toBlock: bigint;
  /** Most blocks per request; at least 1. */
  readonly maxBlockRange: bigint;
};

/** The block ranges, inclusive at both ends, that cover `from` to `to`. */
export function blockRanges(
  from: bigint,
  to: bigint,
  maxBlockRange: bigint,
): (readonly [bigint, bigint])[] {
  if (maxBlockRange < 1n)
    throw new RangeError("maxBlockRange must be at least 1");
  const ranges: (readonly [bigint, bigint])[] = [];
  for (let start = from; start <= to; start += maxBlockRange) {
    const end = start + maxBlockRange - 1n;
    ranges.push([start, end < to ? end : to]);
  }
  return ranges;
}

/** IDs of the orders whose executor is `executor`, oldest first. */
export async function findOrders(input: FindOrdersInput): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (const [fromBlock, toBlock] of blockRanges(
    input.fromBlock,
    input.toBlock,
    input.maxBlockRange,
  )) {
    const events = await input.publicClient.getContractEvents({
      address: input.contractAddress,
      abi: input.abi,
      eventName: "OrderCreated",
      args: { executor: input.executor },
      fromBlock,
      toBlock,
      strict: true,
    });
    for (const event of events) ids.push(event.args.orderId);
  }
  return ids;
}
