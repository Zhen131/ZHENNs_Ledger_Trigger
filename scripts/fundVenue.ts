// Sends ETH to the swap venue of a deployed LedgerTrigger, from the first
// account of the network connection. The swap venue pays fills out of this
// ETH. Its address is read from LedgerTrigger, so it cannot be mistyped.
//
// The mock swap venue is open to everyone: anyone can swap test USDC for the
// ETH it holds. On a test network, send only what the next demo needs.

import type { NetworkConnection } from "hardhat/types/network";
import type { Address } from "viem";

import { parseDecimal } from "./amounts.ts";
import { mined } from "./mined.ts";
import { ScriptError } from "./scriptError.ts";
import { GatedScript, passSendGate } from "./sendGate.ts";
import {
  VARIABLES,
  requireAddress,
  requireText,
  type Environment,
} from "./settings.ts";
import { triggerAt } from "./triggerAt.ts";

type Viem = NetworkConnection["viem"];

/** ETH has 18 decimals. */
export const ETH_DECIMALS = 18;

export type FundVenueSettings = {
  readonly contract: Address;
  /** ETH to send, for example "0.01". */
  readonly eth: string;
};

/** The settings of fund-venue, from `env`. Both are required. */
export function fundVenueSettingsFrom(env: Environment): FundVenueSettings {
  const eth = requireText(env, VARIABLES.fundEth);
  if (parseDecimal(eth, ETH_DECIMALS, VARIABLES.fundEth) === 0n) {
    throw new ScriptError(`${VARIABLES.fundEth} must be more than 0.`);
  }
  return { contract: requireAddress(env, VARIABLES.contractAddress), eth };
}

export type FundedVenue = {
  readonly venue: Address;
  /** Wei sent, and the venue's balance before and after, in wei. */
  readonly sent: bigint;
  readonly before: bigint;
  readonly after: bigint;
};

/** Sends the ETH. Passes the send gate first. */
export async function fundVenue(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: FundVenueSettings;
}): Promise<FundedVenue> {
  const { viem, settings } = input;
  const { publicClient, trigger } = await triggerAt(viem, settings.contract);
  await passSendGate(publicClient, GatedScript.FundVenue, input.confirmation);
  const [sender] = await viem.getWalletClients();
  if (sender === undefined) {
    throw new ScriptError("The network has no account to send ETH from.");
  }
  const sent = parseDecimal(settings.eth, ETH_DECIMALS, VARIABLES.fundEth);
  const venue = await trigger.read.swapVenue();
  const before = await publicClient.getBalance({ address: venue });
  await mined(
    publicClient,
    await sender.sendTransaction({ to: venue, value: sent }),
  );
  return {
    venue,
    sent,
    before,
    after: await publicClient.getBalance({ address: venue }),
  };
}
