import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseUnits } from "viem";

import { InputError } from "../web/src/lib/amounts.ts";
import {
  SECONDS_PER_DAY,
  budgetOf,
  canAddTier,
  canRemoveTier,
  parseDcaForm,
  parseDormantForm,
  parseLadderForm,
  type DcaFormText,
  type DormantFormText,
  type LadderFormText,
} from "../web/src/lib/kindForms.ts";
import { FormKind } from "../web/src/lib/kinds.ts";

// The forms of the dormant limit, Dca and Ladder orders turn what was typed
// into the contract's units, and name the field that is wrong. The contract's
// own rules are not checked here; the contract checks them.

const DECIMALS = { usdc: 6, price: 8 };
const RECIPIENT = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const EXECUTOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const DORMANT: DormantFormText = {
  usdc: "100",
  targetPriceUsd: "1900",
  activationPriceUsd: "2100.5",
  expiryMinutes: "60",
  recipient: RECIPIENT,
  executor: EXECUTOR,
};

const DCA: DcaFormText = {
  usdcPerPeriod: "10.25",
  priceCapUsd: "2100",
  everyDays: "1",
  periods: "3",
  activationPriceUsd: "",
  recipient: RECIPIENT,
  executor: EXECUTOR,
};

const LADDER: LadderFormText = {
  tiers: [
    { priceUsd: "1950", usdc: "10" },
    { priceUsd: "1900.25", usdc: "15.5" },
    { priceUsd: "1850", usdc: "20" },
  ],
  activationPriceUsd: "",
  expiryMinutes: "1440",
  recipient: RECIPIENT,
  executor: EXECUTOR,
};

/** The message of the InputError `run` throws. */
function inputError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof InputError, String(error));
    return error.message;
  }
  assert.fail("no InputError was thrown");
}

describe("web dormant limit form", () => {
  it("reads amounts and prices as viem's parseUnits does, the activation price too", () => {
    const values = parseDormantForm(DORMANT, DECIMALS);
    assert.equal(values.usdcAmount, parseUnits("100", 6));
    assert.equal(values.targetPrice, parseUnits("1900", 8));
    assert.equal(values.activationPrice, parseUnits("2100.5", 8));
    assert.equal(values.expiryMinutes, 60n);
    assert.equal(values.recipient, getAddress(RECIPIENT));
    assert.equal(values.executor, EXECUTOR);
  });

  it("the activation price is required", () => {
    for (const blank of ["", "   "]) {
      assert.equal(
        inputError(() =>
          parseDormantForm({ ...DORMANT, activationPriceUsd: blank }, DECIMALS),
        ),
        "Activation price is required.",
      );
    }
  });

  it("an activation price of 0 is passed on, for the contract to refuse", () => {
    const values = parseDormantForm(
      { ...DORMANT, activationPriceUsd: "0" },
      DECIMALS,
    );
    assert.equal(values.activationPrice, 0n);
  });

  it("names each field that is wrong", () => {
    for (const [field, value, start] of [
      ["usdc", "-1", "Amount "],
      ["targetPriceUsd", "abc", "Target price "],
      ["activationPriceUsd", "1.123456789", "Activation price "],
      ["expiryMinutes", "0", "Valid for "],
      ["recipient", "0x12", "Recipient "],
      ["executor", "", "Executor "],
    ] as const) {
      const message = inputError(() =>
        parseDormantForm({ ...DORMANT, [field]: value }, DECIMALS),
      );
      assert.ok(message.startsWith(start), `${field}: ${message}`);
    }
  });
});

describe("web Dca form", () => {
  it("reads the amount per period and the cap as viem's parseUnits does", () => {
    const values = parseDcaForm(DCA, DECIMALS);
    assert.equal(values.usdcPerPeriod, parseUnits("10.25", 6));
    assert.equal(values.targetPrice, parseUnits("2100", 8));
    assert.equal(values.periodCount, 3n);
    assert.equal(values.recipient, getAddress(RECIPIENT));
    assert.equal(values.executor, EXECUTOR);
  });

  it("turns whole days into seconds: days times 86400", () => {
    assert.equal(SECONDS_PER_DAY, 86400n);
    assert.equal(parseDcaForm(DCA, DECIMALS).periodLength, 86400n);
    assert.equal(
      parseDcaForm({ ...DCA, everyDays: "7" }, DECIMALS).periodLength,
      7n * 86400n,
    );
  });

  it("always starts at 0: the block that places the order", () => {
    assert.equal(parseDcaForm(DCA, DECIMALS).startAt, 0n);
  });

  it("an activation price left empty or 0 means none: 0", () => {
    for (const none of ["", " ", "0", "0.0"]) {
      assert.equal(
        parseDcaForm({ ...DCA, activationPriceUsd: none }, DECIMALS)
          .activationPrice,
        0n,
        JSON.stringify(none),
      );
    }
    assert.equal(
      parseDcaForm({ ...DCA, activationPriceUsd: "2150" }, DECIMALS)
        .activationPrice,
      parseUnits("2150", 8),
    );
  });

  it("names each field that is wrong", () => {
    for (const [field, value, start] of [
      ["usdcPerPeriod", "", "USDC per period "],
      ["priceCapUsd", "1e3", "Price cap "],
      ["everyDays", "0", "Every (days) "],
      ["everyDays", "1.5", "Every (days) "],
      ["periods", "0", "Periods "],
      ["periods", "two", "Periods "],
      ["activationPriceUsd", "-5", "Activation price "],
      ["recipient", "", "Recipient "],
      ["executor", "0xzz", "Executor "],
    ] as const) {
      const message = inputError(() =>
        parseDcaForm({ ...DCA, [field]: value }, DECIMALS),
      );
      assert.ok(message.startsWith(start), `${field}: ${message}`);
    }
  });

  it("does not check the contract's rules: more periods than the contract allows pass", () => {
    assert.equal(
      parseDcaForm({ ...DCA, periods: "53" }, DECIMALS).periodCount,
      53n,
    );
  });
});

