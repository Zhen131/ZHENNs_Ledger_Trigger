import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  encodeErrorResult,
  toFunctionSelector,
  type Address,
  type EIP1193RequestFn,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ENV, ProblemKind, readConfig } from "../keeper/config.ts";
import { OrderStatus } from "../keeper/names.ts";
import { ONE_ETH, setUpFills } from "./setUpFills.ts";
import { serveOverHttp } from "./serveOverHttp.ts";
import { unusedPort } from "./unusedPort.ts";

// The keeper talks to the node in its settings and to nothing else, and says
// plainly when the node URL is written in a form it does not accept. Each
// test starts the keeper's entry point as a separate process. Every private
// key and every key in a URL is made up on the spot; none may appear in the
// output. Every server here listens on 127.0.0.1 only.

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join("keeper", "main.ts");
const TIME_LIMIT_MS = 30_000;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

function runKeeper(env: Readonly<Record<string, string>>) {
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

function assertHoldsNone(output: string, secrets: readonly string[]) {
  const text = output.toLowerCase();
  for (const secret of secrets) {
    const bare = secret.replace(/^0x/i, "").toLowerCase();
    assert.ok(!text.includes(bare), "the output holds a key or a node URL");
  }
}

function variables(rpcUrl: string, privateKey: string, contract: string) {
  return {
    [ENV.rpcUrl]: rpcUrl,
    [ENV.privateKey]: privateKey,
    [ENV.contractAddress]: contract,
    [ENV.fromBlock]: "0",
    [ENV.maxFeeWei]: (ONE_ETH / 10n).toString(),
  };
}

/** A local web server that only counts the requests it gets. */
async function countingServer() {
  let requests = 0;
  const server = createServer((_incoming, outgoing) => {
    requests += 1;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ data: "0x" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server reported no port");
  }
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: address.port, requests: () => requests };
}

/** The error a contract reverts with to ask the caller to fetch a URL. */
const OFFCHAIN_LOOKUP = [
  {
    type: "error",
    name: "OffchainLookup",
    inputs: [
      { name: "sender", type: "address" },
      { name: "urls", type: "string[]" },
      { name: "callData", type: "bytes" },
      { name: "callbackFunction", type: "bytes4" },
      { name: "extraData", type: "bytes" },
    ],
  },
] as const;

const FILL_SELECTOR = toFunctionSelector("fillOrder(uint256)");

describe("keeper entry point: a revert that asks it to fetch a web address", () => {
  it("does not fetch the address; it skips the order as an unnamed contract error", async () => {
    const f = await setUpFills();
    const privateKey = generatePrivateKey();
    const keeper = privateKeyToAccount(privateKey);
    await f.networkHelpers.setBalance(keeper.address, ONE_ETH);
    const { orderId } = await f.place({ executor: keeper.address });
    const lookup = await countingServer();
    const revertData = encodeErrorResult({
      abi: OFFCHAIN_LOOKUP,
      errorName: "OffchainLookup",
      args: [
        f.trigger.address,
        [`http://127.0.0.1:${lookup.port}/{sender}/{data}.json`],
        "0x",
        "0x12345678",
        "0x",
      ],
    });
    const forward = f.publicClient.request as unknown as EIP1193RequestFn;
    const urlKey = randomBytes(16).toString("hex");
    const server = await serveOverHttp(async (args) => {
      const [call] = (args.params ?? []) as { to?: Address; data?: Hex }[];
      if (
        args.method === "eth_call" &&
        call?.to?.toLowerCase() === f.trigger.address.toLowerCase() &&
        call.data?.startsWith(FILL_SELECTOR) === true
      ) {
        throw Object.assign(new Error("execution reverted"), {
          code: 3,
          data: revertData,
        });
      }
      return forward(args as never);
    }, `v3/${urlKey}`);
    closers.push(server.close);

    const run = await runKeeper(
      variables(server.url, privateKey, f.trigger.address),
    );

    assert.equal(lookup.requests(), 0, run.output);
    assert.equal(run.exitCode, 0, run.output);
    assert.match(
      run.output,
      new RegExp(
        ` order=${orderId} action=skip reason=unknown-contract-error step=simulate selector=0x556f1830\n`,
      ),
    );
    assert.equal(await f.trigger.read.statusOf([orderId]), OrderStatus.Open);
    assertHoldsNone(run.output, [privateKey, server.url, urlKey]);
  });
});

describe("keeper settings: a node URL with a user name or password", () => {
  const forms = [
    ["a user name and a password", (key: string) => `user:${key}`],
    ["a user name only", (key: string) => key],
    ["a password only", (key: string) => `:${key}`],
  ] as const;

  for (const [label, userInfo] of forms) {
    it(`is refused with ${label}, naming the variable and the form, never the URL`, () => {
      const key = randomBytes(16).toString("hex");
      const result = readConfig(
        variables(
          `https://${userInfo(key)}@node.example.org/v3/path`,
          generatePrivateKey(),
          privateKeyToAccount(generatePrivateKey()).address,
        ),
      );
      assert.equal(result.kind, "problems");
      const problems = result.kind === "problems" ? result.problems : [];
      assert.deepEqual(
        problems.map((problem) => [problem.variable, problem.kind]),
        [[ENV.rpcUrl, ProblemKind.Invalid]],
      );
      assert.match(problems[0]?.message ?? "", /user name or password/);
      assert.ok(!(problems[0]?.message ?? "").includes(key));
    });
  }

  it("still accepts a URL with the access key in its path", () => {
    const result = readConfig(
      variables(
        `https://node.example.org/v3/${randomBytes(16).toString("hex")}`,
        generatePrivateKey(),
        privateKeyToAccount(generatePrivateKey()).address,
      ),
    );
    assert.equal(result.kind, "config");
  });

  it("makes the entry point exit with 1 saying the URL's form is not accepted, not that the node is unreachable; the output holds neither the URL nor the keys", async () => {
    const privateKey = generatePrivateKey();
    const password = randomBytes(16).toString("hex");
    const url = `http://user:${password}@127.0.0.1:${await unusedPort()}/`;

    const run = await runKeeper(
      variables(
        url,
        privateKey,
        privateKeyToAccount(generatePrivateKey()).address,
      ),
    );

    assert.equal(run.exitCode, 1, run.output);
    assert.match(
      run.output,
      new RegExp(
        ` action=error reason=config-invalid variable=${ENV.rpcUrl} message="${ENV.rpcUrl} is written in a form the keeper does not accept: a user name or password before the host`,
      ),
    );
    assert.doesNotMatch(run.output, /node-unreachable/);
    assertHoldsNone(run.output, [privateKey, url, password]);
  });
});
