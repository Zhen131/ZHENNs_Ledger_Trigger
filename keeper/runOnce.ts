// One round of the keeper: find every order that names this keeper's account
// as executor, and fill each one that can be filled now.
//
// For each order, in this order:
// 1. `statusOf` is not Open: skip, logging the status.
// 2. `canFill` says no: skip, logging the reason's name.
// 3. Simulate `fillOrder` from the keeper's account. A failure is sorted by
//    `classifyFailure`.
// 4. Estimate the fee: estimated gas times the highest price per unit of gas
//    the transaction will be sent with. Above the cap: skip, logging both.
// 5. Send the transaction with exactly that gas limit and those fee settings,
//    and wait for its receipt. A failure is sorted by `classifyFailure`.
// 6. Filled: log the transaction hash.
//
// The keeper only triggers fills: the contract itself checks the price, the
// caller and the money. It calls `fillOrder` and read-only functions of the
// configured contract only, and sends no ETH. One order's trouble never stops
// the others.
//
// The round takes its clients and settings from the caller and never reads
// the environment.

import type {
  Account,
  Address,
  Chain,
  Hash,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";

import type { KeeperAbis } from "./abi.ts";
import { FailureKind, classifyFailure } from "./classify.ts";
import { findOrders } from "./findOrders.ts";
import { Action, failureEntry, type LogEntry, type Logger } from "./log.ts";
import { OrderStatus, fillBlockerName, orderStatusName } from "./names.ts";

/** How long to wait for a sent fill to be mined before giving up on it. */
const RECEIPT_TIMEOUT_MS = 180_000;

export type KeeperClients = {
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Signs and sends as the executor. Its account is the keeper's account. */
  readonly walletClient: WalletClient<Transport, Chain, Account>;
};

/** The settings one round needs. No key is among them. */
export type RoundSettings = {
  readonly contractAddress: Address;
  readonly fromBlock: bigint;
  readonly maxFeeWei: bigint;
  readonly maxBlockRange: bigint;
};

export type RoundInput = {
  readonly clients: KeeperClients;
  readonly settings: RoundSettings;
  readonly abis: KeeperAbis;
  readonly log: Logger;
};

export type RoundReport = {
  /** What was done with each order found, in the order they were handled. */
  readonly orders: readonly LogEntry[];
  /** Set when the round failed before it could look at the orders. */
  readonly roundError: LogEntry | undefined;
};

/** True when anything in the round counts as an error, not as a skip. */
export function roundHasError(report: RoundReport): boolean {
  return (
    report.roundError !== undefined ||
    report.orders.some((entry) => entry.action === Action.Error)
  );
}

function skip(
  orderId: bigint,
  reason: string,
  details: LogEntry["details"],
): LogEntry {
  return { orderId, action: Action.Skip, reason, details };
}

async function handleOrder(input: RoundInput, orderId: bigint) {
  const { publicClient, walletClient } = input.clients;
  const contract = {
    address: input.settings.contractAddress,
    abi: input.abis.trigger,
  } as const;
  const fill = {
    ...contract,
    functionName: "fillOrder",
    args: [orderId],
    account: walletClient.account,
  } as const;
  let step = "statusOf";
  try {
    const status = await publicClient.readContract({
      ...contract,
      functionName: "statusOf",
      args: [orderId],
    });
    if (status !== OrderStatus.Open) {
      return skip(orderId, orderStatusName(status), [["check", "statusOf"]]);
    }

    step = "canFill";
    const [fillable, blocker] = await publicClient.readContract({
      ...contract,
      functionName: "canFill",
      args: [orderId],
    });
    if (!fillable) {
      return skip(orderId, fillBlockerName(blocker), [["check", "canFill"]]);
    }

    step = "simulate";
    await publicClient.simulateContract(fill);

    step = "estimate";
    const gas = await publicClient.estimateContractGas(fill);
    const { maxFeePerGas, maxPriorityFeePerGas } =
      await publicClient.estimateFeesPerGas();
    const estimatedFee = gas * maxFeePerGas;
    if (estimatedFee > input.settings.maxFeeWei) {
      return skip(orderId, "fee-above-cap", [
        ["estimated-fee-wei", estimatedFee.toString()],
        ["cap-wei", input.settings.maxFeeWei.toString()],
      ]);
    }

    step = "send";
    const hash: Hash = await walletClient.writeContract({
      ...fill,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    step = "receipt";
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    if (receipt.status !== "success") {
      return failureEntry(
        orderId,
        step,
        classifyFailure(
          { kind: FailureKind.RevertedReceipt, transactionHash: hash },
          input.abis.errors,
        ),
      );
    }
    return {
      orderId,
      action: Action.Fill,
      reason: "transaction-succeeded",
      details: [["tx", hash]],
    } satisfies LogEntry;
  } catch (error) {
    return failureEntry(
      orderId,
      step,
      classifyFailure({ kind: FailureKind.Thrown, error }, input.abis.errors),
    );
  }
}

/** Runs one round and logs every step through `input.log`. */
export async function runOnce(input: RoundInput): Promise<RoundReport> {
  const { publicClient, walletClient } = input.clients;
  const { settings } = input;
  let toBlock: bigint;
  let orderIds: bigint[];
  try {
    toBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    orderIds = await findOrders({
      publicClient,
      abi: input.abis.trigger,
      contractAddress: settings.contractAddress,
      executor: walletClient.account.address,
      fromBlock: settings.fromBlock,
      toBlock,
      maxBlockRange: settings.maxBlockRange,
    });
  } catch (error) {
    const entry: LogEntry = {
      ...failureEntry(
        undefined,
        "find-orders",
        classifyFailure({ kind: FailureKind.Thrown, error }, input.abis.errors),
      ),
      action: Action.Error,
    };
    input.log(entry);
    return { orders: [], roundError: entry };
  }

  input.log({
    orderId: undefined,
    action: Action.RoundStart,
    reason: "orders-found",
    details: [
      ["from-block", settings.fromBlock.toString()],
      ["to-block", toBlock.toString()],
      ["orders", orderIds.length.toString()],
    ],
  });
  const orders: LogEntry[] = [];
  for (const orderId of orderIds) {
    const entry = await handleOrder(input, orderId);
    input.log(entry);
    orders.push(entry);
  }
  const count = (action: string) =>
    orders.filter((entry) => entry.action === action).length.toString();
  input.log({
    orderId: undefined,
    action: Action.RoundEnd,
    reason: "done",
    details: [
      ["filled", count(Action.Fill)],
      ["skipped", count(Action.Skip)],
      ["errors", count(Action.Error)],
    ],
  });
  return { orders, roundError: undefined };
}
