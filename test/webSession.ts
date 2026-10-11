import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCOUNT_RESETS,
  NO_SESSION,
  Reset,
  accountsChanged,
  chainChanged,
  checkChain,
} from "../web/src/lib/session.ts";

// When the wallet switches accounts, everything that belonged to the old
// account must be read again; when it switches chains, the chain check runs
// again. These tests pin down what is reset when.

const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT_3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

describe("web session: account changes", () => {
  it("connecting resets every part that belongs to the account", () => {
    const { session, resets } = accountsChanged(NO_SESSION, [
      ACCOUNT_0.toLowerCase(),
    ]);
    assert.equal(session.account, ACCOUNT_0);
    assert.deepEqual(resets, ACCOUNT_RESETS);
    assert.deepEqual(
      [...ACCOUNT_RESETS].sort(),
      [
        Reset.FormMessage,
        Reset.LookupOwnership,
        Reset.MyBalances,
        Reset.MyOrders,
        Reset.RowMessages,
      ].sort(),
    );
  });

  it("switching to another account resets them all, the not-yours mark included", () => {
    const before = { account: ACCOUNT_0, walletChainId: 31337 } as const;
    const { session, resets } = accountsChanged(before, [ACCOUNT_3, ACCOUNT_0]);
    assert.equal(session.account, ACCOUNT_3);
    assert.equal(session.walletChainId, 31337);
    assert.ok(resets.includes(Reset.MyOrders));
    assert.ok(resets.includes(Reset.MyBalances));
    assert.ok(resets.includes(Reset.LookupOwnership));
  });

  it("the same account again, in any letter case, resets nothing", () => {
    const before = { account: ACCOUNT_0, walletChainId: 31337 } as const;
    assert.deepEqual(
      accountsChanged(before, [ACCOUNT_0.toLowerCase()]).resets,
      [],
    );
  });

  it("an empty list or a non-address disconnects, and resets everything", () => {
    const before = { account: ACCOUNT_0, walletChainId: 31337 } as const;
    for (const accounts of [[], ["not an address"], [42]]) {
      const { session, resets } = accountsChanged(before, accounts);
      assert.equal(session.account, undefined);
      assert.deepEqual(resets, ACCOUNT_RESETS);
    }
    assert.deepEqual(accountsChanged(NO_SESSION, []).resets, []);
  });
});

describe("web session: chain changes", () => {
  it("reads hex and number chain IDs, and asks for a new check when it changed", () => {
    const first = chainChanged(NO_SESSION, "0x7a69");
    assert.equal(first.session.walletChainId, 31337);
    assert.equal(first.recheck, true);
    assert.equal(chainChanged(first.session, 31337).recheck, false);
    const moved = chainChanged(first.session, "0xaa36a7");
    assert.equal(moved.session.walletChainId, 11155111);
    assert.equal(moved.recheck, true);
  });

  it("an unreadable chain ID counts as unknown and is checked again", () => {
    const { session, recheck } = chainChanged(NO_SESSION, "mainnet");
    assert.equal(session.walletChainId, undefined);
    assert.equal(recheck, true);
  });

  it("the check passes only when the wallet and the node are on the same chain", () => {
    assert.deepEqual(checkChain(31337, 31337), { ok: true });
    const other = checkChain(11155111, 31337);
    assert.equal(other.ok, false);
    assert.match(other.ok ? "" : other.message, /chain 11155111.*chain 31337/);
    const unknown = checkChain(undefined, 31337);
    assert.match(unknown.ok ? "" : unknown.message, /an unknown chain/);
  });
});
