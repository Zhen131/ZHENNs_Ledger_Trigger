// The demo: six of the order contract's test scenarios, played on a fresh
// local chain, two that must succeed and four that must be rejected.
//
//   S01 normal fill (filled by the keeper's round), S03 cancel, S04 a stranger
//   fills, S06 the price is above the target, S07 a second fill of the same
//   order, S15 the allowance is too small.
//
// Each scenario uses a new order of its own. What each one should lead to is
// written in EXPECTED below, in the words of the scenario table. What it led
// to is read from the chain, item by item: statuses from `statusOf`, the name
// of the error a rejected call reverted with, and balance changes. A scenario
// passes when the two lists are equal.
//
// Accounts are Hardhat's test accounts: #0 places the orders (and deploys),
// #1 is the executor named in each order and runs the keeper, #2 receives the
// ETH, #3 is a stranger with no role. Every amount is made up.
//
// `runDemo` passes the send gate first: it runs on Hardhat's local chain only.

import type { NetworkConnection } from "hardhat/types/network";
import { parseEventLogs, type Address, type Hash } from "viem";

import { loadAbis } from "../keeper/abi.ts";
import { Action, formatLogLine, type LogEntry } from "../keeper/log.ts";
import { orderStatusName } from "../keeper/names.ts";
import { runOnce } from "../keeper/runOnce.ts";
import { formatDecimal, parseDecimal } from "./amounts.ts";
import {
  DEPLOY_DEFAULTS,
  MOCK_FEED_DECIMALS,
  deployWithMocks,
} from "./deploy.ts";
import { mined } from "./mined.ts";
import { ScriptError, revertName } from "./scriptError.ts";
import { GatedScript, passSendGate } from "./sendGate.ts";

type Viem = NetworkConnection["viem"];

/** The scenarios the demo plays, in order. */
export const DEMO_SCENARIOS = [
  "S01",
  "S03",
  "S04",
  "S06",
  "S07",
  "S15",
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

/** Each scenario's title and expected result, from the scenario table. */
export const EXPECTED: Readonly<
  Record<
    DemoScenario,
    { readonly title: string; readonly expected: readonly string[] }
  >
> = {
  S01: {
    title: "Normal fill",
    expected: ["Open -> Filled", "ETH to the recipient, not to the caller"],
  },
  S03: { title: "Cancel", expected: ["Open -> Cancelled"] },
  S04: {
    title: "A stranger fills",
    expected: ["transaction rejected: NotOrderOwnerOrExecutor"],
  },
  S06: {
    title: "Price above the target",
    expected: [
      "transaction rejected: PriceAboveTarget",
      "order afterwards: Open",
    ],
  },
  S07: {
    title: "The same order filled twice",
    expected: [
      "first fill: Open -> Filled",
      "second fill rejected: OrderNotOpen",
    ],
  },
  S15: {
    title: "Allowance too small",
    expected: [
      "transaction rejected: InsufficientAllowance",
      "order afterwards: Open",
      "after topping up the allowance: Open -> Filled",
    ],
  },
};

/** The made-up numbers every scenario uses, as people write them. */
export const DEMO_NUMBERS = {
  /** The price feed's first price, above the target. */
  startPriceUsd: "2100",
  /** Each order's target price, and the price a fill is tried at. */
  targetPriceUsd: "2000",
  /** Each order's amount. */
  orderUsdc: "100",
  /** USDC the owner mints before the first order. */
  ownerUsdc: "1000",
  /** The allowance S15 starts with, below the order amount. */
  shortAllowanceUsdc: "50",
  /** ETH stocked in the swap venue. */
  venueEth: "10",
  /** Each order's validity. */
  validMinutes: 24n * 60n,
} as const;

/** One scenario's row: what was done, what was expected, what happened. */
export type DemoRow = {
  readonly id: DemoScenario;
  readonly title: string;
  readonly did: readonly string[];
  readonly expected: readonly string[];
  readonly actual: readonly string[];
  /** Numbers and keeper log lines behind the actual result. */
  readonly details: readonly string[];
  readonly pass: boolean;
};

export type DemoResult = {
  readonly chainId: number;
  readonly contracts: Readonly<Record<string, Address>>;
  readonly rows: readonly DemoRow[];
};

/** True when the actual list is item by item the expected one. */
export function judge(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((item, index) => item === actual[index])
  );
}

