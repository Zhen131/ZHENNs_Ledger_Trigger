// Opens the deployed LedgerTrigger that the operation scripts work on, after
// checking that its address holds contract code, and reads the two numbers of
// decimals every conversion needs: the USDC token's and the price feed's.
// Both are read from the contract, which read them from the token and the
// feed when it was deployed.

import type { NetworkConnection } from "hardhat/types/network";
import type { Address } from "viem";

import { ScriptError } from "./scriptError.ts";
import { VARIABLES } from "./settings.ts";

type Viem = NetworkConnection["viem"];

/** The LedgerTrigger at `address`, with its token and feed decimals. */
export async function triggerAt(viem: Viem, address: Address) {
  const publicClient = await viem.getPublicClient();
  const code = await publicClient.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new ScriptError(
      `${VARIABLES.contractAddress} (${address}) holds no contract code on chain ${await publicClient.getChainId()}. Check the address the deployment printed.`,
    );
  }
  const trigger = await viem.getContractAt("LedgerTrigger", address);
  return {
    publicClient,
    trigger,
    usdcDecimals: await trigger.read.usdcDecimals(),
    priceDecimals: await trigger.read.priceDecimals(),
  };
}
