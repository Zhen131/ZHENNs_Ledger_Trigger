import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseUnits } from "viem";

import {
  InputError,
  formatAmount,
  formatFixed,
  parseDecimal,
  parseWhole,
} from "../web/src/lib/amounts.ts";
import { expiryFrom, parseOrderForm } from "../web/src/lib/orderForm.ts";

// The page turns typed numbers into the contract's whole numbers with its own
// copy of the scripts' rules. These tests compare it with viem's parseUnits,
// which the scripts use, and check that bad input is refused.

const DECIMALS = { usdc: 6, price: 8 };

describe("web amounts: typed numbers to whole numbers and back", () => {
  it("parses like viem's parseUnits, for USDC and for prices", () => {
    for (const text of ["0", "1", "100", "12.5", "0.000001", "499.999999"]) {
      assert.equal(parseDecimal(text, 6, "Amount"), parseUnits(text, 6), text);
    }
    for (const text of ["1500", "2412.75", "0.00000001", "1999.99999999"]) {
      assert.equal(parseDecimal(text, 8, "Price"), parseUnits(text, 8), text);
    }
  });

  it("ignores spaces around the number", () => {
    assert.equal(parseDecimal("  100 ", 6, "Amount"), 100_000_000n);
  });

  it("round trip: formatting the parsed value gives the same number back", () => {
    for (const [text, decimals, shown] of [
      ["100", 6, "100.00"],
      ["12.5", 6, "12.50"],
      ["12.345678", 6, "12.345678"],
      ["1500", 8, "1500.00"],
      ["2412.75", 8, "2412.75"],
      ["0.00000001", 8, "0.00000001"],
    ] as const) {
      const parsed = parseDecimal(text, decimals, "Value");
      assert.equal(formatAmount(parsed, decimals), shown);
      assert.equal(parseDecimal(shown, decimals, "Value"), parsed);
    }
  });

  it("refuses anything that is not a plain decimal number, naming the field", () => {
    for (const text of [
      "",
      "  ",
      "abc",
      "-1",
      "+1",
      "1e5",
      "1.2.3",
      ".5",
      "5.",
      "1,000",
      "0x10",
      "１００",
    ]) {
      assert.throws(
        () => parseDecimal(text, 6, "Amount"),
        (error: unknown) =>
          error instanceof InputError &&
          error.message.startsWith("Amount must be a plain number"),
        JSON.stringify(text),
      );
    }
  });

  it("refuses more digits after the dot than the unit has", () => {
    assert.throws(
      () => parseDecimal("1.1234567", 6, "Amount"),
      (error: unknown) =>
        error instanceof InputError &&
        error.message ===
          "Amount has 7 digits after the dot; at most 6 are allowed.",
    );
    assert.equal(parseDecimal("1.123456", 6, "Amount"), 1_123_456n);
  });

  it("parses whole numbers of at least the minimum and refuses the rest", () => {
    assert.equal(parseWhole("60", 1n, "Valid for"), 60n);
    assert.equal(parseWhole(" 1 ", 1n, "Valid for"), 1n);
    for (const text of ["0", "", "1.5", "-3", "ten", "1e2"]) {
      assert.throws(
        () => parseWhole(text, 1n, "Valid for"),
        (error: unknown) =>
          error instanceof InputError &&
          error.message === "Valid for must be a whole number of at least 1.",
        JSON.stringify(text),
      );
    }
  });

  it("formats exactly, with at least two digits after the dot", () => {
    assert.equal(formatAmount(0n, 6), "0.00");
    assert.equal(formatAmount(1_000_000_000n, 6), "1000.00");
    assert.equal(formatAmount(1n, 6), "0.000001");
    assert.equal(formatAmount(-5n, 8), "-0.00000005");
    assert.equal(formatAmount(5n, 0), "5.00");
  });

  it("rounds to a fixed number of digits, halves away from zero", () => {
    assert.equal(formatFixed(200_000_000_000n, 8, 2), "2000.00");
    assert.equal(formatFixed(199_999_500_000n, 8, 2), "2000.00");
    assert.equal(formatFixed(199_999_499_999n, 8, 2), "1999.99");
    assert.equal(formatFixed(52_631_578_947_368_421n, 18, 6), "0.052632");
    assert.equal(formatFixed(-150_000_000n, 8, 2), "-1.50");
    assert.equal(formatFixed(-1n, 8, 2), "0.00");
    assert.equal(formatFixed(12n, 1, 3), "1.200");
  });
});

describe("web order form: the five fields in the contract's units", () => {
  const form = {
    usdc: "100",
    targetPriceUsd: "1500",
    expiryMinutes: "60",
    recipient: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    executor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  };

  it("turns the amount and target price into whole numbers like parseUnits", () => {
    const values = parseOrderForm(form, DECIMALS);
    assert.equal(values.usdcAmount, parseUnits("100", 6));
    assert.equal(values.targetPrice, parseUnits("1500", 8));
    assert.equal(values.expiryMinutes, 60n);
  });

  it("accepts addresses in any letter case and returns them checksummed", () => {
    const values = parseOrderForm(form, DECIMALS);
    assert.equal(
      values.recipient,
      "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    );
    assert.equal(values.executor, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("names the field that cannot be read", () => {
    const cases: [Partial<typeof form>, string][] = [
      [{ usdc: "ten" }, "Amount must be a plain number"],
      [{ targetPriceUsd: "1500.123456789" }, "Target price has 9 digits"],
      [{ expiryMinutes: "0" }, "Valid for must be a whole number"],
      [{ recipient: "" }, "Recipient is required."],
      [{ executor: "0x1234" }, "Executor must be an address"],
    ];
    for (const [change, start] of cases) {
      assert.throws(
        () => parseOrderForm({ ...form, ...change }, DECIMALS),
        (error: unknown) =>
          error instanceof InputError && error.message.startsWith(start),
        start,
      );
    }
  });

  it("counts the expiry from the latest block's time", () => {
    assert.equal(expiryFrom(1_000_000n, 60n), 1_003_600n);
  });
});
