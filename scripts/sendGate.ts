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
//   the deployment with external parts, placing, cancelling and stocking may
//   send. The demo, setting the mock price and the deployment with mock parts
//   never run on another chain, whatever the variable holds: they only make
//   sense on a local chain.
//
// `checkSendGate` decides from the chain ID and the variable's value alone, so
// it can be tested without any network. `passSendGate` asks the node for the
// chain ID, then applies `checkSendGate`, and throws when the answer is no.
//
// Deciding and letting through are kept apart. `checkSendGate` and
// `passSendGate` only decide: they let nothing through, whatever client they
// are given. The scripts call `openSendGate`, which decides the same way and,
// on a chain that is not local, then opens the one Hardhat network connection
// behind the client it was given. It does so by sending OPEN_GATE_METHOD with
// a single-use token over that connection. The network guard
// (networkGuard.ts) answers that request itself: it redeems the token here,
// asks the connection's own node for its chain ID, and only when that is the
// chain the gate decided on does it record that very connection as open. The
// record is kept by the guard per connection object, never per chain ID. A
// stand-in client that only reports a chain ID opens nothing: its request
// never reaches a guarded connection. A client that passes the request on to
// a real connection can open that one connection and no other, and only when
// that connection's own node serves the chain the gate decided on; that is
// the same as passing the gate, with the confirmation, on that connection.

import { randomUUID } from "node:crypto";

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
  /** The deployment with external parts. */
  Deploy: "deploy",
  /** The deployment with mock parts. */
  DeployMocks: "deploy-mocks",
  PlaceOrder: "place-order",
  CancelOrder: "cancel-order",
  FundVenue: "fund-venue",
  SetPrice: "set-price",
  Demo: "demo",
} as const;
export type GatedScript = (typeof GatedScript)[keyof typeof GatedScript];

/** The scripts that run on Hardhat's local chain only. */
export const LOCAL_ONLY: readonly GatedScript[] = [
  GatedScript.DeployMocks,
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
 * Asks `client` for its chain ID and applies the gate. Returns the chain ID
 * when `script` may send; throws a `ScriptError` with the reason otherwise.
 * It only decides: it lets nothing through on any connection.
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

/** The request `openSendGate` sends over the connection it opens. */
export const OPEN_GATE_METHOD = "ledgerTrigger_openSendGate";

/** Tokens issued by `openSendGate` and not yet redeemed, with their chain. */
const pendingTokens = new Map<string, number>();

/**
 * Decides like `passSendGate`, then, on a chain that is not local, opens the
 * Hardhat network connection behind `client` for sending: the network guard
 * lets that connection, and no other, send. Throws a `ScriptError`, with
 * nothing sent, when the gate refuses or when the connection cannot be opened
 * (it is not a Hardhat connection with the network guard loaded, or its node
 * serves another chain than the one `client` reported).
 */
export async function openSendGate(
  client: {
    readonly getChainId: () => Promise<number>;
    readonly request: (args: never) => Promise<unknown>;
  },
  script: GatedScript,
  confirmation: string | undefined,
): Promise<number> {
  const chainId = await passSendGate(client, script, confirmation);
  if (isLocalChain(chainId)) return chainId;
  const token = randomUUID();
  pendingTokens.set(token, chainId);
  let opened: unknown;
  try {
    opened = await client.request({
      method: OPEN_GATE_METHOD,
      params: [token],
    } as never);
  } catch {
    opened = false;
  } finally {
    pendingTokens.delete(token);
  }
  if (opened !== true) {
    throw new ScriptError(
      `The send gate could not open this connection to chain ${chainId}: it is not a Hardhat network connection with the network guard loaded, or its node serves another chain. Nothing was sent.`,
    );
  }
  return chainId;
}

/**
 * The chain a pending `openSendGate` token was issued for, or undefined. A
 * token works once: redeeming it removes it. Only the network guard calls
 * this, when the token reaches it over a connection.
 */
export function redeemSendGateToken(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const chainId = pendingTokens.get(token);
  pendingTokens.delete(token);
  return chainId;
}
