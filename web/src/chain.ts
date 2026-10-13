// Reads the chain, always through the local node, never through the wallet.
//
// One viem client reads everything: the contract's settings, the price, the
// balances, the orders and the events. It does not follow a contract's
// request to fetch data from a web address (CCIP-read is off), and it polls
// at most every second.

import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { OrderStatus } from "../../keeper/names.ts";
import { PRICE_FEED_ABI, TRIGGER_ABI, USDC_ABI } from "./contracts.ts";
import type { FeedLog } from "./lib/feed.ts";
import { OrderKind } from "./lib/kinds.ts";
import type { ContractLimits } from "./lib/limits.ts";
import type {
  CreatedOrder,
  Decimals,
  OrderSnapshot,
  ScheduleData,
  StoredOrder,
  TierData,
} from "./lib/orders.ts";

export const POLLING_MS = 1000;

/** The client that reads the local node at `rpcUrl`. */
export function createReader(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    pollingInterval: POLLING_MS,
    ccipRead: false,
  });
}

/** What the page needs to know about the LedgerTrigger it works with. */
export type Trigger = {
  readonly address: Address;
  readonly usdc: Address;
  readonly priceFeed: Address;
  readonly decimals: Decimals;
  /** The four deployment limits the page shows under the address. */
  readonly limits: ContractLimits;
};

export type TriggerLoad =
  | { readonly ok: true; readonly trigger: Trigger }
  | { readonly ok: false; readonly message: string };

function read<T>(
  client: PublicClient,
  address: Address,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return client.readContract({
    address,
    abi: TRIGGER_ABI,
    functionName,
    args,
  }) as Promise<T>;
}

/** Checks the address and reads the contract's settings from it. */
export async function loadTrigger(
  client: PublicClient,
  text: string,
): Promise<TriggerLoad> {
  const trimmed = text.trim();
  if (!isAddress(trimmed, { strict: false })) {
    return {
      ok: false,
      message: "That is not an address: enter 0x followed by 40 hex digits.",
    };
  }
  const address = getAddress(trimmed);
  let code: Hex | undefined;
  try {
    code = await client.getCode({ address });
  } catch {
    return {
      ok: false,
      message:
        "The local node does not answer. Start it with npx hardhat node, then load the address again.",
    };
  }
  if (code === undefined || code === "0x") {
    return {
      ok: false,
      message:
        "There is no contract at this address on the local node. Check the address that the deployment printed.",
    };
  }
  try {
    const [
      usdc,
      priceFeed,
      usdcDecimals,
      priceDecimals,
      maxOrderAmount,
      maxOpenOrdersPerOwner,
      maxPeriodsPerOrder,
      maxTiersPerOrder,
    ] = await Promise.all([
      read<Address>(client, address, "usdc"),
      read<Address>(client, address, "priceFeed"),
      read<number>(client, address, "usdcDecimals"),
      read<number>(client, address, "priceDecimals"),
      read<bigint>(client, address, "maxOrderAmount"),
      read<bigint>(client, address, "maxOpenOrdersPerOwner"),
      read<bigint>(client, address, "maxPeriodsPerOrder"),
      read<bigint>(client, address, "maxTiersPerOrder"),
    ]);
    return {
      ok: true,
      trigger: {
        address,
        usdc,
        priceFeed,
        decimals: { usdc: Number(usdcDecimals), price: Number(priceDecimals) },
        limits: {
          maxOrderAmount,
          maxOpenOrdersPerOwner,
          maxPeriodsPerOrder,
          maxTiersPerOrder,
        },
      },
    };
  } catch {
    return {
      ok: false,
      message:
        "The contract at this address is not a LedgerTrigger: its settings could not be read. Use the LedgerTrigger address that the deployment printed, not the FillReceipt one.",
    };
  }
}

