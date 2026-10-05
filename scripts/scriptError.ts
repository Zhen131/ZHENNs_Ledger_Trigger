// The errors the deployment, operation and demo scripts meet, and what they
// print about them.
//
// A script prints only what this file builds: its own sentences, the name of
// the error a contract reverted with, or the code and title of a Hardhat
// error. It never prints a library's own error message, because such a
// message can hold the node URL, which often carries an access key.

import { BaseError, ContractFunctionRevertedError } from "viem";

/** A failure the scripts describe in their own words; safe to print. */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const HARDHAT_CODE = /^HHE\d+$/;

/**
 * The name of the contract error that `error` comes from, such as
 * `PriceAboveTarget`, or undefined when it is not a contract revert that the
 * ABI of the call can name.
 */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  return revert.data?.errorName;
}

/** The values the contract error carries, as text, such as `5, 7`. */
function revertArguments(error: BaseError): string {
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return "";
  return (revert.data?.args ?? []).map((value) => String(value)).join(", ");
}

/** Code and title of a Hardhat error, such as `HHE7 Configuration ...`. */
function hardhatCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("errorCode" in error) || !("descriptor" in error)) return undefined;
  const { errorCode, descriptor } = error;
  if (typeof errorCode !== "string" || !HARDHAT_CODE.test(errorCode)) {
    return undefined;
  }
  const title =
    typeof descriptor === "object" &&
    descriptor !== null &&
    "websiteTitle" in descriptor &&
    typeof descriptor.websiteTitle === "string"
      ? descriptor.websiteTitle
      : "";
  return `${errorCode} ${title}`.trim();
}

/** Class names along the cause chain of `error`, outermost first. */
function errorTypes(error: unknown): string[] {
  const names: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if (IDENTIFIER.test(current.name)) names.push(current.name);
    current = current.cause;
  }
  return names;
}

/** One line about why a script stopped, safe to print. */
export function describeFailure(error: unknown): string {
  if (error instanceof ScriptError) return error.message;
  const name = revertName(error);
  if (name !== undefined && error instanceof BaseError) {
    return `The contract rejected the call with ${name}(${revertArguments(error)}).`;
  }
  if (errorTypes(error).includes("InsufficientFundsError")) {
    return "The sending account does not hold enough ETH to pay for this transaction. Get test ETH for it from a faucet, then run the script again.";
  }
  const code = hardhatCode(error);
  if (code !== undefined) {
    return `Hardhat stopped the script with error ${code}. The section "When something goes wrong" in docs/testnet-guide.md explains the common ones.`;
  }
  return `The script stopped on an error it did not expect (${errorTypes(error).join(" > ") || "unknown"}). Its message is not shown, because it may hold the node URL.`;
}
