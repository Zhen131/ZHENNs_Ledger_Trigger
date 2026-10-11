// Reads the five fields of the order form into the values `createOrder`
// takes. The expiry is counted from the time of the latest block, as the
// place-order script does, not from the browser's clock.

import { getAddress, isAddress, type Address } from "viem";

import { InputError, parseDecimal, parseWhole } from "./amounts.ts";
import type { Decimals } from "./orders.ts";

/** The text of the five fields, as typed. */
export type OrderFormText = {
  readonly usdc: string;
  readonly targetPriceUsd: string;
  readonly expiryMinutes: string;
  readonly recipient: string;
  readonly executor: string;
};

export type OrderFormValues = {
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly expiryMinutes: bigint;
  readonly recipient: Address;
  readonly executor: Address;
};

/** `text` as an address, or `InputError` naming it by `label`. */
export function parseAddress(text: string, label: string): Address {
  const trimmed = text.trim();
  if (trimmed === "") throw new InputError(`${label} is required.`);
  if (!isAddress(trimmed, { strict: false })) {
    throw new InputError(
      `${label} must be an address: 0x followed by 40 hex digits.`,
    );
  }
  return getAddress(trimmed);
}

/** The form's values in the contract's units. Throws `InputError`. */
export function parseOrderForm(
  text: OrderFormText,
  decimals: Decimals,
): OrderFormValues {
  return {
    usdcAmount: parseDecimal(text.usdc, decimals.usdc, "Amount"),
    targetPrice: parseDecimal(
      text.targetPriceUsd,
      decimals.price,
      "Target price",
    ),
    expiryMinutes: parseWhole(text.expiryMinutes, 1n, "Valid for"),
    recipient: parseAddress(text.recipient, "Recipient"),
    executor: parseAddress(text.executor, "Executor"),
  };
}

/** The expiry: `minutes` after `latestBlockTime` (Unix seconds). */
export function expiryFrom(latestBlockTime: bigint, minutes: bigint): bigint {
  return latestBlockTime + minutes * 60n;
}
