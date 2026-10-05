// The keeper's log: one line per event, in English, on standard output.
//
// A line reads: time, order ID ("-" when the line is not about one order),
// action, reason, then any details as key=value pairs, for example
//
//   2026-01-01T00:00:00.000Z order=3 action=skip reason=PriceAboveTarget check=canFill
//
// Nothing logged here comes from a library's error message; those can hold
// the node URL, which may carry an access key. Errors are logged as this
// project's own sentence, a category and the error class names.

import { Cause, errorTypes, type Classification } from "./classify.ts";

/** What the keeper did. */
export const Action = {
  Start: "start",
  RoundStart: "round-start",
  RoundEnd: "round-end",
  Skip: "skip",
  Fill: "filled",
  Error: "error",
} as const;
export type Action = (typeof Action)[keyof typeof Action];

export type LogEntry = {
  /** The order the line is about, if any. */
  readonly orderId: bigint | undefined;
  readonly action: Action;
  /** One word or name, no spaces. */
  readonly reason: string;
  readonly details: readonly (readonly [key: string, value: string])[];
};

/** Writes one entry somewhere: standard output in the keeper, a list in tests. */
export type Logger = (entry: LogEntry) => void;

/** This project's own sentence for each error category. */
export const ERROR_SENTENCES: Readonly<Record<string, string>> = {
  [Cause.NodeUnreachable]: "Could not reach the node.",
  [Cause.NodeError]:
    "The node reported an error that is not a contract revert.",
};

const PLAIN_VALUE = /^[^\s"=]+$/;

/** One log line for `entry`, stamped with `time`. */
export function formatLogLine(entry: LogEntry, time: Date): string {
  const order = entry.orderId === undefined ? "-" : entry.orderId.toString();
  const details = entry.details.map(
    ([key, value]) =>
      ` ${key}=${PLAIN_VALUE.test(value) ? value : JSON.stringify(value)}`,
  );
  return `${time.toISOString()} order=${order} action=${entry.action} reason=${entry.reason}${details.join("")}`;
}

/**
 * The log entry for an error the keeper's own code did not expect, at `step`.
 * It names the error's classes only, never its message.
 */
export function internalErrorEntry(step: string, error: unknown): LogEntry {
  return {
    orderId: undefined,
    action: Action.Error,
    reason: "internal-error",
    details: [
      ["step", step],
      ["message", "The keeper met an error it did not expect."],
      ["types", errorTypes(error).join(">") || "unknown"],
    ],
  };
}

/**
 * The log entry for a failure sorted by `classifyFailure`. `step` says where
 * it happened, for example `simulate` or `send`.
 */
export function failureEntry(
  orderId: bigint | undefined,
  step: string,
  classification: Classification,
): LogEntry {
  const where = ["step", step] as const;
  switch (classification.cause) {
    case Cause.NamedError:
      return {
        orderId,
        action: Action.Skip,
        reason: classification.errorName,
        details: [where],
      };
    case Cause.RevertedTransaction:
      return {
        orderId,
        action: Action.Skip,
        reason: classification.cause,
        details: [where, ["tx", classification.transactionHash]],
      };
    case Cause.UnnamedError:
      return {
        orderId,
        action: Action.Skip,
        reason: classification.cause,
        details: [where, ["selector", classification.selector]],
      };
    case Cause.NodeUnreachable:
    case Cause.NodeError:
      return {
        orderId,
        action: Action.Error,
        reason: classification.cause,
        details: [
          where,
          ["message", ERROR_SENTENCES[classification.cause] ?? ""],
          ["types", classification.errorTypes.join(">") || "unknown"],
        ],
      };
  }
}
