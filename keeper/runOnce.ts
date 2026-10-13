// One round of the keeper: find every order that names this keeper's account
// as executor, activate each dormant one that can be activated now, then fill
// each open or partly filled one as many times as it can be filled now.
//
// The round finds the orders once, then goes through them twice, in the order
// of their IDs.
//
// First pass, activations. Each order's `statusOf` is read once; a failure is
// sorted by `classifyFailure`, and the order is left alone for this round. A
// `Dormant` order is activated:
// 1. `canActivate` says no: skip, logging the reason's name.
// 2. Simulate `activateOrder` from the keeper's account. A failure is sorted
//    by `classifyFailure`.
// 3. Estimate the fee: estimated gas times the highest price per unit of gas
//    the transaction will be sent with. Above the cap: skip, logging both.
// 4. Send the transaction with exactly that gas limit and those fee settings,
//    and wait for its receipt. A failure is sorted by `classifyFailure`.
// 5. Activated: log the transaction hash. The order is Open from now on.
// Orders in any other status get no line in this pass.
//
// Second pass, fills, with the status read in the first pass (not read
// again). An order still Dormant got its line in the first pass. An Open or
// PartiallyFilled order is filled again and again:
// 1. `canFill` says no: skip, logging the reason's name, if the order has not
//    been filled in this round; if it has, stop without a line (a Limit order
//    always says NotOpen after its fill; the next round logs any other
//    reason).
// 2. The order was filled `maxFillsPerOrderPerRound` times in this round
//    already: skip, logging the limit.
// 3. Simulate `fillOrder` from the keeper's account. A failure is sorted by
//    `classifyFailure`.
// 4. Estimate the fee as for an activation. Above the cap: skip, logging both.
// 5. Send the transaction with exactly that gas limit and those fee settings,
//    and wait for its receipt. A failure is sorted by `classifyFailure`.
// 6. Filled: log the transaction hash, and go back to 1.
// Every step but 6 ends the order's turn. An order in any other status
// (Filled, Cancelled, Expired, or a value without a name) is skipped, logging
// the status.
//
// Activations come first because an activation needs the price at the moment
// it rises to the activation price, while every fill waits for its receipt.
// The second pass includes the orders just activated, since the activation
// price of a Dca order may be at or below its target price.
//
// The keeper only triggers activations and fills: the contract itself checks
// the price, the caller and the money. It calls `activateOrder`, `fillOrder`
// and read-only functions of the configured contract only, and sends no ETH.
// One order's trouble never stops the others. Nothing is kept from one round
// to the next.
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
import { DEFAULTS } from "./config.ts";
import { findOrders } from "./findOrders.ts";
import { Action, failureEntry, type LogEntry, type Logger } from "./log.ts";
import {
  OrderStatus,
  activationBlockerName,
  fillBlockerName,
  orderStatusName,
} from "./names.ts";

/**
 * How long to wait for a sent transaction (a fill or an activation) to be
 * mined before giving up on it.
 */
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
  /**
   * Most fills of one order in this round; at least 1. When it is not given,
   * `DEFAULTS.maxFillsPerOrderPerRound`.
   */
  readonly maxFillsPerOrderPerRound?: number;
};

export type RoundInput = {
  readonly clients: KeeperClients;
  readonly settings: RoundSettings;
  readonly abis: KeeperAbis;
  readonly log: Logger;
};

