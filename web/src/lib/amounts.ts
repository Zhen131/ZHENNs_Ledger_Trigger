// Turns the numbers people type, such as "100" or "1500.25", into the whole
// numbers the contracts store, and back.
//
// A token amount or a price is stored as a whole number in the smallest unit:
// USDC has 6 decimals, so 100 USDC is 100000000; the ETH / USD price feed has
// 8, so 1500 USD is 150000000000. The number of decimals is always read from
// the contract by the caller, never assumed here.
//
// The rules are the same as in the scripts (scripts/amounts.ts); this copy
// throws its own error class so that nothing from the scripts is bundled into
// the page.

import { formatUnits, parseUnits } from "viem";

/** A value typed into the page that cannot be used, with a message saying why. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const WHOLE = /^\d+$/;

/**
 * The whole number for `text` with `decimals` decimals, for example 12500000
 * for "12.5" with 6. Throws `InputError`, naming the value by `label`, when
 * `text` is not a plain decimal number (digits, at most one dot, no sign, no
 * exponent) or has more decimals than the unit allows.
 */
export function parseDecimal(
  text: string,
  decimals: number,
  label: string,
): bigint {
  const trimmed = text.trim();
  const match = DECIMAL.exec(trimmed);
  if (match === null) {
    throw new InputError(
      `${label} must be a plain number such as 100 or 12.5 (digits and at most one dot).`,
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new InputError(
      `${label} has ${fraction.length} digits after the dot; at most ${decimals} are allowed.`,
    );
  }
  return parseUnits(trimmed, decimals);
}

/**
 * A whole number of at least `min`, written in decimal digits, such as a
 * number of minutes. Throws `InputError`, naming the value by `label`.
 */
export function parseWhole(text: string, min: bigint, label: string): bigint {
  const trimmed = text.trim();
  if (!WHOLE.test(trimmed) || BigInt(trimmed) < min) {
    throw new InputError(`${label} must be a whole number of at least ${min}.`);
  }
  return BigInt(trimmed);
}

/**
 * `value`, a whole number with `decimals` decimals, written out exactly, with
 * at least `minPlaces` digits after the dot: 100000000 with 6 decimals is
 * "100.00", 12345678 is "12.345678".
 */
export function formatAmount(
  value: bigint,
  decimals: number,
  minPlaces = 2,
): string {
  const text = formatUnits(value, decimals);
  const dot = text.indexOf(".");
  const places = dot < 0 ? 0 : text.length - dot - 1;
  if (places >= minPlaces) return text;
  return `${dot < 0 ? `${text}.` : text}${"0".repeat(minPlaces - places)}`;
}

/**
 * `value`, a whole number with `decimals` decimals, rounded to exactly
 * `places` digits after the dot (halves away from zero): 199999500000 with 8
 * decimals and 2 places is "2000.00".
 */
export function formatFixed(
  value: bigint,
  decimals: number,
  places: number,
): string {
  if (places >= decimals) return formatAmount(value, decimals, places);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const step = 10n ** BigInt(decimals - places);
  const rounded = (magnitude + step / 2n) / step;
  const text = formatAmount(rounded, places, places);
  return negative && rounded !== 0n ? `-${text}` : text;
}
