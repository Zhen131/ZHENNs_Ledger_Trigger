import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { limitsText } from "../web/src/lib/limits.ts";

// The line under the contract address names the four deployment limits.

describe("web contract limits line", () => {
  it("writes the most per fill in USDC and the three counts as they are", () => {
    assert.equal(
      limitsText(
        {
          maxOrderAmount: 500_000_000n,
          maxOpenOrdersPerOwner: 5n,
          maxPeriodsPerOrder: 52n,
          maxTiersPerOrder: 5n,
        },
        6,
      ),
      "Limits of this contract: up to 500.00 USDC per fill · up to 5 unfinished orders per owner · Dca up to 52 periods · Ladder up to 5 tiers",
    );
  });

  it("follows the USDC decimals the contract reports", () => {
    assert.equal(
      limitsText(
        {
          maxOrderAmount: 1_234_567n,
          maxOpenOrdersPerOwner: 2n,
          maxPeriodsPerOrder: 2n,
          maxTiersPerOrder: 3n,
        },
        6,
      ),
      "Limits of this contract: up to 1.234567 USDC per fill · up to 2 unfinished orders per owner · Dca up to 2 periods · Ladder up to 3 tiers",
    );
    assert.ok(
      limitsText(
        {
          maxOrderAmount: 500n,
          maxOpenOrdersPerOwner: 5n,
          maxPeriodsPerOrder: 52n,
          maxTiersPerOrder: 5n,
        },
        2,
      ).startsWith("Limits of this contract: up to 5.00 USDC per fill"),
    );
  });
});
