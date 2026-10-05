import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  BaseError,
  InsufficientFundsError,
  TransactionExecutionError,
  type Address,
} from "viem";

import { ScriptError, describeFailure } from "../scripts/scriptError.ts";

// What a script prints when it stops. A made-up node URL with a made-up key
// is put into each error, so the tests can check it never comes out.

const URL_KEY = randomBytes(16).toString("hex");
const SECRET_URL = `http://127.0.0.1:1/v3/${URL_KEY}`;

describe("script failures in plain words", () => {
  it("says the sending account lacks ETH when the node reports insufficient funds, without the library's message", () => {
    const inner = new InsufficientFundsError({
      cause: new BaseError(`insufficient funds at ${SECRET_URL}`),
    });
    const outer = new TransactionExecutionError(inner, {
      account: {
        address: "0x0000000000000000000000000000000000000001" as Address,
        type: "json-rpc",
      },
    });

    const text = describeFailure(outer);

    assert.equal(
      text,
      "The sending account does not hold enough ETH to pay for this transaction. Get test ETH for it from a faucet, then run the script again.",
    );
    assert.ok(!text.includes(URL_KEY));
  });

  it("still prints its own sentence for a ScriptError, and only class names for an error it does not know", () => {
    assert.equal(describeFailure(new ScriptError("Own words.")), "Own words.");
    const text = describeFailure(new Error(`failed at ${SECRET_URL}`));
    assert.match(
      text,
      /^The script stopped on an error it did not expect \(Error\)/,
    );
    assert.ok(!text.includes(URL_KEY));
  });
});
