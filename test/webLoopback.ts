import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_RPC_URL,
  isLoopbackUrl,
  rpcUrlFrom,
} from "../web/src/lib/loopback.ts";

// The page and its development stand-in only ever talk to a node on this
// computer. These tests pin down which node URLs count as such.

describe("web loopback rule: only a node on this computer", () => {
  it("accepts the three ways of writing this computer, over http or https", () => {
    for (const url of [
      "http://127.0.0.1:8545",
      "http://localhost:8545",
      "http://[::1]:8545",
      "https://127.0.0.1:8545",
      "http://localhost",
      "http://LOCALHOST:8545/",
    ]) {
      assert.equal(isLoopbackUrl(url), true, url);
    }
  });

  it("refuses every other host, scheme or form", () => {
    for (const url of [
      "http://127.0.0.2:8545",
      "http://0.0.0.0:8545",
      "http://192.168.1.20:8545",
      "http://[::2]:8545",
      "http://localhost.example.com:8545",
      "http://127.0.0.1.example.com:8545",
      "https://node.example.com",
      ["http:", "//user:pass@localhost:8545"].join(""),
      "ws://localhost:8545",
      "file:///tmp/node",
      "localhost:8545",
      "not a url",
      "",
    ]) {
      assert.equal(isLoopbackUrl(url), false, url);
    }
  });

  it("uses the default node when the address bar names none", () => {
    assert.deepEqual(rpcUrlFrom(""), { ok: true, url: DEFAULT_RPC_URL });
    assert.deepEqual(rpcUrlFrom("?contract=0x1"), {
      ok: true,
      url: DEFAULT_RPC_URL,
    });
    assert.deepEqual(rpcUrlFrom("?rpc="), { ok: true, url: DEFAULT_RPC_URL });
    assert.equal(DEFAULT_RPC_URL, "http://127.0.0.1:8545");
  });

  it("takes a loopback node from the address bar and refuses any other", () => {
    assert.deepEqual(rpcUrlFrom("?rpc=http://localhost:9545"), {
      ok: true,
      url: "http://localhost:9545",
    });
    const refused = rpcUrlFrom("?rpc=https://node.example.com");
    assert.equal(refused.ok, false);
    assert.match(
      refused.ok ? "" : refused.message,
      /not a node on this computer/,
    );
  });
});
