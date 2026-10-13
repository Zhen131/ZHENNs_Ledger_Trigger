// Names of the values of two of the order contract's four enums, OrderStatus
// and FillBlocker.
//
// The contract's ABI carries an enum value as a plain number (uint8) without
// its name, so the names are written out here, each with its value, in the
// order the contract declares them. A test compares both lists with the enum
// members in the compiler's syntax tree, so a list that drifts from the
// contract fails the checks. The keeper and the demo both use these lists.

/** `LedgerTrigger.OrderStatus`: what `statusOf` returns, by name. */
export const OrderStatus = {
  None: 0,
  Dormant: 1,
  Open: 2,
  PartiallyFilled: 3,
  Filled: 4,
  Cancelled: 5,
  Expired: 6,
} as const;

/** `LedgerTrigger.FillBlocker`: the reason `canFill` returns, by name. */
export const FillBlocker = {
  None: 0,
  NotOpen: 1,
  Dormant: 2,
  Expired: 3,
  NotStarted: 4,
  PeriodAlreadyFilled: 5,
  InvalidPrice: 6,
  StalePrice: 7,
  PriceAboveTarget: 8,
  InsufficientAllowance: 9,
  InsufficientBalance: 10,
} as const;

/** The names of a value list, ordered by value. */
export function namesInOrder(values: Readonly<Record<string, number>>) {
  return Object.entries(values)
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name);
}

/** The name of `value` in `values`, or `unknown(<value>)` if none has it. */
function nameOf(values: Readonly<Record<string, number>>, value: number) {
  const entry = Object.entries(values).find(([, v]) => v === value);
  return entry === undefined ? `unknown(${value})` : entry[0];
}

/** The name of an OrderStatus value, for example `Filled` for 4. */
export function orderStatusName(value: number): string {
  return nameOf(OrderStatus, value);
}

/** The name of a FillBlocker value, for example `PriceAboveTarget` for 8. */
export function fillBlockerName(value: number): string {
  return nameOf(FillBlocker, value);
}
