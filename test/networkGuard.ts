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
import {
  deploySettingsFrom,
  deployWithExternalParts,
} from "../scripts/deploy.ts";
import {
  NETWORK_GUARD_ID,
  READ_ONLY_METHODS,
  refusalReason,
} from "../scripts/networkGuard.ts";
import { CONFIRM_PHRASE } from "../scripts/sendGate.ts";
import { serveOverHttp } from "./serveOverHttp.ts";

// The network guard refuses transactions to any chain but Hardhat's local
// one, on every network connection, whatever started the code. A chain that
// is not local is played by an in-process chain that reports another chain ID,
// served over HTTP on 127.0.0.1. Each test uses its own chain ID: a chain the
// send gate has let through stays let through for the rest of the process.
// Nothing here connects to any other network, and no test selects sepolia.

const ROOT = path.join(import.meta.dirname, "..");
const HARDHAT = path.join(ROOT, "node_modules", ".bin", "hardhat");
const CHILD_CONFIG_DIR = path.join(ROOT, "cache", "network-guard-check");
const TIME_LIMIT_MS = 120_000;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
  rmSync(CHILD_CONFIG_DIR, { recursive: true, force: true });
});

/** An in-process chain that reports `chainId`, served at a local URL. */
async function servedChain(chainId: number) {
  const connection = await network.create({ override: { chainId } });
  const publicClient = await connection.viem.getPublicClient();
  const request = publicClient.request as unknown as EIP1193RequestFn;
  const server = await serveOverHttp((args) => request(args as never));
  closers.push(server.close);
  return {
    url: server.url,
    viem: connection.viem,
    blockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
  };
}

/** A connection to `url` through this repository's configuration. */
async function connectionTo(url: string) {
  const config: HardhatUserConfig = {
    ...userConfig,
    networks: { ...userConfig.networks, localhost: { type: "http", url } },
  };
  const hre = await createHardhatRuntimeEnvironment(config, {
    network: "localhost",
  });
  return hre.network.create();
}

function refused(chainId: number, method = "eth_sendTransaction") {
  return (error: unknown) =>
    error instanceof Error &&
    `${error.message}\n${String(error.cause)}`.includes(
      refusalReason(method, "localhost", chainId),
    );
}

describe("network guard: which requests count as reads", () => {
  it("lets reads through and nothing that sends, signs or changes a node", () => {
    for (const method of [
      "eth_call",
      "eth_chainId",
      "eth_getCode",
      "eth_getLogs",
    ]) {
      assert.equal(READ_ONLY_METHODS.has(method), true, method);
    }
    for (const method of [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "eth_sign",
      "eth_signTypedData_v4",
      "personal_sign",
      "hardhat_setBalance",
      "hardhat_mine",
      "evm_mine",
      "evm_increaseTime",
    ]) {
      assert.equal(READ_ONLY_METHODS.has(method), false, method);
    }
  });

  it("says why it refuses, names the network and the chain, and says nothing was sent", () => {
    const text = refusalReason("eth_sendTransaction", "localhost", 4_242);
    assert.match(
      text,
      /^Refused eth_sendTransaction on network "localhost", chain 4242: /,
    );
    assert.match(text, /Hardhat's local chain \(chain ID 31337\)/);
    assert.match(text, /Nothing was sent\./);
  });
});

describe("network guard: a connection to a chain that is not local", () => {
  it("refuses a deployment and a node-changing method, lets reads through, and the chain gets nothing", async () => {
    const chain = await servedChain(4_242);
    const before = await chain.blockNumber();
    const connection = await connectionTo(chain.url);

    await assert.rejects(
      connection.viem.deployContract("MockUSDC"),
      refused(4_242),
    );
    await assert.rejects(
      connection.provider.request({ method: "evm_mine", params: [] }),
      (error) =>
        error instanceof Error &&
        error.message.includes(refusalReason("evm_mine", "localhost", 4_242)) &&
        "pluginId" in error &&
        error.pluginId === NETWORK_GUARD_ID,
    );
    const publicClient = await connection.viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 4_242);
    assert.equal(await chain.blockNumber(), before);
    await connection.close();
  });

  it("lets a deployment through to Hardhat's local chain over HTTP", async () => {
    const chain = await servedChain(31_337);
    const before = await chain.blockNumber();
    const connection = await connectionTo(chain.url);

    await connection.viem.deployContract("MockUSDC");

    assert.ok((await chain.blockNumber()) > before);
    await connection.close();
  });

  it("lets a script through once its send gate has passed with the confirmation, and not before", async () => {
    const chain = await servedChain(4_343);
    const usdc = await chain.viem.deployContract("MockUSDC");
    const feed = await chain.viem.deployContract("MockPriceFeed", [
      8,
      2_000n * 10n ** 8n,
    ]);
    const connection = await connectionTo(chain.url);
    const deploy = (confirmation: string | undefined) =>
      deployWithExternalParts({
        viem: connection.viem,
        confirmation,
        settings: deploySettingsFrom({}),
        usdc: usdc.address,
        priceFeed: feed.address,
      });
    const before = await chain.blockNumber();

    await assert.rejects(deploy(undefined), /Nothing was sent/);
    assert.equal(await chain.blockNumber(), before);

    await deploy(CONFIRM_PHRASE);
    assert.equal(await chain.blockNumber(), before + 2n);
    await connection.close();
  });
});

/** Runs `command` with `args` in this repository and collects its output. */
function run(
  command: string,
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
      const child = spawn(command, args, {
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

/**
 * A configuration file that is this repository's configuration plus one
 * network, `guardcheck`, at `url`. It lives under cache/, which git ignores,
 * so its project root is this repository's.
 */
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

describe("network guard: test files started without the hardhat test task", () => {
  for (const [label, command, args, viaVariable] of [
    [
      "node --test <file>",
      process.execPath,
      ["--test", "test/MockUSDC.ts"],
      true,
    ],
    ["node <file>", process.execPath, ["test/MockUSDC.ts"], true],
    [
      "npx hardhat run <file> --network <name>",
      HARDHAT,
      ["run", "test/MockUSDC.ts", "--network", "guardcheck"],
      false,
    ],
  ] as const) {
    it(`${label}: sends nothing to a chain that is not local, and says why`, async () => {
      const chain = await servedChain(4_444);
      const before = await chain.blockNumber();
      const env: Record<string, string> = {
        HARDHAT_CONFIG: childConfigFor(chain.url),
      };
      if (viaVariable) env.HARDHAT_NETWORK = "guardcheck";

      const result = await run(command, args, env);

      assert.notEqual(result.code, 0, result.output);
      assert.ok(
        result.output.includes(
          refusalReason("eth_sendTransaction", "guardcheck", 4_444),
        ),
        result.output,
      );
      assert.equal(await chain.blockNumber(), before);
    });
  }
});
