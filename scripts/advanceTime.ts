// Moves the clock of Hardhat's local chain forward, for trying out
// time-scheduled orders without waiting: it mines one block whose time is
// TRIGGER_ADVANCE_SECONDS after the latest block's, and every block after it
// follows on from there.
//
// It reads one environment variable: TRIGGER_ADVANCE_SECONDS (required), the
// number of seconds, a whole number of at least 1. It reads no contract
// address and touches no contract.
//
// Runs on Hardhat's local chain only. It passes the send gate before it asks
// the node to change anything, and the gate refuses every other chain,
// whatever the confirmation variable holds. Behind the gate, the network guard
// refuses these requests on any connection to another chain that the gate
// has not opened, and the gate never opens one for this script.
//
// The block is made the way Hardhat's own `time.increase` helper makes it:
// the next block's time is set to the latest block's time plus the seconds
// asked for (evm_setNextBlockTimestamp), then one block is mined (evm_mine).
// Both requests go through the script's own public client, over the network
// connection Hardhat was asked for.

import type { NetworkConnection } from "hardhat/types/network";
import { numberToHex } from "viem";

import { parseWhole } from "./amounts.ts";
import { scriptClients } from "./clients.ts";
import { GatedScript, openSendGate } from "./sendGate.ts";
import { VARIABLES, requireText, type Environment } from "./settings.ts";

type Viem = NetworkConnection["viem"];

export type AdvanceTimeSettings = {
  /** Seconds to move the clock forward. */
  readonly seconds: bigint;
};

/** The settings of advance-time, from `env`. TRIGGER_ADVANCE_SECONDS is required. */
export function advanceTimeSettingsFrom(env: Environment): AdvanceTimeSettings {
  return {
    seconds: parseWhole(
      requireText(env, VARIABLES.advanceSeconds),
      1n,
      VARIABLES.advanceSeconds,
    ),
  };
}

/** A block's number and time. */
export type BlockTime = {
  readonly number: bigint;
  readonly timestamp: bigint;
};

export type TimeAdvanced = {
  /** The seconds asked for. */
  readonly seconds: bigint;
  /** The latest block before and after. */
  readonly before: BlockTime;
  readonly after: BlockTime;
};

type PublicClient = Awaited<ReturnType<typeof scriptClients>>["publicClient"];

/** The latest block's number and time. */
async function latestBlock(publicClient: PublicClient): Promise<BlockTime> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return { number: block.number, timestamp: block.timestamp };
}

/** Moves the clock forward. Passes the send gate first. */
export async function advanceTime(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: AdvanceTimeSettings;
}): Promise<TimeAdvanced> {
  const { publicClient } = await scriptClients(input.viem);
  await openSendGate(publicClient, GatedScript.AdvanceTime, input.confirmation);
  const before = await latestBlock(publicClient);
  await publicClient.request({
    method: "evm_setNextBlockTimestamp",
    params: [numberToHex(before.timestamp + input.settings.seconds)],
  } as never);
  await publicClient.request({ method: "evm_mine", params: [] } as never);
  const after = await latestBlock(publicClient);
  return { seconds: input.settings.seconds, before, after };
}

/** A block's number and time as text. */
function describeBlock(block: BlockTime): string {
  return `block ${block.number} at ${new Date(Number(block.timestamp) * 1000).toISOString()} (Unix ${block.timestamp})`;
}

/** The result as lines to print. */
export function formatTimeAdvanced(result: TimeAdvanced): string[] {
  return [
    `Moved the local chain's clock forward by ${result.seconds} seconds.`,
    `  before  ${describeBlock(result.before)}`,
    `  after   ${describeBlock(result.after)}`,
    `  the new block's time is ${result.after.timestamp - result.before.timestamp} seconds after the block before it`,
  ];
}