/** The price feed's latest answer and its update time. */
export async function readPrice(
  client: PublicClient,
  trigger: Trigger,
): Promise<{ readonly price: bigint; readonly updatedAt: bigint }> {
  const round = (await client.readContract({
    address: trigger.priceFeed,
    abi: PRICE_FEED_ABI,
    functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return { price: round[1], updatedAt: round[3] };
}

/** `owner`'s USDC balance and allowance to the contract. */
export async function readUsdc(
  client: PublicClient,
  trigger: Trigger,
  owner: Address,
): Promise<{ readonly balance: bigint; readonly allowance: bigint }> {
  const [balance, allowance] = await Promise.all([
    client.readContract({
      address: trigger.usdc,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [owner],
    }),
    client.readContract({
      address: trigger.usdc,
      abi: USDC_ABI,
      functionName: "allowance",
      args: [owner, trigger.address],
    }),
  ]);
  return { balance, allowance };
}

/** `owner`'s open orders: how many, and their USDC added up. */
export async function readOpenOrders(
  client: PublicClient,
  trigger: Trigger,
  owner: Address,
): Promise<{ readonly count: bigint; readonly total: bigint }> {
  const [count, total] = await Promise.all([
    read<bigint>(client, trigger.address, "openOrderCount", [owner]),
    read<bigint>(client, trigger.address, "openOrderTotal", [owner]),
  ]);
  return { count, total };
}

/**
 * One order: `getOrder`, `statusOf` and `canFill`; then `canActivate` when it
 * is dormant, `getSchedule` when it is a Dca order and `getTiers` when it is
 * a Ladder order. Throws `OrderNotFound`.
 */
export async function readSnapshot(
  client: PublicClient,
  trigger: Trigger,
  orderId: bigint,
): Promise<OrderSnapshot> {
  const [order, statusValue, check] = await Promise.all([
    read<StoredOrder>(client, trigger.address, "getOrder", [orderId]),
    read<number>(client, trigger.address, "statusOf", [orderId]),
    read<readonly [boolean, number]>(client, trigger.address, "canFill", [
      orderId,
    ]),
  ]);
  const status = Number(statusValue);
  const kind = Number(order.kind);
  const [activation, schedule, tiers] = await Promise.all([
    status === OrderStatus.Dormant
      ? read<readonly [boolean, number]>(
          client,
          trigger.address,
          "canActivate",
          [orderId],
        )
      : undefined,
    kind === OrderKind.Dca
      ? read<ScheduleData>(client, trigger.address, "getSchedule", [orderId])
      : undefined,
    kind === OrderKind.Ladder
      ? read<readonly TierData[]>(client, trigger.address, "getTiers", [
          orderId,
        ])
      : undefined,
  ]);
  return {
    orderId,
    order: { ...order, kind },
    status,
    check: { fillable: check[0], reason: Number(check[1]) },
    ...(activation === undefined
      ? {}
      : {
          activation: {
            activatable: activation[0],
            reason: Number(activation[1]),
          },
        }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(tiers === undefined ? {} : { tiers }),
  };
}

type DecodedLog = {
  readonly eventName?: string;
  readonly args?: Record<string, unknown>;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash: Hex | null;
};

const FEED_EVENTS = [
  "OrderCreated",
  "OrderScheduled",
  "OrderTiered",
  "OrderActivated",
  "OrderCancelled",
  "OrderFilled",
];

/**
 * The contract's events from block `fromBlock` to `toBlock`: the orders
 * placed, and the six kinds the event list shows, each with the time of its
 * block (`blockTimes` caches those). Only this contract's address is read,
 * so the receipt contract's events never come in.
 */
export async function readEvents(
  client: PublicClient,
  trigger: Trigger,
  fromBlock: bigint,
  toBlock: bigint,
  blockTimes: Map<bigint, bigint>,
): Promise<{ readonly created: CreatedOrder[]; readonly logs: FeedLog[] }> {
  const decoded = (await client.getContractEvents({
    address: trigger.address,
    abi: TRIGGER_ABI,
    fromBlock,
    toBlock,
    strict: true,
  })) as unknown as readonly DecodedLog[];
  const events = decoded.filter(
    (log) =>
      log.eventName !== undefined &&
      FEED_EVENTS.includes(log.eventName) &&
      log.blockNumber !== null &&
      log.logIndex !== null &&
      log.transactionHash !== null,
  );
  for (const blockNumber of new Set(
    events.map((log) => log.blockNumber ?? 0n),
  )) {
    if (!blockTimes.has(blockNumber)) {
      const block = await client.getBlock({ blockNumber });
      blockTimes.set(blockNumber, block.timestamp);
    }
  }
  const created: CreatedOrder[] = [];
  const logs: FeedLog[] = [];
  for (const log of events) {
    const blockNumber = log.blockNumber ?? 0n;
    const position = {
      blockNumber,
      logIndex: log.logIndex ?? 0,
      transactionHash: log.transactionHash ?? "0x",
      time: blockTimes.get(blockNumber) ?? 0n,
    };
    const args = log.args ?? {};
    if (log.eventName === "OrderCreated") {
      created.push({
        orderId: args["orderId"] as bigint,
        owner: args["owner"] as Address,
      });
    }
    logs.push({ eventName: log.eventName, args, position } as FeedLog);
  }
  return { created, logs };
}
