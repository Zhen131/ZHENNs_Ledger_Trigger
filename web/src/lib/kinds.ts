// The kinds of order: the contract's own enum, and the four choices of the
// order form.
//
// The contract's ABI carries an enum value as a plain number (uint8) without
// its name, so the names of `LedgerTrigger.OrderKind` are written out here,
// each with its value, in the order the contract declares them. A test
// compares this list with the enum's members in the compiler's syntax tree,
// so a list that drifts from the contract fails the checks.

/** `LedgerTrigger.OrderKind`: what `getOrder` and `OrderCreated` carry. */
export const OrderKind = {
  Limit: 0,
  Dca: 1,
  Ladder: 2,
} as const;

/** The name of an OrderKind value, for example `Dca` for 1. */
export function orderKindName(value: number): string {
  const entry = Object.entries(OrderKind).find(([, v]) => v === value);
  return entry === undefined ? `unknown(${value})` : entry[0];
}

/**
 * The four choices of the order form. A dormant limit order is a limit
 * order with an activation price: the contract stores it as `Limit`.
 */
export const FormKind = {
  Limit: "limit",
  DormantLimit: "dormant-limit",
  Dca: "dca",
  Ladder: "ladder",
} as const;

export type FormKindName = (typeof FormKind)[keyof typeof FormKind];
