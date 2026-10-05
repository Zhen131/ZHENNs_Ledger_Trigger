import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { network } from "hardhat";
import type { HardhatUserConfig } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { EIP1193RequestFn } from "viem";

import userConfig from "../hardhat.config.ts";
import { mayWrite, refusalReason } from "../scripts/networkGuard.ts";
import { ScriptError } from "../scripts/scriptError.ts";
import {
  CONFIRM_PHRASE,
  GatedScript,
  OPEN_GATE_METHOD,
  openSendGate,
  passSendGate,
} from "../scripts/sendGate.ts";
import { serveOverHttp } from "./serveOverHttp.ts";

// The send gate lets a script send only on the one Hardhat connection it
// checked itself: no stand-in client, no chain ID, no preloaded file can make
// the network guard let anything else through. A chain that is not local is
// played by an in-process chain that reports another chain ID, served over
// HTTP on 127.0.0.1. Nothing here connects to any other network, and no test
// selects sepolia.

const ROOT = path.join(import.meta.dirname, "..");
const CHILD_CONFIG_DIR = path.join(ROOT, "cache", "gate-opening-check");
const TIME_LIMIT_MS = 120_000;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
  rmSync(CHILD_CONFIG_DIR, { recursive: true, force: true });
});

/** An in-process chain reporting `chainId`. */
async function inProcessChain(chainId: number) {
  const connection = await network.create({ override: { chainId } });
  const publicClient = await connection.viem.getPublicClient();
  return {
    request: publicClient.request as unknown as EIP1193RequestFn,
    blockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
  };
}

/** `chain` served at a local URL; `serve` decides where each request goes. */
async function serve(request: EIP1193RequestFn) {
  const server = await serveOverHttp((args) => request(args as never));
  closers.push(server.close);
  return server.url;
}

/** A Hardhat runtime whose `localhost` network is `url` (and `chainId`). */
async function runtimeAt(url: string, chainId?: number) {
  const config: HardhatUserConfig = {
    ...userConfig,
    networks: {
      ...userConfig.networks,
      localhost:
        chainId === undefined
          ? { type: "http", url }
          : { type: "http", url, chainId },
    },
  };
  return createHardhatRuntimeEnvironment(config, { network: "localhost" });
}

function refused(chainId: number, method = "eth_sendTransaction") {
  const reason = refusalReason(method, "localhost", chainId);
  return (error: unknown) =>
    error instanceof Error &&
    `${error.message}\n${String(error.cause)}`.includes(reason);
}

const neverAsked = async (): Promise<number> => {
  throw new Error("the node must not be asked");
};

