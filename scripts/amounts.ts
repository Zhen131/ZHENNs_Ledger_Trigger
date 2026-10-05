// Turns the numbers people write, such as "100", "2412.75" or "0.05", into the
// whole numbers the contracts store, and back.
//
// A token amount or a price is stored as a whole number in the smallest unit:
// USDC has 6 decimals, so 100 USDC is 100000000; the ETH / USD price feed has
// 8, so 2000 USD is 200000000000; ETH has 18, so 0.05 ETH is 50000000000000000.
// The number of decimals is always read from the contract by the caller,
// never assumed here.

import { formatUnits, parseUnits } from "viem";

import { ScriptError } from "./scriptError.ts";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * The whole number for `text` with `decimals` decimals, for example
 * 12500000 for "12.5" with 6. `label` names the value in the error, which is
 * thrown when `text` is not a plain decimal number (digits, at most one dot,
 * no sign, no exponent) or has more decimals than the unit allows.
 */
export function parseDecimal(
  text: string,
  decimals: number,
  label: string,
): bigint {
  const match = DECIMAL.exec(text.trim());
  if (match === null) {
    throw new ScriptError(
      `${label} must be a plain number such as 100 or 12.5 (digits and at most one dot).`,
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new ScriptError(
      `${label} has ${fraction.length} digits after the dot; at most ${decimals} are allowed.`,
    );
  }
  return parseUnits(text.trim(), decimals);
}

/** `value`, a whole number with `decimals` decimals, as a decimal number. */
export function formatDecimal(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

/**
 * A whole number of at least `min`, written in decimal digits, for example a
 * count, a number of seconds or basis points. `label` names it in the error.
 */
export function parseWhole(text: string, min: bigint, label: string): bigint {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) < min) {
    throw new ScriptError(
      `${label} must be a whole number of at least ${min}.`,
    );
  }
  return BigInt(trimmed);
}