export type RoundReport = {
  /**
   * Every line about an order in this round, in the order they were written.
   * One order can have several: an activation, then fills, then a skip.
   */
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

/** The configured contract, as viem takes it for a read or a call. */
function contractOf(input: RoundInput) {
  return {
    address: input.settings.contractAddress,
    abi: input.abis.trigger,
  } as const;
}

/** Activates one Dormant order: steps 1 to 5 of the first pass. */
async function activate(input: RoundInput, orderId: bigint): Promise<LogEntry> {
  const { publicClient, walletClient } = input.clients;
  const contract = contractOf(input);
  const activation = {
    ...contract,
    functionName: "activateOrder",
    args: [orderId],
    account: walletClient.account,
  } as const;
  let step = "canActivate";
  let hash: Hash | undefined;
  try {
    const [activatable, blocker] = await publicClient.readContract({
      ...contract,
      functionName: "canActivate",
      args: [orderId],
    });
    if (!activatable) {
      return skip(orderId, activationBlockerName(blocker), [
        ["check", "canActivate"],
      ]);
    }

    step = "activate-simulate";
    await publicClient.simulateContract(activation);

    step = "activate-estimate";
    const gas = await publicClient.estimateContractGas(activation);
    const { maxFeePerGas, maxPriorityFeePerGas } =
      await publicClient.estimateFeesPerGas();
    const estimatedFee = gas * maxFeePerGas;
    if (estimatedFee > input.settings.maxFeeWei) {
      return skip(orderId, "fee-above-cap", [
        ["step", step],
        ["estimated-fee-wei", estimatedFee.toString()],
        ["cap-wei", input.settings.maxFeeWei.toString()],
      ]);
    }

    step = "activate-send";
    hash = await walletClient.writeContract({
      ...activation,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    step = "activate-receipt";
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
      action: Action.Activate,
      reason: "transaction-succeeded",
      details: [["tx", hash]],
    } satisfies LogEntry;
  } catch (error) {
    const entry = failureEntry(
      orderId,
      step,
      classifyFailure({ kind: FailureKind.Thrown, error }, input.abis.errors),
    );
    // A transaction that was sent may still be mined: say which one it was.
    return hash === undefined
      ? entry
      : { ...entry, details: [...entry.details, ["tx", hash] as const] };
  }
}

/** What `canFill` said about an order, or how asking it failed. */
type FillCheck =
  | { readonly kind: "fillable" }
  /** `canFill` says no; `entry` is the skip line naming the reason. */
  | { readonly kind: "blocked"; readonly entry: LogEntry }
  /** Asking `canFill` failed; `entry` is the line for the failure. */
  | { readonly kind: "failed"; readonly entry: LogEntry };

/** Asks `canFill`: step 1 of the second pass. */
async function checkFill(
  input: RoundInput,
  orderId: bigint,
): Promise<FillCheck> {
  try {
    const [fillable, blocker] = await input.clients.publicClient.readContract({
      ...contractOf(input),
      functionName: "canFill",
      args: [orderId],
    });
    return fillable
      ? { kind: "fillable" }
      : {
          kind: "blocked",
          entry: skip(orderId, fillBlockerName(blocker), [
            ["check", "canFill"],
          ]),
        };
  } catch (error) {
    return {
      kind: "failed",
      entry: failureEntry(
        orderId,
        "canFill",
        classifyFailure({ kind: FailureKind.Thrown, error }, input.abis.errors),
      ),
    };
  }
}

/** Fills an order once `canFill` said yes: steps 3 to 6 of the second pass. */
async function sendFill(input: RoundInput, orderId: bigint): Promise<LogEntry> {
  const { publicClient, walletClient } = input.clients;
  const fill = {
    ...contractOf(input),
    functionName: "fillOrder",
    args: [orderId],
    account: walletClient.account,
  } as const;
  let step = "simulate";
  let hash: Hash | undefined;
  try {
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
    hash = await walletClient.writeContract({
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
    const entry = failureEntry(
      orderId,
      step,
      classifyFailure({ kind: FailureKind.Thrown, error }, input.abis.errors),
    );
    // A transaction that was sent may still be mined: say which one it was.
    return hash === undefined
      ? entry
      : { ...entry, details: [...entry.details, ["tx", hash] as const] };
  }
}

/**
 * Fills an Open or PartiallyFilled order as many times as it can be filled
 * now, up to the most fills of one round: the second pass for one order.
 * Hands every line to `write`.
 */
async function fillRepeatedly(
  input: RoundInput,
  orderId: bigint,
  write: (entry: LogEntry) => void,
): Promise<void> {
  const limit =
    input.settings.maxFillsPerOrderPerRound ??
    DEFAULTS.maxFillsPerOrderPerRound;
  for (let fills = 0; ; fills += 1) {
    const check = await checkFill(input, orderId);
    if (check.kind === "failed") {
      write(check.entry);
      return;
    }
    if (check.kind === "blocked") {
      if (fills === 0) write(check.entry);
      return;
    }
    if (fills >= limit) {
      write(skip(orderId, "fill-limit-reached", [["limit", limit.toString()]]));
      return;
    }
    const entry = await sendFill(input, orderId);
    write(entry);
    if (entry.action !== Action.Fill) return;
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
  const write = (entry: LogEntry) => {
    input.log(entry);
    orders.push(entry);
  };

  // First pass: read each order's status once; activate the Dormant ones.
  const looked: { readonly orderId: bigint; readonly status: number }[] = [];
  for (const orderId of orderIds) {
    let status: number;
    try {
      status = await publicClient.readContract({
        ...contractOf(input),
        functionName: "statusOf",
        args: [orderId],
      });
    } catch (error) {
      write(
        failureEntry(
          orderId,
          "statusOf",
          classifyFailure(
            { kind: FailureKind.Thrown, error },
            input.abis.errors,
          ),
        ),
      );
      continue;
    }
    if (status === OrderStatus.Dormant) {
      const entry = await activate(input, orderId);
      write(entry);
      if (entry.action === Action.Activate) status = OrderStatus.Open;
    }
    looked.push({ orderId, status });
  }

  // Second pass: fill the Open and PartiallyFilled ones.
  for (const { orderId, status } of looked) {
    if (status === OrderStatus.Dormant) continue;
    if (status === OrderStatus.Open || status === OrderStatus.PartiallyFilled) {
      await fillRepeatedly(input, orderId, write);
    } else {
      write(skip(orderId, orderStatusName(status), [["check", "statusOf"]]));
    }
  }

  const count = (action: string) =>
    orders.filter((entry) => entry.action === action).length.toString();
  input.log({
    orderId: undefined,
    action: Action.RoundEnd,
    reason: "done",
    details: [
      ["activated", count(Action.Activate)],
      ["filled", count(Action.Fill)],
      ["skipped", count(Action.Skip)],
      ["errors", count(Action.Error)],
    ],
  });
  return { orders, roundError: undefined };
}
