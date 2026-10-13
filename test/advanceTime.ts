import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { network } from "hardhat";
import type { HardhatUserConfig } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { EIP1193RequestFn } from "viem";

import userConfig from "../hardhat.config.ts";
import {
  advanceTime,
  advanceTimeSettingsFrom,
  formatTimeAdvanced,
} from "../scripts/advanceTime.ts";
import { ScriptError } from "../scripts/scriptError.ts";
import { CONFIRM_PHRASE } from "../scripts/sendGate.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { serveOverHttp } from "./serveOverHttp.ts";
import { setUpScripts } from "./setUpScripts.ts";

// advance-time moves the clock of Hardhat's local chain forward by mining one
// block, and refuses every other chain whatever the confirmation holds. A
// chain that is not local is played by an in-process chain that reports
// another chain ID, directly or served over HTTP on 127.0.0.1. Nothing here
// connects to any other network.

const NOT_LOCAL = 999;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

/** The settings for `seconds`, as the variable would hold them. */
function settings(seconds: string) {
  return advanceTimeSettingsFrom({ [VARIABLES.advanceSeconds]: seconds });
}

/** The latest block's number and time, read fresh. */
async function latest(publicClient: {
  readonly getBlock: (args: {
    blockTag: "latest";
  }) => Promise<{ number: bigint; timestamp: bigint }>;
}) {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return { number: block.number, timestamp: block.timestamp };
}

/**
 * An in-process chain that reports `chainId`, served at a local URL. It is
 * always Hardhat's in-process network ("default").
 */
async function servedChain(chainId: number) {
  const connection = await network.create({
    network: "default",
    override: { chainId },
  });
  const publicClient = await connection.viem.getPublicClient();
  const request = publicClient.request as unknown as EIP1193RequestFn;
  const server = await serveOverHttp((args) => request(args as never));
  closers.push(server.close);
  return { url: server.url, publicClient };
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

describe("advance-time: on Hardhat's local chain", () => {
  it("mines exactly one block, at least the seconds asked for after the latest block, and reports both blocks", async () => {
    const s = await setUpScripts();
    await s.withParts();
    const before = await latest(s.publicClient);

    const result = await advanceTime({
      viem: s.viem,
      confirmation: undefined,
      settings: settings("3600"),
    });

    const now = await latest(s.publicClient);
    assert.equal(now.number, before.number + 1n);
    assert.ok(now.timestamp >= before.timestamp + 3_600n);
    assert.deepEqual(result.before, before);
    assert.deepEqual(result.after, now);
    assert.equal(result.seconds, 3_600n);
    const text = formatTimeAdvanced(result).join("\n");
    for (const block of [before, now]) {
      assert.match(
        text,
        new RegExp(
          `block ${block.number} at ${new Date(Number(block.timestamp) * 1000).toISOString()} \\(Unix ${block.timestamp}\\)`,
        ),
      );
    }
    assert.match(
      text,
      new RegExp(`${now.timestamp - before.timestamp} seconds after`),
    );
  });

  it("needs no contract address: it runs with only TRIGGER_ADVANCE_SECONDS set", async () => {
    const s = await setUpScripts();
    const before = await latest(s.publicClient);

    await advanceTime({
      viem: s.viem,
      confirmation: undefined,
      settings: advanceTimeSettingsFrom({ [VARIABLES.advanceSeconds]: "60" }),
    });

    const now = await latest(s.publicClient);
    assert.equal(now.number, before.number + 1n);
    assert.ok(now.timestamp >= before.timestamp + 60n);
  });
});

describe("advance-time: on any other chain", () => {
  for (const [label, confirmation] of [
    ["without the confirmation", undefined],
    ["with a wrong confirmation", `${CONFIRM_PHRASE}!`],
    ["with the exact confirmation", CONFIRM_PHRASE],
  ] as const) {
    it(`refuses ${label}: local chain only, and neither the block number nor the latest block's time changes`, async () => {
      const s = await setUpScripts({ chainId: NOT_LOCAL });
      const before = await latest(s.publicClient);

      await assert.rejects(
        advanceTime({ viem: s.viem, confirmation, settings: settings("3600") }),
        (error) =>
          error instanceof ScriptError &&
          /local chain only/.test(error.message),
      );

      assert.deepEqual(await latest(s.publicClient), before);
    });
  }

  it("refuses a chain that is not local served over HTTP, even with the exact confirmation, and that chain gets no block", async () => {
    const chain = await servedChain(4_545);
    const before = await latest(chain.publicClient);
    const connection = await connectionTo(chain.url);

    await assert.rejects(
      advanceTime({
        viem: connection.viem,
        confirmation: CONFIRM_PHRASE,
        settings: settings("3600"),
      }),
      (error) =>
        error instanceof ScriptError && /local chain only/.test(error.message),
    );

    assert.deepEqual(await latest(chain.publicClient), before);
    await connection.close();
  });
});

describe("advance-time: settings it cannot use", () => {
  for (const value of ["", "0", "-5", "1.5", "an hour"]) {
    it(`stops before any request when TRIGGER_ADVANCE_SECONDS is ${JSON.stringify(value)}, and names the variable`, () => {
      assert.throws(
        () => advanceTimeSettingsFrom({ [VARIABLES.advanceSeconds]: value }),
        (error) =>
          error instanceof ScriptError &&
          error.message.startsWith(`${VARIABLES.advanceSeconds} `),
      );
    });
  }

  it("stops when TRIGGER_ADVANCE_SECONDS is not set, and names it", () => {
    assert.throws(
      () => advanceTimeSettingsFrom({}),
      (error) =>
        error instanceof ScriptError &&
        error.message ===
          `${VARIABLES.advanceSeconds} is required and not set.`,
    );
  });
});
