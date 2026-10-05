// Sorts out what went wrong when checking or sending a fill: skip the order
// (the contract refused it, which is normal, for example when someone else
// filled or cancelled it first) or report an error (the node itself failed).
//
// | What happened                                          | Verdict | Logged          |
// | ------------------------------------------------------ | ------- | --------------- |
// | A revert the ABIs give a name to (LedgerTrigger's, the | skip    | error name      |
// | swap venue's, or Solidity's built-in Error and Panic)  |         |                 |
// | The transaction was mined but its receipt says failed  | skip    | transaction hash|
// | A revert with data that no ABI here can name           | skip    | first 4 bytes   |
// | The node could not be reached (connection, timeout,    | error   | category        |
// | HTTP failure)                                          |         |                 |
// | Anything else the node reports (out of gas money,      | error   | category        |
// | nonce clash, a "revert" without any revert data)       |         |                 |
//
// Errors are told apart by their viem error classes and by decoding the revert
// data with the ABIs, never by reading message text. Nothing here keeps or
// returns a library's message: messages can hold the node URL.

import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
  decodeErrorResult,
  type Abi,
  type Hash,
  type Hex,
} from "viem";

/** What the keeper does about a failure. */
export const Verdict = {
  Skip: "skip",
  Error: "error",
} as const;

/** Why, in more detail. Each value is also what the log calls it. */
export const Cause = {
  NamedError: "contract-error",
  RevertedTransaction: "transaction-reverted",
  UnnamedError: "unknown-contract-error",
  NodeUnreachable: "node-unreachable",
  NodeError: "node-error",
} as const;

/** What can be handed to `classifyFailure`. */
export const FailureKind = {
  Thrown: "thrown",
  RevertedReceipt: "reverted-receipt",
} as const;

export type Failure =
  | { readonly kind: typeof FailureKind.Thrown; readonly error: unknown }
  | {
      readonly kind: typeof FailureKind.RevertedReceipt;
      readonly transactionHash: Hash;
    };

export type Classification =
  | {
      readonly verdict: typeof Verdict.Skip;
      readonly cause: typeof Cause.NamedError;
      readonly errorName: string;
    }
  | {
      readonly verdict: typeof Verdict.Skip;
      readonly cause: typeof Cause.RevertedTransaction;
      readonly transactionHash: Hash;
    }
  | {
      readonly verdict: typeof Verdict.Skip;
      readonly cause: typeof Cause.UnnamedError;
      /** The first 4 bytes of the revert data (all of it if shorter). */
      readonly selector: Hex;
    }
  | {
      readonly verdict: typeof Verdict.Error;
      readonly cause: typeof Cause.NodeUnreachable | typeof Cause.NodeError;
      /** Class names along the error's cause chain, outermost first. */
      readonly errorTypes: readonly string[];
    };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Class names along the cause chain, kept only when they are plain identifiers. */
function errorTypes(error: unknown): string[] {
  const names: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if (IDENTIFIER.test(current.name)) names.push(current.name);
    current = current.cause;
  }
  return names;
}

function isUnreachable(error: unknown): boolean {
  return (
    error instanceof HttpRequestError ||
    error instanceof TimeoutError ||
    error instanceof SocketClosedError ||
    error instanceof WebSocketRequestError
  );
}

/**
 * Sorts a failure into skip or error. `errorAbi` holds every error the
 * contracts can revert with (see `loadAbis`); revert data is decoded with it,
 * whatever ABI the failed call used.
 */
export function classifyFailure(
  failure: Failure,
  errorAbi: Abi,
): Classification {
  if (failure.kind === FailureKind.RevertedReceipt) {
    return {
      verdict: Verdict.Skip,
      cause: Cause.RevertedTransaction,
      transactionHash: failure.transactionHash,
    };
  }
  const { error } = failure;
  if (error instanceof BaseError) {
    const revert = error.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    );
    if (
      revert instanceof ContractFunctionRevertedError &&
      revert.raw !== undefined &&
      revert.raw !== "0x"
    ) {
      try {
        const { errorName } = decodeErrorResult({
          abi: errorAbi,
          data: revert.raw,
        });
        return { verdict: Verdict.Skip, cause: Cause.NamedError, errorName };
      } catch {
        return {
          verdict: Verdict.Skip,
          cause: Cause.UnnamedError,
          selector: revert.raw.slice(0, 10) as Hex,
        };
      }
    }
    if (error.walk(isUnreachable) !== null) {
      return {
        verdict: Verdict.Error,
        cause: Cause.NodeUnreachable,
        errorTypes: errorTypes(error),
      };
    }
  }
  return {
    verdict: Verdict.Error,
    cause: Cause.NodeError,
    errorTypes: errorTypes(error),
  };
}
