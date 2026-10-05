// The one gate that every script which sends transactions passes before it
// sends anything: the deployment, placing an order, cancelling an order,
// stocking the swap venue with ETH, setting the mock price, and the demo.
//
// The gate looks at the chain ID the node reports:
//
// - Hardhat's local chain (31337, the in-process chain and `npx hardhat node`):
//   every script may send.
// - Any other chain: nothing is sent unless the environment variable
//   TRIGGER_CONFIRM_PUBLIC_NETWORK holds exactly CONFIRM_PHRASE. Even then only
//   the deployment, placing, cancelling and stocking may send. The demo and
//   setting the mock price never run on another chain, whatever the variable
//   holds: they only make sense on a local chain.
//
// `checkSendGate` decides from the chain ID and the variable's value alone, so
// it can be tested without any network. `passSendGate` asks the node for the
// chain ID, then applies `checkSendGate`, and throws when the answer is no.

import { ScriptError } from "./scriptError.ts";

/** Chain ID of Hardhat's local chains. */
export const LOCAL_CHAIN_ID = 31337;

/**
 * True for Hardhat's local chain. This is the one rule for "local" everywhere
 * in this repository: the send gate and the guard that keeps the tests on the
 * local chain both use it.
 */
export function isLocalChain(chainId: number): boolean {
  return chainId === LOCAL_CHAIN_ID;
}

/** The environment variable that confirms sending to a chain that is not local. */
export const CONFIRM_VARIABLE = "TRIGGER_CONFIRM_PUBLIC_NETWORK";

/** The exact text CONFIRM_VARIABLE must hold. */
export const CONFIRM_PHRASE =
  "I am sending real transactions to a public network";

/** The scripts that send transactions. */
export const GatedScript = {
  Deploy: "deploy",
  PlaceOrder: "place-order",
  CancelOrder: "cancel-order",
  FundVenue: "fund-venue",
  SetPrice: "set-price",
  Demo: "demo",
} as const;
export type GatedScript = (typeof GatedScript)[keyof typeof GatedScript];

/** The scripts that run on Hardhat's local chain only. */
export const LOCAL_ONLY: readonly GatedScript[] = [
  GatedScript.SetPrice,
  GatedScript.Demo,
];

export type GateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export type GateInput = {
  readonly script: GatedScript;
  /** The chain ID the node reports. */
  readonly chainId: number;
  /** The value of CONFIRM_VARIABLE, or undefined when it is not set. */
  readonly confirmation: string | undefined;
};

/** Says whether `script` may send transactions on the chain `chainId`. */
export function checkSendGate(input: GateInput): GateDecision {
  if (isLocalChain(input.chainId)) return { allowed: true };
  const where = `chain ${input.chainId}, which is not Hardhat's local chain (${LOCAL_CHAIN_ID})`;
  if (LOCAL_ONLY.includes(input.script)) {
    return {
      allowed: false,
      reason: `The ${input.script} script runs on Hardhat's local chain only, and this is ${where}. Nothing was sent.`,
    };
  }
  if (input.confirmation === undefined || input.confirmation === "") {
    return {
      allowed: false,
      reason: `This is ${where}. To send transactions here, set ${CONFIRM_VARIABLE} to the exact sentence given in the README. Nothing was sent.`,
    };
  }
  if (input.confirmation !== CONFIRM_PHRASE) {
    return {
      allowed: false,
      reason: `This is ${where}, and ${CONFIRM_VARIABLE} does not hold the exact sentence given in the README. Nothing was sent.`,
    };
  }
  return { allowed: true };
}

/**
 * Asks the node for its chain ID and applies the gate. Returns the chain ID
 * when `script` may send; throws a `ScriptError` with the reason otherwise.
 */
export async function passSendGate(
  client: { readonly getChainId: () => Promise<number> },
  script: GatedScript,
  confirmation: string | undefined,
): Promise<number> {
  const chainId = await client.getChainId();
  const decision = checkSendGate({ script, chainId, confirmation });
  if (!decision.allowed) throw new ScriptError(decision.reason);
  return chainId;
}
