import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as guard from "../scripts/networkGuard.ts";
import { READ_ONLY_METHODS } from "../scripts/networkGuard.ts";

// The network guard lets the methods in its read-only list through on any
// chain. No other module may be able to change that list: every object the
// guard exports is frozen, down to the arrays inside it, and none of them is a
// Set or a Map, whose contents freezing does not protect. Nothing here
// connects to any network.

const SENDS = "eth_sendTransaction";

describe("network guard: the read-only list cannot be changed from outside", () => {
  it("is a frozen object with a frozen array: nothing can be added, taken out or swapped in", () => {
    assert.equal(Object.isFrozen(READ_ONLY_METHODS), true);
    assert.equal(Object.isFrozen(READ_ONLY_METHODS.methods), true);
    assert.equal(READ_ONLY_METHODS instanceof Set, false);

    assert.throws(() => {
      (READ_ONLY_METHODS as { has: unknown }).has = () => true;
    }, TypeError);
    assert.throws(() => {
      (READ_ONLY_METHODS as Record<string, unknown>).add = () => undefined;
    }, TypeError);
    assert.throws(() => {
      (READ_ONLY_METHODS.methods as string[]).push(SENDS);
    }, TypeError);
    assert.throws(() => {
      (READ_ONLY_METHODS.methods as string[])[0] = SENDS;
    }, TypeError);
    assert.throws(() => {
      Set.prototype.add.call(READ_ONLY_METHODS as never, SENDS);
    }, TypeError);

    assert.equal(READ_ONLY_METHODS.has(SENDS), false);
    assert.equal(READ_ONLY_METHODS.methods.includes(SENDS), false);
  });

  it("answers has() for exactly the methods it lists", () => {
    assert.ok(READ_ONLY_METHODS.methods.length > 0);
    for (const method of READ_ONLY_METHODS.methods) {
      assert.equal(READ_ONLY_METHODS.has(method), true, method);
    }
    for (const method of [SENDS, "eth_sendRawTransaction", "evm_mine", ""]) {
      assert.equal(READ_ONLY_METHODS.has(method), false, method);
    }
  });

  it("exports no Set or Map, and no object or array that is not frozen", () => {
    for (const [name, value] of Object.entries(guard)) {
      if (typeof value !== "object" || value === null) continue;
      assert.equal(value instanceof Set, false, name);
      assert.equal(value instanceof Map, false, name);
      assert.equal(value instanceof WeakSet, false, name);
      assert.equal(value instanceof WeakMap, false, name);
      assert.equal(Object.isFrozen(value), true, name);
      for (const inner of Object.values(value)) {
        if (typeof inner === "object" && inner !== null) {
          assert.equal(Object.isFrozen(inner), true, `${name}: inner value`);
        }
      }
    }
  });
});