/** What happened to a call: it went through, or the contract rejected it. */
type Attempt =
  | { readonly accepted: true; readonly hash: Hash }
  | { readonly accepted: false; readonly errorName: string };

/**
 * Sends a call and reports whether it went through or which contract error
 * rejected it. Any other failure (no contract error name) stops the demo.
 */
async function attempt(send: () => Promise<Hash>): Promise<Attempt> {
  try {
    return { accepted: true, hash: await send() };
  } catch (error) {
    const errorName = revertName(error);
    if (errorName === undefined) throw error;
    return { accepted: false, errorName };
  }
}

/** "rejected: <name>" or "accepted", for the actual result. */
function outcome(result: Attempt): string {
  return result.accepted ? "accepted" : `rejected: ${result.errorName}`;
}

/** Plays the six scenarios on the chain of `viem`. */
export async function runDemo(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
}): Promise<DemoResult> {
  const { viem } = input;
  const publicClient = await viem.getPublicClient();
  const chainId = await passSendGate(
    publicClient,
    GatedScript.Demo,
    input.confirmation,
  );
  const [owner, keeper, recipient, stranger] = await viem.getWalletClients();
  if (
    owner === undefined ||
    keeper === undefined ||
    recipient === undefined ||
    stranger === undefined
  ) {
    throw new ScriptError("The demo needs at least four test accounts.");
  }

  const deployment = await deployWithMocks({
    viem,
    confirmation: undefined,
    settings: {
      maxOrderUsdc: DEPLOY_DEFAULTS.maxOrderUsdc,
      maxOpenOrders: DEPLOY_DEFAULTS.maxOpenOrders,
      maxPriceAgeSeconds: DEPLOY_DEFAULTS.maxPriceAgeSeconds,
      maxSlippageBps: DEPLOY_DEFAULTS.maxSlippageBps,
      venueFeeBps: DEPLOY_DEFAULTS.venueFeeBps,
    },
    mocks: {
      mockPriceUsd: DEMO_NUMBERS.startPriceUsd,
      mockVenueEth: DEMO_NUMBERS.venueEth,
    },
  });
  const params = deployment.parameters;
  const trigger = await viem.getContractAt("LedgerTrigger", deployment.trigger);
  const usdc = await viem.getContractAt("MockUSDC", params.usdc);
  const feed = await viem.getContractAt("MockPriceFeed", params.priceFeed);
  const usdcDecimals = await trigger.read.usdcDecimals();
  const priceDecimals = await trigger.read.priceDecimals();
  const toUsdc = (text: string) => parseDecimal(text, usdcDecimals, "amount");
  const toPrice = (text: string) => parseDecimal(text, priceDecimals, "price");
  const amount = toUsdc(DEMO_NUMBERS.orderUsdc);
  const target = toPrice(DEMO_NUMBERS.targetPriceUsd);
  const eth = (wei: bigint) => `${formatDecimal(wei, 18)} ETH`;
  const as = (wallet: typeof owner) => ({ account: wallet.account });

  await mined(
    publicClient,
    await usdc.write.mint([toUsdc(DEMO_NUMBERS.ownerUsdc)], as(owner)),
  );

  const status = async (orderId: bigint) =>
    orderStatusName(await trigger.read.statusOf([orderId]));
  const setPrice = async (text: string) =>
    mined(publicClient, await feed.write.setAnswer([toPrice(text)], as(owner)));
  const approve = async (value: bigint) =>
    mined(
      publicClient,
      await usdc.write.approve([trigger.address, value], as(owner)),
    );
  const place = async () => {
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    const receipt = await mined(
      publicClient,
      await trigger.write.createOrder(
        [
          amount,
          target,
          recipient.account.address,
          keeper.account.address,
          latest.timestamp + DEMO_NUMBERS.validMinutes * 60n,
        ],
        as(owner),
      ),
    );
    const [created] = parseEventLogs({
      abi: trigger.abi,
      logs: receipt.logs,
      eventName: "OrderCreated",
    });
    if (created === undefined) throw new ScriptError("No OrderCreated event.");
    return created.args.orderId;
  };
  const fill = (orderId: bigint, by: typeof owner) =>
    attempt(() => trigger.write.fillOrder([orderId], as(by)));
  const order = `${DEMO_NUMBERS.orderUsdc} USDC at a target of ${DEMO_NUMBERS.targetPriceUsd} USD`;

  const rows: DemoRow[] = [];
  const row = (
    id: DemoScenario,
    did: readonly string[],
    actual: readonly string[],
    details: readonly string[],
  ) => {
    const { title, expected } = EXPECTED[id];
    rows.push({
      id,
      title,
      did,
      expected,
      actual,
      details,
      pass: judge(expected, actual),
    });
  };

  // S01: the price is above the target, the keeper waits; the price drops to
  // the target, the keeper's next round fills the order.
  {
    const orderId = await place();
    await approve(amount);
    const before = await status(orderId);
    const keeperBefore = await publicClient.getBalance({
      address: keeper.account.address,
    });
    const recipientBefore = await publicClient.getBalance({
      address: recipient.account.address,
    });
    const log: string[] = [];
    const round = () =>
      runOnce({
        clients: { publicClient, walletClient: keeper },
        settings: {
          contractAddress: trigger.address,
          fromBlock: deployment.triggerBlock,
          maxFeeWei: 10n ** 17n,
          maxBlockRange: 500n,
        },
        abis: loadAbis(),
        log: (entry: LogEntry) =>
          log.push(`keeper: ${formatLogLine(entry, new Date())}`),
      });
    await round();
    await setPrice(DEMO_NUMBERS.targetPriceUsd);
    const second = await round();
    const after = await status(orderId);
    const filled = second.orders.find(
      (entry) => entry.orderId === orderId && entry.action === Action.Fill,
    );
    const hash = filled?.details.find(([key]) => key === "tx")?.[1] as
      Hash | undefined;
    let gas = 0n;
    let reported = 0n;
    if (hash !== undefined) {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const [event] = parseEventLogs({
        abi: trigger.abi,
        logs: receipt.logs,
        eventName: "OrderFilled",
      });
      reported = event?.args.ethReceived ?? 0n;
    }
    const callerGain =
      (await publicClient.getBalance({ address: keeper.account.address })) -
      keeperBefore +
      gas;
    const recipientGain =
      (await publicClient.getBalance({ address: recipient.account.address })) -
      recipientBefore;
    const ethResult =
      recipientGain > 0n && recipientGain === reported && callerGain === 0n
        ? "ETH to the recipient, not to the caller"
        : `ETH: recipient +${eth(recipientGain)}, caller +${eth(callerGain)}`;
    row(
      "S01",
      [
        `placed order #${orderId} (${order}) while the price was ${DEMO_NUMBERS.startPriceUsd} USD, executor: the keeper's account`,
        "ran one keeper round, set the price to the target, ran another keeper round",
      ],
      [`${before} -> ${after}`, ethResult],
      [
        ...log,
        `recipient +${eth(recipientGain)} (OrderFilled reports ${eth(reported)}); keeper's account +${eth(callerGain)} apart from ${eth(gas)} gas`,
      ],
    );
  }

  // S03: the owner cancels.
  {
    const orderId = await place();
    const before = await status(orderId);
    const result = await attempt(() =>
      trigger.write.cancelOrder([orderId], as(owner)),
    );
    if (result.accepted) await mined(publicClient, result.hash);
    const after = await status(orderId);
    row(
      "S03",
      [`placed order #${orderId} (${order})`, "the owner cancelled it"],
      [`${before} -> ${after}`],
      [`cancelOrder ${outcome(result)}`],
    );
  }

  // S04: a stranger, neither owner nor executor, tries to fill at the target.
  {
    const orderId = await place();
    await approve(amount);
    const result = await fill(orderId, stranger);
    row(
      "S04",
      [
        `placed order #${orderId} (${order}); the price is at the target`,
        "a stranger, neither its owner nor its executor, called fillOrder",
      ],
      [`transaction ${outcome(result)}`],
      [`order afterwards: ${await status(orderId)}`],
    );
  }

  // S06: the executor tries to fill while the price is above the target.
  {
    const orderId = await place();
    await approve(amount);
    await setPrice(DEMO_NUMBERS.startPriceUsd);
    const result = await fill(orderId, keeper);
    row(
      "S06",
      [
        `placed order #${orderId} (${order}); set the price to ${DEMO_NUMBERS.startPriceUsd} USD`,
        "the executor called fillOrder",
      ],
      [
        `transaction ${outcome(result)}`,
        `order afterwards: ${await status(orderId)}`,
      ],
      [],
    );
    await setPrice(DEMO_NUMBERS.targetPriceUsd);
  }

  // S07: the executor fills the same order twice.
  {
    const orderId = await place();
    await approve(amount);
    const before = await status(orderId);
    const first = await fill(orderId, keeper);
    if (first.accepted) await mined(publicClient, first.hash);
    const afterFirst = await status(orderId);
    const second = await fill(orderId, keeper);
    row(
      "S07",
      [
        `placed order #${orderId} (${order}); the price is at the target`,
        "the executor called fillOrder twice",
      ],
      [
        first.accepted
          ? `first fill: ${before} -> ${afterFirst}`
          : `first fill ${outcome(first)}`,
        `second fill ${outcome(second)}`,
      ],
      [`order afterwards: ${await status(orderId)}`],
    );
  }

  // S15: the allowance is below the order amount; topping it up lets the
  // same order fill.
  {
    const orderId = await place();
    const short = toUsdc(DEMO_NUMBERS.shortAllowanceUsdc);
    await approve(short);
    const rejected = await fill(orderId, keeper);
    const afterRejection = await status(orderId);
    await approve(amount);
    const before = await status(orderId);
    const retry = await fill(orderId, keeper);
    if (retry.accepted) await mined(publicClient, retry.hash);
    const after = await status(orderId);
    row(
      "S15",
      [
        `placed order #${orderId} (${order}); the price is at the target`,
        `the owner's allowance is ${DEMO_NUMBERS.shortAllowanceUsdc} USDC; the executor called fillOrder`,
        `the owner set the allowance to ${DEMO_NUMBERS.orderUsdc} USDC; the executor called fillOrder again`,
      ],
      [
        `transaction ${outcome(rejected)}`,
        `order afterwards: ${afterRejection}`,
        retry.accepted
          ? `after topping up the allowance: ${before} -> ${after}`
          : `after topping up the allowance: ${outcome(retry)}`,
      ],
      [],
    );
  }

  return {
    chainId,
    contracts: {
      MockUSDC: params.usdc,
      MockPriceFeed: params.priceFeed,
      MockSwapVenue: params.swapVenue,
      LedgerTrigger: deployment.trigger,
    },
    rows,
  };
}

/** The demo's numbers as one line, for the header. */
export function describeNumbers(): string {
  return `Each order: ${DEMO_NUMBERS.orderUsdc} USDC at a target of ${DEMO_NUMBERS.targetPriceUsd} USD, valid for ${DEMO_NUMBERS.validMinutes / 60n} hours. The price starts at ${DEMO_NUMBERS.startPriceUsd} USD (feed with ${MOCK_FEED_DECIMALS} decimals). The swap venue holds ${DEMO_NUMBERS.venueEth} ETH; the owner holds ${DEMO_NUMBERS.ownerUsdc} USDC.`;
}
