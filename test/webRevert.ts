import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeErrorResult,
  type Abi,
  type Hex,
} from "viem";

import { loadAbis } from "../keeper/abi.ts";
import {
  RAW_MESSAGE_LIMIT,
  describeFailure,
  describeRevertData,
} from "../web/src/lib/revert.ts";

// The page shows a rejected call as the contract's error name and arguments,
// each argument in its unit. The revert data here is encoded from the
// compiled contract's ABI, the same ABI the page decodes with.

const ABI = loadAbis().trigger as unknown as Abi;
const DECIMALS = { usdc: 6, price: 8 };
const CALLER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function data(errorName: string, args: readonly unknown[] = []): Hex {
  return encodeErrorResult({ abi: ABI, errorName, args });
}

function revertText(errorName: string, args: readonly unknown[] = []) {
  return describeRevertData(data(errorName, args), ABI, DECIMALS);
}

describe("web revert words: named errors, each kind of argument", () => {
  it("prices in USD with the price decimals", () => {
    assert.equal(
      revertText("PriceAboveTarget", [160_000_000_000n, 150_000_000_000n]),
      "PriceAboveTarget(price: 1600.00, targetPrice: 1500.00)",
    );
    assert.equal(
      revertText("InvalidPrice", [-5n]),
      "InvalidPrice(price: -0.00000005)",
    );
  });

  it("amounts in USDC with the USDC decimals", () => {
    assert.equal(
      revertText("AmountAboveMax", [600_000_000n, 500_000_000n]),
      "AmountAboveMax(amount: 600.00, max: 500.00)",
    );
    assert.equal(
      revertText("InsufficientAllowance", [99_500_000n, 100_000_000n]),
      "InsufficientAllowance(allowance: 99.50, needed: 100.00)",
    );
    assert.equal(
      revertText("InsufficientBalance", [1n, 100_000_000n]),
      "InsufficientBalance(balance: 0.000001, needed: 100.00)",
    );
  });

  it("times and ages as plain whole numbers", () => {
    assert.equal(
      revertText("ExpiryNotInFuture", [1_700_000_000n, 1_700_000_100n]),
      "ExpiryNotInFuture(expiry: 1700000000, currentTime: 1700000100)",
    );
    assert.equal(
      revertText("StalePrice", [1_700_000_000n, 4_500n]),
      "StalePrice(updatedAt: 1700000000, maxPriceAge: 4500)",
    );
    assert.equal(
      revertText("OrderExpired", [3n, 1_700_000_000n]),
      "OrderExpired(orderId: 3, expiry: 1700000000)",
    );
  });

  it("addresses shortened", () => {
    assert.equal(
      revertText("NotOrderOwnerOrExecutor", [1n, CALLER]),
      "NotOrderOwnerOrExecutor(orderId: 1, caller: 0x90F7…b906)",
    );
    assert.equal(
      revertText("NotOrderOwner", [1n, CALLER]),
      "NotOrderOwner(orderId: 1, caller: 0x90F7…b906)",
    );
  });

  it("the max of TooManyOpenOrders is a number of orders, not USDC", () => {
    assert.equal(
      revertText("TooManyOpenOrders", [OWNER, 5n]),
      "TooManyOpenOrders(owner: 0xf39F…2266, max: 5)",
    );
  });

  it("anything else as it is: order IDs, statuses, wei", () => {
    assert.equal(
      revertText("OrderNotFound", [99n]),
      "OrderNotFound(orderId: 99)",
    );
    assert.equal(
      revertText("OrderNotOpen", [1n, 2]),
      "OrderNotOpen(orderId: 1, status: 2)",
    );
    assert.equal(
      revertText("InsufficientEthOut", [10n, 11n]),
      "InsufficientEthOut(received: 10, minEthOut: 11)",
    );
  });

  it("an error without arguments", () => {
    assert.equal(revertText("ZeroAmount"), "ZeroAmount()");
  });

  it("revert data no error of the ABI matches gives nothing", () => {
    assert.equal(describeRevertData("0x12345678", ABI, DECIMALS), undefined);
    assert.equal(describeRevertData("0x", ABI, DECIMALS), undefined);
  });
});

describe("web failure words: what the page shows for a failed call", () => {
  it("a revert carried by viem's errors is decoded by name", () => {
    const revert = new ContractFunctionRevertedError({
      abi: ABI,
      data: data("PriceAboveTarget", [160_000_000_000n, 150_000_000_000n]),
      functionName: "fillOrder",
    });
    const wrapped = new ContractFunctionExecutionError(revert, {
      abi: ABI,
      functionName: "fillOrder",
      args: [1n],
    });
    for (const error of [revert, wrapped]) {
      assert.deepEqual(describeFailure(error, ABI, DECIMALS), {
        kind: "error",
        text: "PriceAboveTarget(price: 1600.00, targetPrice: 1500.00)",
      });
    }
  });

  it("revert data on a node error's data field is decoded too", () => {
    const nodeError = Object.assign(new Error("execution reverted"), {
      data: data("NotOrderOwner", [1n, CALLER]),
    });
    assert.deepEqual(describeFailure(nodeError, ABI, DECIMALS), {
      kind: "error",
      text: "NotOrderOwner(orderId: 1, caller: 0x90F7…b906)",
    });
  });

  it("an error without a name shows the first characters of its message", () => {
    const long = `Something unexpected happened ${"x".repeat(200)}`;
    const view = describeFailure(new Error(long), ABI, DECIMALS);
    assert.deepEqual(view, {
      kind: "error",
      text: long.slice(0, RAW_MESSAGE_LIMIT),
    });
    assert.equal(RAW_MESSAGE_LIMIT, 120);
    const unknown = new ContractFunctionRevertedError({
      abi: ABI,
      data: "0x12345678",
      functionName: "fillOrder",
    });
    const shown = describeFailure(unknown, ABI, DECIMALS);
    assert.equal(shown.kind, "error");
    assert.ok(shown.kind === "error" && shown.text.length <= RAW_MESSAGE_LIMIT);
    assert.equal(describeFailure("plain text", ABI, DECIMALS).kind, "error");
  });

  it("the user saying no in the wallet (code 4001) is told apart, however wrapped", () => {
    const rejected = new UserRejectedRequestError(new Error("denied"));
    const wrapped = new BaseError("could not send", { cause: rejected });
    const raw = Object.assign(new Error("User rejected the request."), {
      code: 4001,
    });
    for (const error of [rejected, wrapped, raw, { code: 4001 }]) {
      assert.deepEqual(describeFailure(error, ABI, DECIMALS), {
        kind: "user-rejected",
      });
    }
  });
});
