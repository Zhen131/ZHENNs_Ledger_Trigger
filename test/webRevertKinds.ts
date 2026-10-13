import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeErrorResult, type Abi, type AbiParameter } from "viem";

import { loadAbis } from "../keeper/abi.ts";
import {
  AS_IS_ARGUMENTS,
  COUNT_ARGUMENTS,
  PRICE_ARGUMENTS,
  USDC_ARGUMENTS,
  WHOLE_ARGUMENTS,
  describeRevertData,
} from "../web/src/lib/revert.ts";

// The errors the second version added to the order contract, encoded from the
// compiled contract's ABI and decoded the way the page decodes them; and a
// guard that every integer argument of every error is written in one unit.

const ABI = loadAbis().trigger as unknown as Abi;
const DECIMALS = { usdc: 6, price: 8 };
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function revertText(errorName: string, args: readonly unknown[] = []) {
  return describeRevertData(
    encodeErrorResult({ abi: ABI, errorName, args }),
    ABI,
    DECIMALS,
  );
}

type ErrorItem = {
  readonly type: "error";
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
};

const ERRORS = ABI.filter((item): item is ErrorItem => item.type === "error");

function isInteger(parameter: AbiParameter): boolean {
  return /^u?int\d*$/.test(parameter.type);
}

describe("web revert words: the second version's errors", () => {
  it("activation: prices in USD with the price decimals", () => {
    assert.equal(
      revertText("PriceBelowActivation", [200_000_000_000n, 210_000_000_000n]),
      "PriceBelowActivation(price: 2000.00, activationPrice: 2100.00)",
    );
    assert.equal(
      revertText("ActivationNotAboveTarget", [
        150_000_000_000n,
        150_000_000_000n,
      ]),
      "ActivationNotAboveTarget(activationPrice: 1500.00, targetPrice: 1500.00)",
    );
    assert.equal(
      revertText("OrderNotDormant", [5n, 3]),
      "OrderNotDormant(orderId: 5, status: 3)",
    );
  });

  it("Dca: counts, period numbers and times as they are", () => {
    assert.equal(
      revertText("TooManyPeriods", [53n, 52n]),
      "TooManyPeriods(periodCount: 53, maxPeriods: 52)",
    );
    assert.equal(
      revertText("StartInPast", [1_700_000_000n, 1_700_000_100n]),
      "StartInPast(startAt: 1700000000, currentTime: 1700000100)",
    );
    assert.equal(
      revertText("NotStarted", [2n, 1_700_000_000n]),
      "NotStarted(orderId: 2, startAt: 1700000000)",
    );
    assert.equal(
      revertText("PeriodAlreadyFilled", [2n, 0n]),
      "PeriodAlreadyFilled(orderId: 2, periodIndex: 0)",
    );
    assert.equal(revertText("NotADcaOrder", [1n]), "NotADcaOrder(orderId: 1)");
    assert.equal(revertText("ZeroPeriodLength"), "ZeroPeriodLength()");
    assert.equal(revertText("ZeroPeriodCount"), "ZeroPeriodCount()");
  });

  it("Ladder: tier counts and tier numbers as they are", () => {
    assert.equal(revertText("NoTiers"), "NoTiers()");
    assert.equal(
      revertText("TooManyTiers", [6n, 5n]),
      "TooManyTiers(tierCount: 6, maxTiers: 5)",
    );
    assert.equal(
      revertText("TiersNotDescending", [1n]),
      "TiersNotDescending(tierIndex: 1)",
    );
    assert.equal(
      revertText("NotALadderOrder", [4n]),
      "NotALadderOrder(orderId: 4)",
    );
  });

  it("deployment: the new limits and the receipt contract", () => {
    assert.equal(
      revertText("ZeroMaxPeriodsPerOrder"),
      "ZeroMaxPeriodsPerOrder()",
    );
    assert.equal(revertText("ZeroMaxTiersPerOrder"), "ZeroMaxTiersPerOrder()");
    assert.equal(revertText("ZeroReceipt"), "ZeroReceipt()");
    assert.equal(
      revertText("ReceiptNotBound", [OTHER, OWNER]),
      "ReceiptNotBound(receipt: 0x90F7…b906, boundTo: 0xf39F…2266)",
    );
  });

  it("the amount of EthTransferFailed is wei, written as it is", () => {
    assert.equal(
      revertText("EthTransferFailed", [RECIPIENT, 52_631_578_947_368_421n]),
      "EthTransferFailed(recipient: 0x3C44…93BC, amount: 52631578947368421)",
    );
  });
});

describe("web revert units: every integer argument has exactly one unit", () => {
  const LISTS: Readonly<Record<string, readonly string[]>> = {
    PRICE_ARGUMENTS,
    USDC_ARGUMENTS,
    WHOLE_ARGUMENTS,
    AS_IS_ARGUMENTS,
  };

  it("each integer argument of each error is in exactly one of the four lists, or named in COUNT_ARGUMENTS", () => {
    let checked = 0;
    for (const error of ERRORS) {
      for (const input of error.inputs.filter(isInteger)) {
        const name = input.name ?? "";
        checked += 1;
        if (COUNT_ARGUMENTS.includes(`${error.name}.${name}`)) continue;
        const homes = Object.entries(LISTS)
          .filter(([, list]) => list.includes(name))
          .map(([listName]) => listName);
        assert.equal(
          homes.length,
          1,
          `${error.name}.${name} is in ${homes.length === 0 ? "no list" : homes.join(" and ")}`,
        );
      }
    }
    assert.ok(checked > 0, "the ABI has errors with integer arguments");
  });

  it("every name in the lists, and every pair in COUNT_ARGUMENTS, is an integer argument of some error", () => {
    const names = new Set<string>();
    const pairs = new Set<string>();
    for (const error of ERRORS) {
      for (const input of error.inputs.filter(isInteger)) {
        names.add(input.name ?? "");
        pairs.add(`${error.name}.${input.name ?? ""}`);
      }
    }
    for (const [listName, list] of Object.entries(LISTS)) {
      for (const name of list) {
        assert.ok(
          names.has(name),
          `${listName} names ${name}, no error has it`,
        );
      }
    }
    for (const pair of COUNT_ARGUMENTS) {
      assert.ok(pairs.has(pair), `COUNT_ARGUMENTS names ${pair}`);
    }
  });

  it("each integer argument is written in the unit of its list", () => {
    const value = 123_456_789n;
    const expected = (errorName: string, name: string): string => {
      if (COUNT_ARGUMENTS.includes(`${errorName}.${name}`)) return "123456789";
      if (PRICE_ARGUMENTS.includes(name)) return "1.23456789";
      if (USDC_ARGUMENTS.includes(name)) return "123.456789";
      return "123456789";
    };
    for (const error of ERRORS) {
      if (!error.inputs.some(isInteger)) continue;
      const args = error.inputs.map((input) =>
        input.type === "address" ? OWNER : input.type === "uint8" ? 123 : value,
      );
      const parts = error.inputs.map((input, index) => {
        const name = input.name ?? `${index}`;
        const shown =
          input.type === "address"
            ? "0xf39F…2266"
            : input.type === "uint8"
              ? "123"
              : expected(error.name, name);
        return `${name}: ${shown}`;
      });
      assert.equal(
        revertText(error.name, args),
        `${error.name}(${parts.join(", ")})`,
      );
    }
  });
});
