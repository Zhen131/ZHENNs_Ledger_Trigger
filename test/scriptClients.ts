import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatUserConfig } from "hardhat/config";
import {
  encodeErrorResult,
  toFunctionSelector,
  type Address,
  type EIP1193RequestFn,
  type Hex,
} from "viem";

import userConfig from "../hardhat.config.ts";
import { scriptClients } from "../scripts/clients.ts";
import {
  orderStatus,
  orderStatusSettingsFrom,
} from "../scripts/orderStatus.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { serveOverHttp } from "./serveOverHttp.ts";
import { setUpScripts } from "./setUpScripts.ts";

// The deployment, operation and demo scripts talk to the selected network's
// node only: every viem client they use has CCIP-read turned off. Every server
// here listens on 127.0.0.1 only.

const SCRIPTS = path.join(import.meta.dirname, "..", "scripts");

const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

/** Every .ts file under scripts/, as a path relative to scripts/. */
function scriptFiles(directory = SCRIPTS): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return scriptFiles(full);
    return entry.name.endsWith(".ts") ? [path.relative(SCRIPTS, full)] : [];
  });
}

/** The text of each call `name(...)` in `source`, brackets included. */
function callsOf(source: string, name: string): string[] {
  const calls: string[] = [];
  for (let start = source.indexOf(name); start >= 0;) {
    let depth = 0;
    let end = start + name.length - 1;
    for (let i = end; i < source.length; i += 1) {
      const c = source.charAt(i);
      if (c === "(") depth += 1;
      if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(start, end + 1));
    start = source.indexOf(name, end);
  }
  return calls;
}

describe("script clients", () => {
  it("are all built with CCIP-read turned off, and contracts get the same ones", async () => {
    const { viem } = await setUpScripts();

    const clients = await scriptClients(viem);

    assert.equal(clients.publicClient.ccipRead, false);
    assert.ok(clients.walletClients.length > 0);
    for (const wallet of clients.walletClients) {
      assert.equal(wallet.ccipRead, false);
    }
    assert.equal(clients.client.public, clients.publicClient);
    assert.equal(clients.client.wallet, clients.walletClients[0]);
  });

  it("are the only clients the scripts build: no script asks Hardhat for its default clients", () => {
    const files = scriptFiles();
    assert.ok(files.includes("clients.ts"));
    for (const file of files) {
      if (file === "clients.ts") continue;
      const source = readFileSync(path.join(SCRIPTS, file), "utf8");
      for (const builder of [
        "viem.getPublicClient(",
        "viem.getWalletClients(",
      ]) {
        assert.equal(
          source.includes(builder),
          false,
          `${file} calls ${builder}`,
        );
      }
      for (const opener of [
        "viem.getContractAt(",
        "viem.deployContract(",
        "viem.sendDeploymentTransaction(",
      ]) {
        for (const call of callsOf(source, opener)) {
          assert.match(call, /\bclient\b/, `${file}: ${call}`);
        }
      }
    }
  });
});

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

describe("script clients: a revert that asks to fetch a web address", () => {
  it("order-status does not fetch the address a contract names; it stops on the revert instead", async () => {
    const s = await setUpScripts();
    const { trigger } = await s.withParts();
    const latest = await s.publicClient.getBlock({ blockTag: "latest" });
    await s.publicClient.waitForTransactionReceipt({
      hash: await trigger.write.createOrder(
        [
          1_000_000n,
          200_000_000_000n,
          s.recipient.account.address,
          s.executor.account.address,
          latest.timestamp + 3_600n,
        ],
        { account: s.owner.account },
      ),
    });
    const lookup = await countingServer();
    const revertData = encodeErrorResult({
      abi: OFFCHAIN_LOOKUP,
      errorName: "OffchainLookup",
      args: [
        trigger.address,
        [`http://127.0.0.1:${lookup.port}/{sender}/{data}.json`],
        "0x",
        "0x12345678",
        "0x",
      ],
    });
    const getOrder = toFunctionSelector("getOrder(uint256)");
    const forward = s.publicClient.request as unknown as EIP1193RequestFn;
    const server = await serveOverHttp(async (args) => {
      const [call] = (args.params ?? []) as { to?: Address; data?: Hex }[];
      if (
        args.method === "eth_call" &&
        call?.to?.toLowerCase() === trigger.address.toLowerCase() &&
        call.data?.startsWith(getOrder) === true
      ) {
        throw Object.assign(new Error("execution reverted"), {
          code: 3,
          data: revertData,
        });
      }
      return forward(args as never);
    });
    closers.push(server.close);
    const config: HardhatUserConfig = {
      ...userConfig,
      networks: {
        ...userConfig.networks,
        localhost: { type: "http", url: server.url },
      },
    };
    const hre = await createHardhatRuntimeEnvironment(config, {
      network: "localhost",
    });
    const connection = await hre.network.create();

    await assert.rejects(
      orderStatus({
        viem: connection.viem,
        settings: orderStatusSettingsFrom({
          [VARIABLES.contractAddress]: trigger.address,
          [VARIABLES.orderId]: "1",
        }),
      }),
    );

    assert.equal(lookup.requests(), 0);
    await connection.close();
  });
});
