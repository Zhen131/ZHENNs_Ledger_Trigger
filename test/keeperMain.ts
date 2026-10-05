import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, describe, it } from "node:test";

import { getAddress, type EIP1193RequestFn } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ENV, REQUIRED } from "../keeper/config.ts";
import { OrderStatus } from "../keeper/names.ts";
import { ONE_ETH, setUpFills } from "./setUpFills.ts";
import { serveOverHttp } from "./serveOverHttp.ts";
import { unusedPort } from "./unusedPort.ts";

// These tests start the keeper's entry point as a separate process, the way a
// user does, and read everything it prints. Every private key and every key in
// a node URL is made up on the spot and thrown away; none may appear in the
// output. The only node a test ever points the keeper at is on 127.0.0.1.

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join("keeper", "main.ts");

/** How long a test lets the keeper process run before killing it. */
const TIME_LIMIT_MS = 30_000;

type Run = {
  readonly exitCode: number | null;
  /** Standard output and standard error together. */
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
};

/** Starts the entry point with only PATH and `env` set, and waits for it. */
function runKeeper(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIME_LIMIT_MS);
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        output,
        durationMs: performance.now() - started,
        timedOut,
      });
    });
  });
}

/** Fails, without repeating it, if `output` holds any of `secrets`. */
function assertHoldsNone(output: string, secrets: readonly string[]) {
  const text = output.toLowerCase();
  for (const secret of secrets) {
    const bare = secret.replace(/^0x/i, "").toLowerCase();
    assert.ok(!text.includes(bare), "the output holds a key or a node URL");
  }
}

/** A made-up key of the kind node services put in their URLs. */
function madeUpUrlKey(): string {
  return randomBytes(16).toString("hex");
}

/** A node URL on a local port nothing listens on, with a made-up key in it. */
async function unreachableUrl() {
  const urlKey = madeUpUrlKey();
  const url = `http://127.0.0.1:${await unusedPort()}/v3/${urlKey}`;
  return { url, urlKey };
}

/** A complete, well-formed set of variables. */
function variables(rpcUrl: string, privateKey: string, contract: string) {
  return {
    [ENV.rpcUrl]: rpcUrl,
    [ENV.privateKey]: privateKey,
    [ENV.contractAddress]: contract,
    [ENV.fromBlock]: "0",
    [ENV.maxFeeWei]: (ONE_ETH / 10n).toString(),
  };
}

/** An address with nothing deployed at it. */
function emptyAddress(): string {
  return privateKeyToAccount(generatePrivateKey()).address;
}

const servers: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** Serves the chain behind `client` at a local URL ending in a made-up key. */
async function serve(client: { request: unknown }) {
  const urlKey = madeUpUrlKey();
  const request = client.request as EIP1193RequestFn;
  const server = await serveOverHttp(
    (args) => request(args as never),
    `v3/${urlKey}`,
  );
  servers.push(server);
  return { url: server.url, urlKey };
}

describe("keeper entry point: missing and invalid settings", () => {
  for (const name of REQUIRED) {
    it(`exits with 1 and names ${name} when it is missing; the output holds neither the private key nor the URL key`, async () => {
      const privateKey = generatePrivateKey();
      const { url, urlKey } = await unreachableUrl();
      const env: Record<string, string> = variables(
        url,
        privateKey,
        emptyAddress(),
      );
      delete env[name];

      const run = await runKeeper(["--once"], env);

      assert.equal(run.exitCode, 1, run.output);
      assert.match(
        run.output,
        new RegExp(` action=error reason=config-missing variable=${name} `),
      );
      assertHoldsNone(run.output, [privateKey, url, urlKey]);
    });
  }

  const badKeys: readonly [string, (key: string) => string][] = [
    ["one hex digit too few", (key) => key.slice(0, -1)],
    ["a letter that is not hex", (key) => `${key.slice(0, -1)}z`],
    ["the value zero, which is no key", () => `0x${"0".repeat(64)}`],
  ];
  for (const [label, spoil] of badKeys) {
    it(`exits with 1 when the private key has ${label}, naming the variable but not repeating the key`, async () => {
      const privateKey = generatePrivateKey();
      const badKey = spoil(privateKey);
      const { url, urlKey } = await unreachableUrl();

      const run = await runKeeper(
        ["--once"],
        variables(url, badKey, emptyAddress()),
      );

      assert.equal(run.exitCode, 1, run.output);
      assert.match(
        run.output,
        new RegExp(
          ` action=error reason=config-invalid variable=${ENV.privateKey} `,
        ),
      );
      assertHoldsNone(run.output, [privateKey, badKey, url, urlKey]);
    });
  }

  it("exits with 1 when nothing is deployed at the contract address, saying so; the output holds no key", async () => {
    const f = await setUpFills();
    const { url, urlKey } = await serve(f.publicClient);
    const privateKey = generatePrivateKey();

    const run = await runKeeper(
      ["--once"],
      variables(url, privateKey, emptyAddress()),
    );

    assert.equal(run.exitCode, 1, run.output);
    assert.match(run.output, / action=error reason=no-contract-code /);
    assertHoldsNone(run.output, [privateKey, url, urlKey]);
  });

  it("exits with 2 on a command-line argument it does not know", async () => {
    const run = await runKeeper(["--twice"], {});
    assert.equal(run.exitCode, 2);
    assert.match(run.output, / action=error reason=usage /);
  });
});

describe("keeper entry point: a node that cannot be reached", () => {
  it("in --once mode exits with 1 within the time limit and says it could not reach the node; the output holds neither the URL key nor the private key", async () => {
    const privateKey = generatePrivateKey();
    const { url, urlKey } = await unreachableUrl();

    const run = await runKeeper(
      ["--once"],
      variables(url, privateKey, emptyAddress()),
    );

    assert.equal(run.timedOut, false);
    assert.ok(run.durationMs < TIME_LIMIT_MS);
    assert.equal(run.exitCode, 1, run.output);
    assert.match(
      run.output,
      / action=error reason=node-unreachable step=connect message="Could not reach the node\." /,
    );
    assertHoldsNone(run.output, [privateKey, url, urlKey]);
  });
});

describe("keeper entry point: one round against a chain served over HTTP", () => {
  it("in --once mode signs with the configured key, fills an order that names its account, and exits with 0 without printing any key", async () => {
    const f = await setUpFills();
    const privateKey = generatePrivateKey();
    const keeper = privateKeyToAccount(privateKey);
    await f.networkHelpers.setBalance(keeper.address, ONE_ETH);
    const { orderId } = await f.place({ executor: keeper.address });
    const { url, urlKey } = await serve(f.publicClient);

    const run = await runKeeper(
      ["--once"],
      variables(url, privateKey.slice(2), f.trigger.address),
    );

    assert.equal(run.exitCode, 0, run.output);
    assert.match(
      run.output,
      new RegExp(
        ` order=- action=start reason=connected mode=once chain-id=${f.publicClient.chain.id} contract=${getAddress(f.trigger.address)} executor=${keeper.address}\n`,
      ),
    );
    assert.match(
      run.output,
      new RegExp(
        ` order=${orderId} action=filled reason=transaction-succeeded tx=0x[0-9a-f]{64}\n`,
      ),
    );
    assert.equal(await f.trigger.read.statusOf([orderId]), OrderStatus.Filled);
    const [event] = await f.trigger.getEvents.OrderFilled(
      { orderId },
      { fromBlock: 0n },
    );
    assert.equal(event?.args.filledBy, getAddress(keeper.address));
    assertHoldsNone(run.output, [privateKey, url, urlKey]);
  });
});
