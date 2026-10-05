// Entry point of the keeper.
//
// Usage:
//   npm run keeper             keep running: a round, a pause, another round...
//   npm run keeper -- --once   run one round, then exit
//
// The settings come from environment variables only (see config.ts and the
// README). Build the contracts first: the ABIs are read from the build output.
//
// Start-up: read the settings and the ABIs; a problem with either ends the
// keeper, since no later round could fix it. Then connect: ask the node for
// its chain ID (nothing is assumed about which chain it is) and check that the
// contract address holds code. The first round connects; if that fails, the
// round counts as an error, and in keep-running mode the next round tries to
// connect again. Once connected, rounds run as described in runOnce.ts.
//
// Exit codes: 0 when everything went through or was skipped; 1 on bad
// settings or missing build output, or, in --once mode, on any error in the
// round, connecting included; 2 on an unknown command-line argument.
//
// The private key and the node URL are never printed: every line comes from
// `formatLogLine`, and errors are logged as this project's own sentence and
// category, never as a library's message.

import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";

import { BuildOutputError, loadAbis, type KeeperAbis } from "./abi.ts";
import { FailureKind, classifyFailure } from "./classify.ts";
import { readConfig, type KeeperConfig } from "./config.ts";
import { keepRunning } from "./keepRunning.ts";
import {
  Action,
  failureEntry,
  formatLogLine,
  internalErrorEntry,
  type LogEntry,
} from "./log.ts";
import {
  roundHasError,
  runOnce,
  type KeeperClients,
  type RoundReport,
} from "./runOnce.ts";

const Mode = {
  Once: "once",
  KeepRunning: "keep-running",
} as const;
type Mode = (typeof Mode)[keyof typeof Mode];

const USAGE = "Usage: node keeper/main.ts [--once]";

function print(entry: LogEntry): void {
  console.log(formatLogLine(entry, new Date()));
}

function errorEntry(reason: string, message: string): LogEntry {
  return {
    orderId: undefined,
    action: Action.Error,
    reason,
    details: [["message", message]],
  };
}

function readMode(args: readonly string[]): Mode | undefined {
  if (args.length === 0) return Mode.KeepRunning;
  if (args.length === 1 && args[0] === "--once") return Mode.Once;
  return undefined;
}

type Connection =
  | {
      readonly kind: "connected";
      readonly clients: KeeperClients;
      readonly chainId: number;
    }
  | { readonly kind: "failed"; readonly entry: LogEntry };

/** Asks the node for its chain ID and checks the contract address holds code. */
async function connect(
  config: KeeperConfig,
  abis: KeeperAbis,
): Promise<Connection> {
  const failed = (error: unknown): Connection => ({
    kind: "failed",
    entry: {
      ...failureEntry(
        undefined,
        "connect",
        classifyFailure({ kind: FailureKind.Thrown, error }, abis.errors),
      ),
      action: Action.Error,
    },
  });
  const transport = http(config.rpcUrl);
  let chainId: number;
  try {
    chainId = await createPublicClient({ transport }).getChainId();
  } catch (error) {
    return failed(error);
  }
  const chain = defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
  const publicClient = createPublicClient({ chain, transport });
  let code;
  try {
    code = await publicClient.getCode({ address: config.contractAddress });
  } catch (error) {
    return failed(error);
  }
  if (code === undefined || code === "0x") {
    return {
      kind: "failed",
      entry: errorEntry(
        "no-contract-code",
        "There is no contract code at KEEPER_CONTRACT_ADDRESS on this chain.",
      ),
    };
  }
  const walletClient = createWalletClient({
    chain,
    transport,
    account: config.account,
  });
  return {
    kind: "connected",
    clients: { publicClient, walletClient },
    chainId,
  };
}

async function main(): Promise<number> {
  const mode = readMode(process.argv.slice(2));
  if (mode === undefined) {
    print(errorEntry("usage", USAGE));
    return 2;
  }

  const result = readConfig(process.env);
  if (result.kind === "problems") {
    for (const problem of result.problems) {
      print({
        orderId: undefined,
        action: Action.Error,
        reason: problem.kind,
        details: [
          ["variable", problem.variable],
          ["message", `${problem.variable} ${problem.message}.`],
        ],
      });
    }
    return 1;
  }
  const { config } = result;

  let abis: KeeperAbis;
  try {
    abis = loadAbis();
  } catch (error) {
    print(
      errorEntry(
        "build-output-missing",
        error instanceof BuildOutputError
          ? error.message
          : "The build output could not be read.",
      ),
    );
    return 1;
  }

  let clients: KeeperClients | undefined;
  const runRound = async (): Promise<RoundReport> => {
    if (clients === undefined) {
      const connection = await connect(config, abis);
      if (connection.kind === "failed") {
        print(connection.entry);
        return { orders: [], roundError: connection.entry };
      }
      clients = connection.clients;
      print({
        orderId: undefined,
        action: Action.Start,
        reason: "connected",
        details: [
          ["mode", mode],
          ["chain-id", connection.chainId.toString()],
          ["contract", config.contractAddress],
          ["executor", config.account.address],
        ],
      });
    }
    return runOnce({
      clients,
      settings: {
        contractAddress: config.contractAddress,
        fromBlock: config.fromBlock,
        maxFeeWei: config.maxFeeWei,
        maxBlockRange: config.maxBlockRange,
      },
      abis,
      log: print,
    });
  };

  if (mode === Mode.Once) {
    return roundHasError(await runRound()) ? 1 : 0;
  }
  await keepRunning({
    runRound,
    intervalMs: config.intervalSeconds * 1000,
    wait: (ms) => sleep(ms),
    log: print,
  });
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Nothing above is expected to throw. The entry names the error's classes
  // only: its message could hold the node URL.
  print(internalErrorEntry("main", error));
  process.exitCode = 1;
}
