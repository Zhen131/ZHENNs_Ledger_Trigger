// Cancels one order, from the first account of the network connection, which
// must be the order's owner: the contract rejects anyone else.

import type { NetworkConnection } from "hardhat/types/network";
import type { Address } from "viem";

import { parseWhole } from "./amounts.ts";
import { mined } from "./mined.ts";
import { orderStatusName } from "../keeper/names.ts";
import { ScriptError } from "./scriptError.ts";
import { GatedScript, openSendGate } from "./sendGate.ts";
import {
  VARIABLES,
  requireAddress,
  requireText,
  type Environment,
} from "./settings.ts";
import { triggerAt } from "./triggerAt.ts";

type Viem = NetworkConnection["viem"];

export type CancelOrderSettings = {
  readonly contract: Address;
  readonly orderId: bigint;
};

/** The settings of cancel-order, from `env`. Both are required. */
export function cancelOrderSettingsFrom(env: Environment): CancelOrderSettings {
  return {
    contract: requireAddress(env, VARIABLES.contractAddress),
    orderId: parseWhole(
      requireText(env, VARIABLES.orderId),
      1n,
      VARIABLES.orderId,
    ),
  };
}

export type CancelledOrder = {
  readonly orderId: bigint;
  /** Status names from `statusOf`, before and after. */
  readonly statusBefore: string;
  readonly statusAfter: string;
};

/** Cancels the order. Passes the send gate first. */
export async function cancelOrder(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: CancelOrderSettings;
}): Promise<CancelledOrder> {
  const { viem, settings } = input;
  const { publicClient, walletClients, trigger } = await triggerAt(
    viem,
    settings.contract,
  );
  await openSendGate(publicClient, GatedScript.CancelOrder, input.confirmation);
  const [owner] = walletClients;
  if (owner === undefined) {
    throw new ScriptError("The network has no account to cancel from.");
  }
  const statusBefore = orderStatusName(
    await trigger.read.statusOf([settings.orderId]),
  );
  await mined(
    publicClient,
    await trigger.write.cancelOrder([settings.orderId], {
      account: owner.account,
    }),
  );
  return {
    orderId: settings.orderId,
    statusBefore,
    statusAfter: orderStatusName(
      await trigger.read.statusOf([settings.orderId]),
    ),
  };
}
