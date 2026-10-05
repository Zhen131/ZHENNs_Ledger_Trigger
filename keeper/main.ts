// Entry point of the keeper.
//
// Usage:
//   npm run keeper             keep running: a round, a pause, another round...
//   npm run keeper -- --once   run one round, then exit
//
// The settings come from environment variables only (see config.ts and the
// README). Build the contracts first: the ABIs are read from the build output.
//
// Before its first round the keeper gets ready: it checks the settings, reads
// the ABIs, asks the node for its chain ID (nothing is assumed about which
// chain it is) and checks that the contract address holds code. When any of
// that fails, the round is an error: in --once mode the keeper exits with 1;
// in keep-running mode it logs the error and tries again in the next round.
// Once ready, rounds run as described in runOnce.ts.
//
// Exit codes: 0 when everything went through or was skipped; 1, in --once
// mode, on any error, getting ready included; 2 on an unknown command-line
// argument. In keep-running mode the keeper runs until it is stopped.
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
import { readConfig, type ConfigResult, type KeeperConfig } from "./config.ts";
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

type Preparation =
  | {
      readonly kind: "ready";
      readonly config: KeeperConfig;
      readonly abis: KeeperAbis;
      readonly clients: KeeperClients;
      readonly chainId: number;
    }
  | { readonly kind: "not-ready"; readonly entries: readonly LogEntry[] };

/**
 * What a round needs before it can start: valid settings, the ABIs and a
 * connection. Returns the error entries instead when any of them is missing.
 */
async function prepare(result: ConfigResult): Promise<Preparation> {
  if (result.kind === "problems") {
    return {
      kind: "not-ready",
      entries: result.problems.map((problem) => ({
        orderId: undefined,
        action: Action.Error,
        reason: problem.kind,
        details: [
          ["variable", problem.variable],
          ["message", `${problem.variable} ${problem.message}.`],
        ],
      })),
    };
  }
  const { config } = result;
  let abis: KeeperAbis;
  try {
    abis = loadAbis();
  } catch (error) {
    return {
      kind: "not-ready",
      entries: [
        errorEntry(
          "build-output-missing",
          error instanceof BuildOutputError
            ? error.message
            : "The build output could not be read.",
        ),
      ],
    };
  }
  const connection = await connect(config, abis);
  if (connection.kind === "failed") {
    return { kind: "not-ready", entries: [connection.entry] };
  }
  return {
    kind: "ready",
    config,
    abis,
    clients: connection.clients,
    chainId: connection.chainId,
  };
}

async function main(): Promise<number> {
  const mode = readMode(process.argv.slice(2));
  if (mode === undefined) {
    print(errorEntry("usage", USAGE));
    return 2;
  }

  // The environment does not change while the keeper runs, so it is read once.
  const result = readConfig(process.env);
  let ready: Extract<Preparation, { kind: "ready" }> | undefined;
  const runRound = async (): Promise<RoundReport> => {
    if (ready === undefined) {
      const preparation = await prepare(result);
      if (preparation.kind === "not-ready") {
        for (const entry of preparation.entries) print(entry);
        return {
          orders: [],
          roundError:
            preparation.entries[0] ??
            errorEntry("not-ready", "The keeper could not start a round."),
        };
      }
      ready = preparation;
      print({
        orderId: undefined,
        action: Action.Start,
        reason: "connected",
        details: [
          ["mode", mode],
          ["chain-id", ready.chainId.toString()],
          ["contract", ready.config.contractAddress],
          ["executor", ready.config.account.address],
        ],
      });
    }
    const { config, abis, clients } = ready;
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
    intervalMs: result.intervalSeconds * 1000,
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
