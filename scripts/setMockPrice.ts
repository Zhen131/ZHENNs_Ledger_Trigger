// Sets the price of the mock price feed behind a deployed LedgerTrigger, the
// way the demo moves the price to an order's target. Runs on Hardhat's local
// chain only: the send gate refuses every other chain, whatever the
// confirmation variable holds, because a real price feed cannot be set.

import type { NetworkConnection } from "hardhat/types/network";
import type { Address } from "viem";

import { formatDecimal, parseDecimal } from "./amounts.ts";
import { mined } from "./mined.ts";
import { GatedScript, passSendGate } from "./sendGate.ts";
import {
  VARIABLES,
  requireAddress,
  requireText,
  type Environment,
} from "./settings.ts";
import { triggerAt } from "./triggerAt.ts";

type Viem = NetworkConnection["viem"];

export type SetPriceSettings = {
  readonly contract: Address;
  /** New price in USD, for example "1950". */
  readonly priceUsd: string;
};

/** The settings of set-price, from `env`. Both are required. */
export function setPriceSettingsFrom(env: Environment): SetPriceSettings {
  return {
    contract: requireAddress(env, VARIABLES.contractAddress),
    priceUsd: requireText(env, VARIABLES.priceUsd),
  };
}

export type PriceSet = {
  readonly feed: Address;
  /** The price sent, and the price the feed reports afterwards. */
  readonly sent: bigint;
  readonly readBack: bigint;
  readonly decimals: number;
};

/** Sets the price. Passes the send gate first. */
export async function setMockPrice(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: SetPriceSettings;
}): Promise<PriceSet> {
  const { viem, settings } = input;
  const { publicClient, trigger } = await triggerAt(viem, settings.contract);
  await passSendGate(publicClient, GatedScript.SetPrice, input.confirmation);
  const feed = await viem.getContractAt(
    "MockPriceFeed",
    await trigger.read.priceFeed(),
  );
  const decimals = await feed.read.decimals();
  const sent = parseDecimal(settings.priceUsd, decimals, VARIABLES.priceUsd);
  await mined(publicClient, await feed.write.setAnswer([sent]));
  const [, readBack] = await feed.read.latestRoundData();
  return { feed: feed.address, sent, readBack, decimals };
}

/** The result as lines to print. */
export function formatPriceSet(result: PriceSet): string[] {
  return [
    `Set the mock price feed ${result.feed} to ${formatDecimal(result.sent, result.decimals)} USD (${result.sent}).`,
    `The feed now reports ${formatDecimal(result.readBack, result.decimals)} USD (${result.readBack}).`,
  ];
}
