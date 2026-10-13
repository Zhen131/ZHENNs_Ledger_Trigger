// Reads the forms of the three newer kinds of order into the values the
// contract takes: a dormant limit order (`createDormantOrder`), a Dca order
// (`createDcaOrder`) and a Ladder order (`createLadderOrder`). The limit
// order's form is read by orderForm.ts.
//
// Only the way each value is written is checked here: numbers and their
// decimals, addresses, whole numbers of at least 1, required fields. The
// contract's own rules (the most per fill, the most periods or tiers, prices
// going down from tier to tier, an activation price above the target) are
// left to the contract: the page simulates the call first and shows the
// contract's named error.

import type { Address } from "viem";

import { InputError, parseDecimal, parseWhole } from "./amounts.ts";
import { FormKind } from "./kinds.ts";
import { parseAddress } from "./orderForm.ts";
import type { Decimals, TierData } from "./orders.ts";

/** A Dca order's period is typed in days; the contract takes seconds. */
export const SECONDS_PER_DAY = 86400n;

/** A price that is required: empty text is an `InputError`. */
function requiredPrice(text: string, decimals: Decimals, label: string) {
  if (text.trim() === "") throw new InputError(`${label} is required.`);
  return parseDecimal(text, decimals.price, label);
}

/** An activation price that may be left out: empty or 0 both mean none, 0. */
function optionalActivation(text: string, decimals: Decimals): bigint {
  return text.trim() === ""
    ? 0n
    : parseDecimal(text, decimals.price, "Activation price");
}

/** The text of the dormant limit order's six fields, as typed. */
export type DormantFormText = {
  readonly usdc: string;
  readonly targetPriceUsd: string;
  readonly activationPriceUsd: string;
  readonly expiryMinutes: string;
  readonly recipient: string;
  readonly executor: string;
};

export type DormantFormValues = {
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly activationPrice: bigint;
  readonly expiryMinutes: bigint;
  readonly recipient: Address;
  readonly executor: Address;
};

/**
 * A dormant limit order's values in the contract's units. The activation
 * price is required; 0 is passed on as it is, for the contract to refuse.
 * Throws `InputError` naming the first field that is wrong.
 */
export function parseDormantForm(
  text: DormantFormText,
  decimals: Decimals,
): DormantFormValues {
  return {
    usdcAmount: parseDecimal(text.usdc, decimals.usdc, "Amount"),
    targetPrice: parseDecimal(
      text.targetPriceUsd,
      decimals.price,
      "Target price",
    ),
    activationPrice: requiredPrice(
      text.activationPriceUsd,
      decimals,
      "Activation price",
    ),
    expiryMinutes: parseWhole(text.expiryMinutes, 1n, "Valid for"),
    recipient: parseAddress(text.recipient, "Recipient"),
    executor: parseAddress(text.executor, "Executor"),
  };
}

/** The text of the Dca form's seven fields, as typed. */
export type DcaFormText = {
  readonly usdcPerPeriod: string;
  readonly priceCapUsd: string;
  readonly everyDays: string;
  readonly periods: string;
  readonly activationPriceUsd: string;
  readonly recipient: string;
  readonly executor: string;
};

/** The fields of the contract's `DcaOrderParams`, in its units. */
export type DcaFormValues = {
  readonly usdcPerPeriod: bigint;
  /** The cap: no period is bought above this price. */
  readonly targetPrice: bigint;
  readonly periodLength: bigint;
  readonly periodCount: bigint;
  /** Always 0: the schedule starts with the block that places the order. */
  readonly startAt: bigint;
  readonly activationPrice: bigint;
  readonly recipient: Address;
  readonly executor: Address;
};

/**
 * A Dca order's values in the contract's units: whole days become seconds,
 * the start is 0 (the block that places the order), and an activation price
 * left empty or 0 means none. Throws `InputError` naming the first field
 * that is wrong.
 */
