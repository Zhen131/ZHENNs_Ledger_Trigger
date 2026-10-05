// Sets up a brand-new local chain for the keeper tests: the fill set-up from
// `setUpFills`, with Hardhat's `executor` test account as the keeper's
// account, and a helper that runs one keeper round and collects its log.
//
// This file holds no tests; test files import `setUpKeeper` from it.

import {
  createPublicClient,
  custom,
  parseEventLogs,
  type EIP1193RequestFn,
} from "viem";

import { loadAbis } from "../keeper/abi.ts";
import { formatLogLine, type LogEntry } from "../keeper/log.ts";
import {
  runOnce,
  type KeeperClients,
  type RoundSettings,
} from "../keeper/runOnce.ts";
import { ONE_ETH, setUpFills, type SetUpOptions } from "./setUpFills.ts";

/** A fee cap far above what a fill costs on the local chain. */
export const GENEROUS_FEE_CAP = ONE_ETH / 10n;

/** The log lines of `entries`, all stamped with the Unix epoch. */
export function logText(entries: readonly LogEntry[]): string[] {
  return entries.map((entry) => formatLogLine(entry, new Date(0)));
}

export async function setUpKeeper(options: SetUpOptions = {}) {
  const f = await setUpFills(options);
  const abis = loadAbis();
  const keeper = f.executor;
  const settings: RoundSettings = {
    contractAddress: f.trigger.address,
    fromBlock: 0n,
    maxFeeWei: GENEROUS_FEE_CAP,
    maxBlockRange: 500n,
  };
  const clients: KeeperClients = {
    publicClient: f.publicClient,
    walletClient: keeper,
  };

  /**
   * Runs one keeper round with `settings` changed by `changes` and `clients`
   * changed by `clientChanges`. Returns the report and every log entry, as
   * entries and as lines.
   */
  async function round(
    changes: Partial<RoundSettings> = {},
    clientChanges: Partial<KeeperClients> = {},
  ) {
    const entries: LogEntry[] = [];
    const report = await runOnce({
      clients: { ...clients, ...clientChanges },
      settings: { ...settings, ...changes },
      abis,
      log: (entry) => entries.push(entry),
    });
    return { report, entries, lines: logText(entries) };
  }

  /** How many transactions the keeper's account has sent. */
  function keeperNonce(): Promise<number> {
    return f.publicClient.getTransactionCount({
      address: keeper.account.address,
    });
  }

  /** Every OrderFilled event of the main LedgerTrigger so far. */
  async function filledEvents() {
    const logs = await f.publicClient.getLogs({
      address: f.trigger.address,
      fromBlock: 0n,
    });
    return parseEventLogs({
      abi: f.trigger.abi,
      logs,
      eventName: "OrderFilled",
    });
  }

  /**
   * A public client on the same chain whose every request goes through
   * `request`, so a test can watch or break requests before they reach the
   * chain. `forward` passes a request on unchanged.
   */
  function publicClientThrough(
    request: (
      args: { readonly method: string; readonly params?: unknown },
      forward: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): KeeperClients["publicClient"] {
    const forwardTo = f.publicClient.request as unknown as EIP1193RequestFn;
    return createPublicClient({
      chain: f.publicClient.chain,
      transport: custom(
        {
          request: (args: { method: string; params?: unknown }) =>
            request(args, () => forwardTo(args as never)),
        },
        { retryCount: 0 },
      ),
    });
  }

  return {
    ...f,
    abis,
    keeper,
    settings,
    clients,
    round,
    keeperNonce,
    filledEvents,
    publicClientThrough,
  };
}
