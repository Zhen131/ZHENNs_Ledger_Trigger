// The chain the demo's later scenarios play on (S27 to S57, in demoDormant.ts,
// demoDca.ts, demoLadder.ts and demoReceipt.ts): the deployed contracts, opened
// with the script clients, the four test accounts, and the steps several of
// those scenarios take.
//
// Everything a scenario reports is read from the chain: statuses from
// `statusOf`, contract errors by name (and their values) from the rejected
// call, events from the receipt of the transaction that emitted them. The
// keeper's rounds look for orders from a block the scenario gives, so that a
// round sees that scenario's order only, not the ones earlier scenarios left
// open. Nothing here reads the environment.

import type { NetworkConnection } from "hardhat/types/network";
import {
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem";

import { loadAbis } from "../keeper/abi.ts";
import { formatLogLine, type Action, type LogEntry } from "../keeper/log.ts";
import { orderStatusName } from "../keeper/names.ts";
import { runOnce, type RoundReport } from "../keeper/runOnce.ts";
import { formatDecimal, parseDecimal } from "./amounts.ts";
import type { scriptClients } from "./clients.ts";
import type { DeploymentReport } from "./deploy.ts";
import { mined } from "./mined.ts";
import { ScriptError, revertName, revertValues } from "./scriptError.ts";

type Viem = NetworkConnection["viem"];
type Clients = Awaited<ReturnType<typeof scriptClients>>;
type Wallet = Clients["walletClients"][number];

/** What a call led to: it went through and is in a block, or a contract error rejected it. */
export type Tried =
  | { readonly accepted: true; readonly receipt: TransactionReceipt }
  | {
      readonly accepted: false;
      readonly errorName: string;
      /** The values the error carries, in the order it declares them. */
      readonly values: readonly unknown[];
    };

/** Highest fee one keeper transaction may cost here, in wei. */
const KEEPER_MAX_FEE_WEI = 10n ** 17n;
/** Most blocks the keeper reads logs from in one request. */
const KEEPER_MAX_BLOCK_RANGE = 500n;

/** Opens the deployed contracts and sets up the shared steps. */
export async function demoChain(input: {
  readonly viem: Viem;
  readonly clients: Clients;
  readonly deployment: DeploymentReport;
  readonly accounts: {
    readonly owner: Wallet;
    readonly keeper: Wallet;
    readonly recipient: Wallet;
    readonly stranger: Wallet;
  };
}) {
  const { viem, deployment } = input;
  const { publicClient, client } = input.clients;
  const { owner, keeper, recipient, stranger } = input.accounts;
  const params = deployment.parameters;
  const trigger = await viem.getContractAt(
    "LedgerTrigger",
    deployment.trigger,
    { client },
  );
  const usdc = await viem.getContractAt("MockUSDC", params.usdc, { client });
  const feed = await viem.getContractAt("MockPriceFeed", params.priceFeed, {
    client,
  });
  const receipt = await viem.getContractAt("FillReceipt", params.receipt, {
    client,
  });
  const usdcDecimals = await trigger.read.usdcDecimals();
  const priceDecimals = await trigger.read.priceDecimals();
  const as = (wallet: Wallet) => ({ account: wallet.account });

  const toUsdc = (text: string) => parseDecimal(text, usdcDecimals, "amount");
  const toPrice = (text: string) => parseDecimal(text, priceDecimals, "price");
  const usdcText = (value: bigint) =>
    `${formatDecimal(value, usdcDecimals)} USDC`;
  const usdText = (value: bigint) =>
    `${formatDecimal(value, priceDecimals)} USD`;
  const ethText = (wei: bigint) => `${formatDecimal(wei, 18)} ETH`;

  /** Which of the four accounts `address` is, in words. */
  const who = (address: Address | undefined) => {
    if (address === undefined) return "no one";
    if (isAddressEqual(address, keeper.account.address)) return "the executor";
    if (isAddressEqual(address, owner.account.address)) return "the owner";
    if (isAddressEqual(address, recipient.account.address)) {
      return "the recipient";
    }
    if (isAddressEqual(address, stranger.account.address)) {
      return "the stranger";
    }
    return "another account";
  };

  const status = async (orderId: bigint) =>
    orderStatusName(await trigger.read.statusOf([orderId]));
  const feedPrice = async () => (await feed.read.latestRoundData())[1];
  /** Sets the feed's price, which also makes it fresh. */
  const setPrice = async (price: bigint) =>
    mined(publicClient, await feed.write.setAnswer([price], as(owner)));
  /** Sets the owner's USDC allowance to LedgerTrigger. */
  const approve = async (value: bigint) =>
    mined(
      publicClient,
      await usdc.write.approve([trigger.address, value], as(owner)),
    );
  const ethOf = (wallet: Wallet) =>
    publicClient.getBalance({ address: wallet.account.address });

  /**
   * Sends a call and waits for it, or reports which contract error rejected
   * it. Any other failure (no contract error name) stops the demo.
   */
  const tryCall = async (send: () => Promise<Hash>): Promise<Tried> => {
    try {
      return {
        accepted: true,
        receipt: await mined(publicClient, await send()),
      };
    } catch (error) {
      const errorName = revertName(error);
      if (errorName === undefined) throw error;
      return { accepted: false, errorName, values: revertValues(error) ?? [] };
    }
  };
  /** "rejected: <name>" or "accepted". */
  const outcome = (tried: Tried) =>
    tried.accepted ? "accepted" : `rejected: ${tried.errorName}`;

  /**
   * Places a limit order from the owner, with the keeper's account as its
   * executor: a dormant one when `activationPrice` is given.
   */
  const placeLimit = async (order: {
    readonly amount: bigint;
    readonly targetPrice: bigint;
    readonly activationPrice?: bigint;
    readonly validSeconds: bigint;
  }) => {
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    const expiry = latest.timestamp + order.validSeconds;
    const parties = [
      recipient.account.address,
      keeper.account.address,
    ] as const;
    const hash =
      order.activationPrice === undefined
        ? await trigger.write.createOrder(
            [order.amount, order.targetPrice, ...parties, expiry],
            as(owner),
          )
        : await trigger.write.createDormantOrder(
            [
              order.amount,
              order.targetPrice,
              order.activationPrice,
              ...parties,
              expiry,
            ],
            as(owner),
          );
    const placed = await mined(publicClient, hash);
    const [created] = parseEventLogs({
      abi: trigger.abi,
      logs: placed.logs,
      eventName: "OrderCreated",
    });
    if (created === undefined) throw new ScriptError("No OrderCreated event.");
    return { orderId: created.args.orderId, block: placed.blockNumber };
  };

  /**
   * One keeper round, run with the keeper's account, looking for orders from
   * `fromBlock` on. Its log lines go to `log`.
   */
  const keeperRound = (fromBlock: bigint, log: string[]) =>
    runOnce({
      clients: { publicClient, walletClient: keeper },
      settings: {
        contractAddress: trigger.address,
        fromBlock,
        maxFeeWei: KEEPER_MAX_FEE_WEI,
        maxBlockRange: KEEPER_MAX_BLOCK_RANGE,
      },
      abis: loadAbis(),
      log: (entry: LogEntry) =>
        log.push(`keeper: ${formatLogLine(entry, new Date())}`),
    });

  /** The transaction hashes of a round's lines about `orderId` with `action`. */
  const hashesIn = (round: RoundReport, orderId: bigint, action: Action) =>
    round.orders
      .filter((entry) => entry.orderId === orderId && entry.action === action)
      .map((entry) => entry.details.find(([key]) => key === "tx")?.[1])
      .filter((hash): hash is Hash => hash !== undefined);

  const receiptOf = (hash: Hash) =>
    publicClient.getTransactionReceipt({ hash });

  /** The `OrderFilled` events LedgerTrigger emitted for `orderId` in a transaction. */
  const fillsIn = (tx: TransactionReceipt, orderId: bigint) =>
    parseEventLogs({
      abi: trigger.abi,
      logs: tx.logs.filter((entry) =>
        isAddressEqual(entry.address, trigger.address),
      ),
      eventName: "OrderFilled",
    })
      .map((event) => event.args)
      .filter((args) => args.orderId === orderId);

  return {
    viem,
    publicClient,
    trigger,
    usdc,
    feed,
    receipt,
    owner,
    keeper,
    recipient,
    stranger,
    as,
    toUsdc,
    toPrice,
    usdcText,
    usdText,
    ethText,
    who,
    status,
    feedPrice,
    setPrice,
    approve,
    ethOf,
    tryCall,
    outcome,
    placeLimit,
    keeperRound,
    hashesIn,
    receiptOf,
    fillsIn,
  };
}

/** The chain the later scenarios play on. */
export type DemoChain = Awaited<ReturnType<typeof demoChain>>;
