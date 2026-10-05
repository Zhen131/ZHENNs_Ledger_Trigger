// Entry point of the keeper.
//
// Usage:
//   npm run keeper             keep running: a round, a pause, another round...
//   npm run keeper -- --once   run one round, then exit
//
// The settings come from environment variables only (see config.ts and the
// README). Build the contracts first: the ABIs are read from the build output.
//
// Start-up: read the settings; read the ABIs; ask the node for its chain ID
// (nothing is assumed about which chain it is); check that the contract
// address holds code. Then run rounds.
//
// Exit codes: 0 when everything went through or was skipped; 1 on an error
// (bad settings, missing build output, a node that cannot be reached or that
// reports an error, no contract code at the address, or, in --once mode, an
// error in the round); 2 on an unknown command-line argument.
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

import { BuildOutputError, loadAbis } from "./abi.ts";
import {
  FailureKind,
  classifyFailure,
  type Classification,
} from "./classify.ts";
import { readConfig } from "./config.ts";
import { keepRunning } from "./keepRunning.ts";
import {
  Action,
  failureEntry,
  formatLogLine,
  internalErrorEntry,
  type LogEntry,
} from "./log.ts";
import { roundHasError, runOnce } from "./runOnce.ts";

const Mode = {
  Once: "once",
  KeepRunning: "keep-running",
} as const;
type Mode = (typeof Mode)[keyof typeof Mode];

const USAGE = "Usage: node keeper/main.ts [--once]";

function print(entry: LogEntry): void {
  console.log(formatLogLine(entry, new Date()));
}

function printError(reason: string, message: string): void {
  print({
    orderId: undefined,
    action: Action.Error,
    reason,
    details: [["message", message]],
  });
}

function printFailure(step: string, classification: Classification): void {
  print({
    ...failureEntry(undefined, step, classification),
    action: Action.Error,
  });
}

function readMode(args: readonly string[]): Mode | undefined {
  if (args.length === 0) return Mode.KeepRunning;
  if (args.length === 1 && args[0] === "--once") return Mode.Once;
  return undefined;
}

async function main(): Promise<number> {
  const mode = readMode(process.argv.slice(2));
  if (mode === undefined) {
    printError("usage", USAGE);
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

  let abis;
  try {
    abis = loadAbis();
  } catch (error) {
    printError(
      "build-output-missing",
      error instanceof BuildOutputError
        ? error.message
        : "The build output could not be read.",
    );
    return 1;
  }
  const failure = (error: unknown) =>
    classifyFailure({ kind: FailureKind.Thrown, error }, abis.errors);

  const transport = http(config.rpcUrl);
  let chainId: number;
  try {
    chainId = await createPublicClient({ transport }).getChainId();
  } catch (error) {
    printFailure("connect", failure(error));
    return 1;
  }
  const chain = defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    chain,
    transport,
    account: config.account,
  });

  try {
    const code = await publicClient.getCode({
      address: config.contractAddress,
    });
    if (code === undefined || code === "0x") {
      printError(
        "no-contract-code",
        "There is no contract code at KEEPER_CONTRACT_ADDRESS on this chain.",
      );
      return 1;
    }
  } catch (error) {
    printFailure("connect", failure(error));
    return 1;
  }

  print({
    orderId: undefined,
    action: Action.Start,
    reason: "connected",
    details: [
      ["mode", mode],
      ["chain-id", chainId.toString()],
      ["contract", config.contractAddress],
      ["executor", config.account.address],
    ],
  });
  const runRound = () =>
    runOnce({
      clients: { publicClient, walletClient },
      settings: {
        contractAddress: config.contractAddress,
        fromBlock: config.fromBlock,
        maxFeeWei: config.maxFeeWei,
        maxBlockRange: config.maxBlockRange,
      },
      abis,
      log: print,
    });

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
