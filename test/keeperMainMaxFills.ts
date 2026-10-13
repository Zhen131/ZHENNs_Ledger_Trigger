import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, describe, it } from "node:test";

import { type EIP1193RequestFn } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ENV } from "../keeper/config.ts";
import { OrderStatus } from "../keeper/names.ts";
import { usd } from "./deployLedgerTrigger.ts";
import { ONE_ETH, setUpFills } from "./setUpFills.ts";
import { serveOverHttp } from "./serveOverHttp.ts";

// The entry point hands KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND to the round. The
// test starts the keeper as a separate process against a chain served on
// 127.0.0.1. The private key and the key in the node URL are made up on the
// spot; neither may appear in the output.

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join("keeper", "main.ts");

/** How long the test lets the keeper process run before killing it. */
const TIME_LIMIT_MS = 30_000;

/** Starts the entry point in --once mode with only PATH and `env` set. */
function runKeeperOnce(env: Readonly<Record<string, string>>) {
  return new Promise<{ exitCode: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [ENTRY, "--once"], {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), TIME_LIMIT_MS);
      child.on("error", reject);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, output });
      });
    },
  );
}

const servers: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("keeper entry point: the most fills of one order in one round", () => {
  it("in --once mode with KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND=2 fills two tiers of a Ladder order whose price is below every tier, logs fill-limit-reached with limit 2, and prints no key", async () => {
    const f = await setUpFills();
    const privateKey = generatePrivateKey();
    const keeper = privateKeyToAccount(privateKey);
    await f.networkHelpers.setBalance(keeper.address, ONE_ETH);
    const { orderId } = await f.placeLadder({ executor: keeper.address });
    await f.setPrice(usd(1_700n));
    const urlKey = randomBytes(16).toString("hex");
    const request = f.publicClient.request as unknown as EIP1193RequestFn;
    const server = await serveOverHttp(
      (args) => request(args as never),
      `v3/${urlKey}`,
    );
    servers.push(server);

    const run = await runKeeperOnce({
      [ENV.rpcUrl]: server.url,
      [ENV.privateKey]: privateKey,
      [ENV.contractAddress]: f.trigger.address,
      [ENV.fromBlock]: "0",
      [ENV.maxFeeWei]: (ONE_ETH / 10n).toString(),
      [ENV.maxFillsPerOrderPerRound]: "2",
    });

    assert.equal(run.exitCode, 0, run.output);
    const filled = run.output.match(
      new RegExp(
        ` order=${orderId} action=filled reason=transaction-succeeded tx=0x[0-9a-f]+\n`,
        "g",
      ),
    );
    assert.equal(filled?.length, 2, run.output);
    assert.match(
      run.output,
      new RegExp(
        ` order=${orderId} action=skip reason=fill-limit-reached limit=2\n`,
      ),
    );
    assert.match(
      run.output,
      / order=- action=round-end reason=done activated=0 filled=2 skipped=1 errors=0\n/,
    );
    assert.equal((await f.trigger.read.getOrder([orderId])).fillsDone, 2n);
    assert.equal(
      await f.trigger.read.statusOf([orderId]),
      OrderStatus.PartiallyFilled,
    );
    const text = run.output.toLowerCase();
    for (const secret of [privateKey.slice(2), urlKey, server.url]) {
      assert.ok(
        !text.includes(secret.toLowerCase()),
        "the output holds a key or a node URL",
      );
    }
  });
});
