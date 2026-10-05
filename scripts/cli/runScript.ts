// What every entry point in this folder does around its own work: connect to
// the network Hardhat was asked for (`--network`, or the in-process local
// chain by default), run the work, print its lines, and set the exit code.
//
// When the work fails, it prints one line from `describeFailure`, which never
// holds a library's own message (that could hold the node URL), and exits
// with 1. The node URL and the private key are never printed.

import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { describeFailure } from "../scriptError.ts";

type Viem = NetworkConnection["viem"];

/** What a piece of work returns: lines to print, and whether all went well. */
export type Outcome = {
  readonly lines: readonly string[];
  readonly ok: boolean;
};

/** Runs `work` on the selected network and sets `process.exitCode`. */
export async function runScript(
  work: (viem: Viem) => Promise<Outcome>,
): Promise<void> {
  try {
    const connection = await network.getOrCreate();
    console.log(`Network: ${connection.networkName}`);
    const outcome = await work(connection.viem);
    for (const line of outcome.lines) console.log(line);
    process.exitCode = outcome.ok ? 0 : 1;
  } catch (error) {
    console.error(describeFailure(error));
    process.exitCode = 1;
  }
}
