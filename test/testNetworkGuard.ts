import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { network } from "hardhat";
import { HardhatPluginError } from "hardhat/plugins";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatUserConfig } from "hardhat/config";
import type { EIP1193RequestFn } from "viem";

import userConfig from "../hardhat.config.ts";
import {
  DEFAULT_NETWORK,
  GUARD_ID,
  checkTestNetwork,
} from "../scripts/testNetworkGuard.ts";
import { serveOverHttp } from "./serveOverHttp.ts";

// The guard that keeps the tests on Hardhat's local chain. A chain that is not
// local is played by an in-process chain that reports chain ID 999, served
// over HTTP on 127.0.0.1; nothing here connects to any other network, and no
// test selects the sepolia network.

const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

const neverAsked = async (): Promise<number> => {
  throw new Error("the node must not be asked");
};

describe("test network guard: the decision", () => {
  it("lets the tests run on the in-process default network, chain 31337", async () => {
    assert.deepEqual(
      await checkTestNetwork({
        name: DEFAULT_NETWORK,
        configuredChainId: 31_337,
        askChainId: neverAsked,
      }),
      { allowed: true, chainId: 31_337 },
    );
  });

  it("refuses a network whose configuration sets another chain ID, without asking its node", async () => {
    const decision = await checkTestNetwork({
      name: "sepolia",
      configuredChainId: 11_155_111,
      askChainId: neverAsked,
    });
    assert.equal(decision.allowed, false);
    assert.ok(
      !decision.allowed &&
        decision.reason.includes('"sepolia" is chain 11155111') &&
        decision.reason.includes("no test was run and nothing was sent"),
    );
  });

  it("asks the node when the configuration sets no chain ID, and decides by its answer", async () => {
    const refused = await checkTestNetwork({
      name: "localhost",
      configuredChainId: undefined,
      askChainId: async () => 999,
    });
    assert.equal(refused.allowed, false);
    assert.deepEqual(
      await checkTestNetwork({
        name: "localhost",
        configuredChainId: undefined,
        askChainId: async () => 31_337,
      }),
      { allowed: true, chainId: 31_337 },
    );
  });
});

/** A chain that reports chain ID 999, served at a local URL. */
async function chainNine() {
  const connection = await network.create({ override: { chainId: 999 } });
  const publicClient = await connection.viem.getPublicClient();
  const request = publicClient.request as unknown as EIP1193RequestFn;
  const server = await serveOverHttp((args) => request(args as never));
  closers.push(server.close);
  return {
    url: server.url,
    blockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
  };
}

/** This repository's configuration, with `localhost` pointed at `url`. */
function configWithLocalhostAt(url: string): HardhatUserConfig {
  return {
    ...userConfig,
    networks: { ...userConfig.networks, localhost: { type: "http", url } },
  };
}

async function assertStopped(run: Promise<unknown>) {
  await assert.rejects(
    run,
    (error) =>
      HardhatPluginError.isHardhatPluginError(error) &&
      error.pluginId === GUARD_ID &&
      error.message.includes('"localhost" is chain 999'),
  );
}

describe("test network guard: the test task of this repository's configuration", () => {
  it("replaces the action of the test nodejs task", () => {
    const override = userConfig.tasks?.find(
      (task) =>
        task.type === "TASK_OVERRIDE" &&
        task.id.length === 2 &&
        task.id[0] === "test" &&
        task.id[1] === "nodejs",
    );
    assert.ok(override !== undefined);
  });

  it("stops before any test runs when --network selects a chain that is not local, and the chain gets no transaction", async () => {
    const chain = await chainNine();
    const before = await chain.blockNumber();
    const hre = await createHardhatRuntimeEnvironment(
      configWithLocalhostAt(chain.url),
      { network: "localhost" },
    );

    await assertStopped(
      hre.tasks
        .getTask(["test", "nodejs"])
        .run({ testFiles: ["test/MockUSDC.ts"], noCompile: true }),
    );

    assert.equal(await chain.blockNumber(), before);
  });

  it("stops the same way when HARDHAT_NETWORK selects that chain", async () => {
    const chain = await chainNine();
    const before = await chain.blockNumber();
    const saved = process.env.HARDHAT_NETWORK;
    process.env.HARDHAT_NETWORK = "localhost";
    let hre;
    try {
      hre = await createHardhatRuntimeEnvironment(
        configWithLocalhostAt(chain.url),
      );
    } finally {
      if (saved === undefined) delete process.env.HARDHAT_NETWORK;
      else process.env.HARDHAT_NETWORK = saved;
    }

    await assertStopped(
      hre.tasks
        .getTask(["test", "nodejs"])
        .run({ testFiles: ["test/MockUSDC.ts"], noCompile: true }),
    );

    assert.equal(await chain.blockNumber(), before);
  });

  it("stops the top-level test task too, which runs test nodejs", async () => {
    const chain = await chainNine();
    const before = await chain.blockNumber();
    const hre = await createHardhatRuntimeEnvironment(
      configWithLocalhostAt(chain.url),
      { network: "localhost" },
    );

    await assertStopped(hre.tasks.getTask("test").run({ noCompile: true }));

    assert.equal(await chain.blockNumber(), before);
  });
});