describe("web Ladder form", () => {
  it("reads each tier's price and amount as viem's parseUnits does, in order", () => {
    const values = parseLadderForm(LADDER, DECIMALS);
    assert.deepEqual(values.tiers, [
      { price: parseUnits("1950", 8), usdcAmount: parseUnits("10", 6) },
      { price: parseUnits("1900.25", 8), usdcAmount: parseUnits("15.5", 6) },
      { price: parseUnits("1850", 8), usdcAmount: parseUnits("20", 6) },
    ]);
    assert.equal(values.expiryMinutes, 1440n);
    assert.equal(values.recipient, getAddress(RECIPIENT));
  });

  it("an activation price left empty or 0 means none: 0", () => {
    for (const none of ["", "0"]) {
      assert.equal(
        parseLadderForm({ ...LADDER, activationPriceUsd: none }, DECIMALS)
          .activationPrice,
        0n,
      );
    }
    assert.equal(
      parseLadderForm({ ...LADDER, activationPriceUsd: "1800" }, DECIMALS)
        .activationPrice,
      parseUnits("1800", 8),
    );
  });

  it("every tier row shown must be filled in, and the message names the tier, counted from 0", () => {
    const withTier = (
      index: number,
      tier: { priceUsd: string; usdc: string },
    ) => ({
      ...LADDER,
      tiers: LADDER.tiers.map((t, i) => (i === index ? tier : t)),
    });
    assert.equal(
      inputError(() =>
        parseLadderForm(withTier(1, { priceUsd: "", usdc: "15" }), DECIMALS),
      ),
      "Tier 1 price is required.",
    );
    assert.equal(
      inputError(() =>
        parseLadderForm(withTier(2, { priceUsd: "1850", usdc: " " }), DECIMALS),
      ),
      "Tier 2 amount is required.",
    );
    assert.ok(
      inputError(() =>
        parseLadderForm(withTier(0, { priceUsd: "x", usdc: "10" }), DECIMALS),
      ).startsWith("Tier 0 price "),
    );
    assert.ok(
      inputError(() =>
        parseLadderForm(
          withTier(0, { priceUsd: "1950", usdc: "1.1234567" }),
          DECIMALS,
        ),
      ).startsWith("Tier 0 amount "),
    );
  });

  it("names each of the other fields that is wrong", () => {
    for (const [field, value, start] of [
      ["activationPriceUsd", "abc", "Activation price "],
      ["expiryMinutes", "", "Valid for "],
      ["recipient", "nope", "Recipient "],
      ["executor", "", "Executor "],
    ] as const) {
      const message = inputError(() =>
        parseLadderForm({ ...LADDER, [field]: value }, DECIMALS),
      );
      assert.ok(message.startsWith(start), `${field}: ${message}`);
    }
  });

  it("does not check the contract's rules: prices that go up pass", () => {
    const values = parseLadderForm(
      {
        ...LADDER,
        tiers: [
          { priceUsd: "1900", usdc: "10" },
          { priceUsd: "1950", usdc: "10" },
        ],
      },
      DECIMALS,
    );
    assert.equal(values.tiers.length, 2);
  });
});

describe("web order budget: what the allowance must cover", () => {
  it("a limit or dormant limit order: its amount", () => {
    assert.equal(
      budgetOf({ kind: FormKind.Limit, usdcAmount: 100_000_000n }),
      100_000_000n,
    );
    assert.equal(
      budgetOf({ kind: FormKind.DormantLimit, usdcAmount: 10_000_000n }),
      10_000_000n,
    );
  });

  it("a Dca order: the amount per period times the periods", () => {
    assert.equal(
      budgetOf({
        kind: FormKind.Dca,
        usdcPerPeriod: 10_000_000n,
        periodCount: 3n,
      }),
      30_000_000n,
    );
  });

  it("a Ladder order: the tiers' amounts added up", () => {
    const values = parseLadderForm(LADDER, DECIMALS);
    assert.equal(
      budgetOf({ kind: FormKind.Ladder, tiers: values.tiers }),
      parseUnits("45.5", 6),
    );
  });
});

describe("web Ladder tier rows: adding and removing", () => {
  it("a row may be added only below the contract's most tiers", () => {
    assert.equal(canAddTier(2, 5n), true);
    assert.equal(canAddTier(4, 5n), true);
    assert.equal(canAddTier(5, 5n), false);
    assert.equal(canAddTier(6, 5n), false);
  });

  it("no row may be added while the most tiers is unknown", () => {
    assert.equal(canAddTier(1, undefined), false);
  });

  it("a row may be removed only while more than one is left", () => {
    assert.equal(canRemoveTier(2), true);
    assert.equal(canRemoveTier(1), false);
  });
});