describe("network guard: whether a request that is not a read may go out", () => {
  it("refuses a connection whose configuration sets a chain that is not local, without asking its node, unless the gate opened it for that chain", async () => {
    assert.deepEqual(
      await mayWrite({
        configuredChainId: 11_155_111,
        openedChainId: undefined,
        askChainId: neverAsked,
      }),
      { allowed: false, chainId: 11_155_111 },
    );
    assert.deepEqual(
      await mayWrite({
        configuredChainId: 11_155_111,
        openedChainId: 999,
        askChainId: neverAsked,
      }),
      { allowed: false, chainId: 11_155_111 },
    );
    assert.deepEqual(
      await mayWrite({
        configuredChainId: 11_155_111,
        openedChainId: 11_155_111,
        askChainId: async () => 11_155_111,
      }),
      { allowed: true },
    );
  });

  it("asks the node every time otherwise, and does not take a configuration that claims the local chain on trust", async () => {
    assert.deepEqual(
      await mayWrite({
        configuredChainId: 31_337,
        openedChainId: undefined,
        askChainId: async () => 999,
      }),
      { allowed: false, chainId: 999 },
    );
    assert.deepEqual(
      await mayWrite({
        configuredChainId: undefined,
        openedChainId: undefined,
        askChainId: async () => 31_337,
      }),
      { allowed: true },
    );
  });

  it("lets an opened connection send only while its node serves the chain it was opened for", async () => {
    assert.deepEqual(
      await mayWrite({
        configuredChainId: undefined,
        openedChainId: 999,
        askChainId: async () => 999,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      await mayWrite({
        configuredChainId: undefined,
        openedChainId: 999,
        askChainId: async () => 1_000,
      }),
      { allowed: false, chainId: 1_000 },
    );
  });
});

describe("send gate: stand-in clients open nothing", () => {
  it("passSendGate with a stand-in client decides, but lets no real connection to that chain send", async () => {
    const chain = await inProcessChain(5_001);
    const url = await serve(chain.request);
    const before = await chain.blockNumber();

    const standIn = { getChainId: async () => 5_001 };
    assert.equal(
      await passSendGate(standIn, GatedScript.Deploy, CONFIRM_PHRASE),
      5_001,
    );
    const connection = await (await runtimeAt(url)).network.create();

    await assert.rejects(
      connection.viem.deployContract("MockUSDC"),
      refused(5_001),
    );
    assert.equal(await chain.blockNumber(), before);
    await connection.close();
  });

  it("openSendGate with a stand-in that claims the opening worked opens no real connection", async () => {
    const chain = await inProcessChain(5_002);
    const url = await serve(chain.request);
    const before = await chain.blockNumber();

    const liar = {
      getChainId: async () => 5_002,
      request: async () => true,
    };
    assert.equal(
      await openSendGate(liar, GatedScript.Deploy, CONFIRM_PHRASE),
      5_002,
    );
    const connection = await (await runtimeAt(url)).network.create();

    await assert.rejects(
      connection.viem.deployContract("MockUSDC"),
      refused(5_002),
    );
    assert.equal(await chain.blockNumber(), before);
    await connection.close();
  });

  it("openSendGate fails, sending nothing, when the client's request does not reach a guarded connection", async () => {
    const failing = {
      getChainId: async () => 5_003,
      request: async () => {
        throw new Error("no such method");
      },
    };
    await assert.rejects(
      openSendGate(failing, GatedScript.Deploy, CONFIRM_PHRASE),
      (error) =>
        error instanceof ScriptError &&
        error.message.includes("could not open this connection to chain 5003"),
    );
  });

  it("a client that reports one chain but talks to a connection serving another opens nothing", async () => {
    const chain = await inProcessChain(5_005);
    const url = await serve(chain.request);
    const connection = await (await runtimeAt(url)).network.create();
    const real = await connection.viem.getPublicClient();
    const before = await chain.blockNumber();

    const twoFaced = {
      getChainId: async () => 5_004,
      request: (args: never) => real.request(args),
    };
    await assert.rejects(
      openSendGate(twoFaced, GatedScript.Deploy, CONFIRM_PHRASE),
      ScriptError,
    );

    await assert.rejects(
      connection.viem.deployContract("MockUSDC"),
      refused(5_005),
    );
    assert.equal(await chain.blockNumber(), before);
    await connection.close();
  });

  it("an opening request with a made-up token, or with a token caught on its way, opens nothing", async () => {
    const chain = await inProcessChain(5_006);
    const url = await serve(chain.request);
    const connection = await (await runtimeAt(url)).network.create();
    const real = await connection.viem.getPublicClient();
    const before = await chain.blockNumber();
    const send = (params: readonly unknown[]) =>
      connection.provider.request({ method: OPEN_GATE_METHOD, params });

    await assert.rejects(send(["made-up-token"]));

    let caught: unknown;
    const catcher = {
      getChainId: () => real.getChainId(),
      request: async (args: never) => {
        caught = (args as { params?: unknown }).params;
        return true;
      },
    };
    await openSendGate(catcher, GatedScript.Deploy, CONFIRM_PHRASE);
    assert.ok(Array.isArray(caught));
    await assert.rejects(send(caught as unknown[]));

    await assert.rejects(
      connection.viem.deployContract("MockUSDC"),
      refused(5_006),
    );
    assert.equal(await chain.blockNumber(), before);
    await connection.close();
  });
});

describe("send gate: an opened connection, and only that one", () => {
  it("opening one connection to a chain does not open a second connection to the same chain", async () => {
    const chain = await inProcessChain(5_007);
    const url = await serve(chain.request);
    const runtime = await runtimeAt(url);
    const first = await runtime.network.create();
    const second = await runtime.network.create();
    const before = await chain.blockNumber();

    await openSendGate(
      await first.viem.getPublicClient(),
      GatedScript.Deploy,
      CONFIRM_PHRASE,
    );
    await first.viem.deployContract("MockUSDC");
    const afterFirst = await chain.blockNumber();
    assert.equal(afterFirst, before + 1n);

    await assert.rejects(
      second.viem.deployContract("MockUSDC"),
      refused(5_007),
    );
    assert.equal(await chain.blockNumber(), afterFirst);
    await first.close();
    await second.close();
  });

  it("an opened connection stops sending when the node behind it starts serving another chain", async () => {
    const opened = await inProcessChain(5_008);
    const other = await inProcessChain(5_009);
    let target = opened.request;
    const url = await serve((args) => target(args as never));
    const connection = await (await runtimeAt(url)).network.create();
    await openSendGate(
      await connection.viem.getPublicClient(),
      GatedScript.Deploy,
      CONFIRM_PHRASE,
    );
    const mine = () =>
      connection.provider.request({ method: "evm_mine", params: [] });
    const openedBefore = await opened.blockNumber();
    await mine();
    assert.equal(await opened.blockNumber(), openedBefore + 1n);

    target = other.request;
    const before = await other.blockNumber();
    await assert.rejects(mine(), refused(5_009, "evm_mine"));
    assert.equal(await other.blockNumber(), before);
    await connection.close();
  });

  it("a configuration that claims the local chain does not open a node that serves another", async () => {
    const chain = await inProcessChain(5_010);
    const url = await serve(chain.request);
    const connection = await (await runtimeAt(url, 31_337)).network.create();
    const before = await chain.blockNumber();

    await assert.rejects(
      connection.provider.request({ method: "evm_mine", params: [] }),
      refused(5_010, "evm_mine"),
    );
    assert.equal(await chain.blockNumber(), before);
    await connection.close();
  });
});

/** Runs `node` with `args` in this repository and collects its output. */
function runNode(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...env,
        HARDHAT_DISABLE_TELEMETRY: "true",
      };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), TIME_LIMIT_MS);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    },
  );
}

