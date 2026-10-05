// Waits until a transaction the scripts sent is in a block, and stops the
// script when the chain reports it as failed.

import type { Hash, PublicClient } from "viem";

import { ScriptError } from "./scriptError.ts";

/** The receipt of `hash`; throws a `ScriptError` when it failed on chain. */
export async function mined(
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  hash: Hash,
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new ScriptError(`Transaction ${hash} failed on chain.`);
  }
  return receipt;
}
