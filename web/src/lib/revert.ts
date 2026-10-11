// Turns a rejected call into words: the contract's error name and its
// arguments, such as "PriceAboveTarget(price: 1600.00, targetPrice: 1500.00)",
// or "the user said no in the wallet".
//
// The revert data is decoded with the ABI the caller passes in; the argument
// names are the ones the ABI gives. Each argument is written in the unit its
// name stands for:
//
// | Argument names                                    | Written as                    |
// | ------------------------------------------------- | ----------------------------- |
// | price, targetPrice                                | USD, with the price decimals  |
// | amount, max, allowance, balance, needed           | USDC, with the USDC decimals  |
// | expiry, currentTime, updatedAt, maxPriceAge       | the whole number as it is     |
// | any address                                       | shortened, 0xf39F…2266        |
// | anything else (an order ID, a status, wei)        | as it is                      |
//
// One exception: `max` in TooManyOpenOrders is a number of orders, not USDC,
// so it is written as it is.

import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Abi,
  type AbiParameter,
  type Hex,
} from "viem";

import { formatAmount } from "./amounts.ts";
import { shortAddress } from "./format.ts";
import type { Decimals } from "./orders.ts";

export const PRICE_ARGUMENTS: readonly string[] = ["price", "targetPrice"];
export const USDC_ARGUMENTS: readonly string[] = [
  "amount",
  "max",
  "allowance",
  "balance",
  "needed",
];
export const WHOLE_ARGUMENTS: readonly string[] = [
  "expiry",
  "currentTime",
  "updatedAt",
  "maxPriceAge",
];
/** `<error>.<argument>` pairs written as they are whatever the lists say. */
export const COUNT_ARGUMENTS: readonly string[] = ["TooManyOpenOrders.max"];

/** The longest text kept from an error that has no name in the ABI. */
export const RAW_MESSAGE_LIMIT = 120;

/** EIP-1193's code for "the user rejected the request". */
export const USER_REJECTED_CODE = 4001;

/** One argument of error `errorName`, written in its unit. */
export function formatArgument(
  errorName: string,
  parameter: AbiParameter,
  value: unknown,
  decimals: Decimals,
): string {
  const name = parameter.name ?? "";
  if (typeof value === "string" && parameter.type === "address") {
    return shortAddress(value);
  }
  if (
    typeof value === "bigint" &&
    !COUNT_ARGUMENTS.includes(`${errorName}.${name}`)
  ) {
    if (PRICE_ARGUMENTS.includes(name)) {
      return formatAmount(value, decimals.price);
    }
    if (USDC_ARGUMENTS.includes(name)) {
      return formatAmount(value, decimals.usdc);
    }
  }
  return String(value);
}

/**
 * "Name(argument: value, ...)" for revert data `data`, decoded with `abi`,
 * or undefined when no error in `abi` matches it.
 */
export function describeRevertData(
  data: Hex,
  abi: Abi,
  decimals: Decimals,
): string | undefined {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi, data });
  } catch {
    return undefined;
  }
  const item = decoded.abiItem;
  const inputs: readonly AbiParameter[] = "inputs" in item ? item.inputs : [];
  const values: readonly unknown[] = decoded.args ?? [];
  const parts = inputs.map((input, index) => {
    const label =
      input.name === undefined || input.name === "" ? `${index}` : input.name;
    return `${label}: ${formatArgument(decoded.errorName, input, values[index], decimals)}`;
  });
  return `${decoded.errorName}(${parts.join(", ")})`;
}

export type FailureView =
  | { readonly kind: "user-rejected" }
  | { readonly kind: "error"; readonly text: string };

function hasCode(value: unknown, code: number): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === code
  );
}

function isUserRejection(value: unknown): boolean {
  return (
    value instanceof UserRejectedRequestError ||
    hasCode(value, USER_REJECTED_CODE)
  );
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/** The revert data carried somewhere along `error`'s cause chain. */
function revertDataOf(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 10 && typeof current === "object" && current !== null;
    depth += 1
  ) {
    if (
      current instanceof ContractFunctionRevertedError &&
      isHex(current.raw)
    ) {
      return current.raw;
    }
    if ("data" in current) {
      const data: unknown = current.data;
      if (isHex(data)) return data;
      if (
        typeof data === "object" &&
        data !== null &&
        "data" in data &&
        isHex(data.data)
      ) {
        return data.data;
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function firstChars(text: string): string {
  return text.length > RAW_MESSAGE_LIMIT
    ? text.slice(0, RAW_MESSAGE_LIMIT)
    : text;
}

/**
 * What to show for a call or a transaction that failed: "user-rejected"
 * when the user said no in the wallet (code 4001 anywhere along the cause
 * chain); otherwise the error name and arguments decoded with `abi`; and when
 * nothing decodes, the first RAW_MESSAGE_LIMIT characters of the message.
 */
export function describeFailure(
  error: unknown,
  abi: Abi,
  decimals: Decimals,
): FailureView {
  if (isUserRejection(error)) return { kind: "user-rejected" };
  if (error instanceof BaseError && error.walk(isUserRejection) !== null) {
    return { kind: "user-rejected" };
  }
  const data = revertDataOf(error);
  if (data !== undefined && data !== "0x") {
    const text = describeRevertData(data, abi, decimals);
    if (text !== undefined) return { kind: "error", text };
  }
  if (error instanceof BaseError) {
    return {
      kind: "error",
      text: firstChars(error.shortMessage || error.message),
    };
  }
  if (error instanceof Error)
    return { kind: "error", text: firstChars(error.message) };
  return { kind: "error", text: firstChars(String(error)) };
}