/** This repository's configuration plus a network `guardcheck` at `url`. */
function childConfigFor(url: string): string {
  mkdirSync(CHILD_CONFIG_DIR, { recursive: true });
  const file = path.join(CHILD_CONFIG_DIR, "hardhat.config.ts");
  writeFileSync(
    file,
    [
      'import base from "../../hardhat.config.ts";',
      "export default {",
      "  ...base,",
      `  networks: { ...base.networks, guardcheck: { type: "http", url: ${JSON.stringify(url)} } },`,
      "};",
      "",
    ].join("\n"),
  );
  return file;
}

describe("send gate: a preloaded test file that passes the gate with a stand-in", () => {
  // test/sendGate.ts passes the gate for chain 11155111 with a stand-in
  // client. Preloaded into the same process as other tests, it must not let
  // them send to a chain that reports 11155111.
  for (const [label, args, env] of [
    [
      "node --import ./test/sendGate.ts test/MockUSDC.ts",
      ["--import", "./test/sendGate.ts", "test/MockUSDC.ts"],
      {},
    ],
    [
      "NODE_OPTIONS=--import ./test/sendGate.ts node --test test/MockUSDC.ts",
      ["--test", "test/MockUSDC.ts"],
      { NODE_OPTIONS: "--import ./test/sendGate.ts" },
    ],
  ] as const) {
    it(`${label}: the other tests send nothing, and say why`, async () => {
      const chain = await inProcessChain(11_155_111);
      const url = await serve(chain.request);
      const before = await chain.blockNumber();

      const result = await runNode(args, {
        ...env,
        HARDHAT_CONFIG: childConfigFor(url),
        HARDHAT_NETWORK: "guardcheck",
      });

      assert.notEqual(result.code, 0, result.output);
      assert.ok(
        result.output.includes(
          refusalReason("eth_sendTransaction", "guardcheck", 11_155_111),
        ),
        result.output,
      );
      assert.equal(await chain.blockNumber(), before);
    });
  }
});
