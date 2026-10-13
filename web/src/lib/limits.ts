// The line under the contract address that says what this deployment
// allows. All four limits are fixed when the contract is deployed.

import { formatAmount } from "./amounts.ts";

/** The four deployment limits the page shows. */
export type ContractLimits = {
  /** The most USDC one fill may spend: a limit order, a period or a tier. */
  readonly maxOrderAmount: bigint;
  /** The most unfinished orders (dormant, open, partly filled) per owner. */
  readonly maxOpenOrdersPerOwner: bigint;
  readonly maxPeriodsPerOrder: bigint;
  readonly maxTiersPerOrder: bigint;
};

/**
 * "Limits of this contract: up to 500.00 USDC per fill · up to 5 unfinished
 * orders per owner · Dca up to 52 periods · Ladder up to 5 tiers". The
 * amount is written with the USDC decimals; the three counts as they are.
 */
export function limitsText(
  limits: ContractLimits,
  usdcDecimals: number,
): string {
  return [
    `Limits of this contract: up to ${formatAmount(limits.maxOrderAmount, usdcDecimals)} USDC per fill`,
    `up to ${limits.maxOpenOrdersPerOwner} unfinished orders per owner`,
    `Dca up to ${limits.maxPeriodsPerOrder} periods`,
    `Ladder up to ${limits.maxTiersPerOrder} tiers`,
  ].join(" · ");
}