export function parseDcaForm(
  text: DcaFormText,
  decimals: Decimals,
): DcaFormValues {
  const usdcPerPeriod = parseDecimal(
    text.usdcPerPeriod,
    decimals.usdc,
    "USDC per period",
  );
  const targetPrice = parseDecimal(
    text.priceCapUsd,
    decimals.price,
    "Price cap",
  );
  const days = parseWhole(text.everyDays, 1n, "Every (days)");
  const periodCount = parseWhole(text.periods, 1n, "Periods");
  return {
    usdcPerPeriod,
    targetPrice,
    periodLength: days * SECONDS_PER_DAY,
    periodCount,
    startAt: 0n,
    activationPrice: optionalActivation(text.activationPriceUsd, decimals),
    recipient: parseAddress(text.recipient, "Recipient"),
    executor: parseAddress(text.executor, "Executor"),
  };
}

/** One tier row of the Ladder form, as typed. */
export type TierText = {
  readonly priceUsd: string;
  readonly usdc: string;
};

/** The text of the Ladder form: its tier rows and four more fields. */
export type LadderFormText = {
  readonly tiers: readonly TierText[];
  readonly activationPriceUsd: string;
  readonly expiryMinutes: string;
  readonly recipient: string;
  readonly executor: string;
};

export type LadderFormValues = {
  readonly tiers: readonly TierData[];
  readonly activationPrice: bigint;
  readonly expiryMinutes: bigint;
  readonly recipient: Address;
  readonly executor: Address;
};

/**
 * A Ladder order's values in the contract's units. Every tier row shown must
 * be filled in; tiers are numbered from 0, as the contract numbers them. An
 * activation price left empty or 0 means none. Throws `InputError` naming the
 * first field that is wrong, for a tier with its number ("Tier 1 price").
 */
export function parseLadderForm(
  text: LadderFormText,
  decimals: Decimals,
): LadderFormValues {
  const tiers = text.tiers.map((tier, index) => {
    const priceLabel = `Tier ${index} price`;
    const amountLabel = `Tier ${index} amount`;
    if (tier.priceUsd.trim() === "") {
      throw new InputError(`${priceLabel} is required.`);
    }
    const price = parseDecimal(tier.priceUsd, decimals.price, priceLabel);
    if (tier.usdc.trim() === "") {
      throw new InputError(`${amountLabel} is required.`);
    }
    const usdcAmount = parseDecimal(tier.usdc, decimals.usdc, amountLabel);
    return { price, usdcAmount };
  });
  return {
    tiers,
    activationPrice: optionalActivation(text.activationPriceUsd, decimals),
    expiryMinutes: parseWhole(text.expiryMinutes, 1n, "Valid for"),
    recipient: parseAddress(text.recipient, "Recipient"),
    executor: parseAddress(text.executor, "Executor"),
  };
}

/** What `budgetOf` needs of an order of each kind. */
export type BudgetInput =
  | {
      readonly kind: typeof FormKind.Limit | typeof FormKind.DormantLimit;
      readonly usdcAmount: bigint;
    }
  | {
      readonly kind: typeof FormKind.Dca;
      readonly usdcPerPeriod: bigint;
      readonly periodCount: bigint;
    }
  | {
      readonly kind: typeof FormKind.Ladder;
      readonly tiers: readonly { readonly usdcAmount: bigint }[];
    };

/**
 * The order's whole budget in USDC, the same number the contract stores as
 * `usdcAmount`: a limit order's amount; a Dca order's amount per period times
 * its periods; the amounts of a Ladder order's tiers added up. The allowance
 * must cover it on top of the owner's other unfinished orders.
 */
export function budgetOf(order: BudgetInput): bigint {
  switch (order.kind) {
    case FormKind.Limit:
    case FormKind.DormantLimit:
      return order.usdcAmount;
    case FormKind.Dca:
      return order.usdcPerPeriod * order.periodCount;
    case FormKind.Ladder:
      return order.tiers.reduce((sum, tier) => sum + tier.usdcAmount, 0n);
  }
}

/**
 * Whether another tier row may be added to `rows` rows: only below the
 * contract's `maxTiersPerOrder`, and not while that is unknown (no contract
 * loaded).
 */
export function canAddTier(rows: number, maxTiers: bigint | undefined) {
  return maxTiers !== undefined && BigInt(rows) < maxTiers;
}

/** Whether a tier row may be removed from `rows` rows: one always stays. */
export function canRemoveTier(rows: number): boolean {
  return rows > 1;
}
