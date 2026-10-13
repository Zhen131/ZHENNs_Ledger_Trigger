// S50 of the demo: a Ladder order of three tiers, placed with
// place-ladder-order, filled by the keeper's rounds. The price falls between
// the second and the third tier: one round fills tier 0, then tier 1, one
// transaction each, in order, and stops at tier 2, whose price is not reached
// yet. The price falls to tier 2, and the next round fills it.

import { Action } from "../keeper/log.ts";
import { fillBlockerName } from "../keeper/names.ts";
import type { RoundReport } from "../keeper/runOnce.ts";
import type { PlayedRow } from "./demo.ts";
import type { DemoChain } from "./demoChain.ts";
import { placeLadderOrder } from "./placeLadderOrder.ts";

/** The made-up numbers of the Ladder order, as people write them. */
export const LADDER_NUMBERS = {
  /** Tier 0 first; each tier's price below the one before. */
  tiers: [
    { priceUsd: "2000", usdc: "30" },
    { priceUsd: "1900", usdc: "40" },
    { priceUsd: "1800", usdc: "50" },
  ],
  /** Below tiers 0 and 1, above tier 2. */
  firstRoundPriceUsd: "1850",
  /** At tier 2. */
  secondRoundPriceUsd: "1800",
  validMinutes: 24n * 60n,
} as const;

export async function playLadder(chain: DemoChain): Promise<PlayedRow[]> {
  const { trigger, keeper, recipient, publicClient } = chain;
  const amounts = LADDER_NUMBERS.tiers.map((tier) => chain.toUsdc(tier.usdc));

  // The order is placed in a later block than this one; the keeper's rounds
  // look for orders from the next block on, so they find this order only.
  const fromBlock = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
  const placed = await placeLadderOrder({
    viem: chain.viem,
    confirmation: undefined,
    settings: {
      contract: trigger.address,
      tiers: LADDER_NUMBERS.tiers,
      expiryMinutes: LADDER_NUMBERS.validMinutes,
      activationPriceUsd: undefined,
      recipient: recipient.account.address,
      executor: keeper.account.address,
    },
  });
  const orderId = placed.orderId;
  const log: string[] = [];

  /** One keeper round with the price at `priceUsd`, and what it filled. */
  const round = async (priceUsd: string) => {
    await chain.setPrice(chain.toPrice(priceUsd));
    const before = await chain.status(orderId);
    const report: RoundReport = await chain.keeperRound(fromBlock, log);
    const after = await chain.status(orderId);
    const hashes = chain.hashesIn(report, orderId, Action.Fill);
    const fills = [];
    for (const hash of hashes) {
      fills.push(...chain.fillsIn(await chain.receiptOf(hash), orderId));
    }
    return { before, after, lines: hashes.length, fills };
  };
  /** True when `fills` are exactly the tiers `tiers`, in that order. */
  const filledInOrder = (
    fills: readonly { fillNumber: bigint; usdcAmount: bigint }[],
    tiers: readonly number[],
  ) =>
    fills.length === tiers.length &&
    tiers.every(
      (tier, index) =>
        fills[index]?.fillNumber === BigInt(tier + 1) &&
        fills[index]?.usdcAmount === amounts[tier],
    );

  const first = await round(LADDER_NUMBERS.firstRoundPriceUsd);
  const [, waiting] = await trigger.read.canFill([orderId]);
  const second = await round(LADDER_NUMBERS.secondRoundPriceUsd);

  const tiersText = LADDER_NUMBERS.tiers
    .map(
      (tier, index) =>
        `tier ${index} ${tier.usdc} USDC at no more than ${tier.priceUsd} USD`,
    )
    .join(", ");
  return [
    {
      id: "S50",
      did: [
        `placed Ladder order #${orderId} with place-ladder-order: ${tiersText}; valid for ${LADDER_NUMBERS.validMinutes / 60n} hours, executor: the keeper's account`,
        `set the price to ${LADDER_NUMBERS.firstRoundPriceUsd} USD and ran one keeper round; set the price to ${LADDER_NUMBERS.secondRoundPriceUsd} USD and ran another`,
        "each round looks for orders from this scenario's first block on",
      ],
      actual: [
        first.lines === 2 && filledInOrder(first.fills, [0, 1])
          ? `first keeper round: ${first.before} -> ${first.after}, tiers 0 and 1 filled in order`
          : `first keeper round: ${first.before} -> ${first.after}, fills ${first.lines}`,
        `tier 2 waits: ${fillBlockerName(waiting)}`,
        second.lines === 1 && filledInOrder(second.fills, [2])
          ? `second keeper round: ${second.before} -> ${second.after}, tier 2 filled`
          : `second keeper round: ${second.before} -> ${second.after}, fills ${second.lines}`,
      ],
      details: [
        ...log,
        ...[...first.fills, ...second.fills].map(
          (fill) =>
            `OrderFilled: fill ${fill.fillNumber} of ${fill.fillsTotal}, ${chain.usdcText(fill.usdcAmount)} at ${chain.usdText(fill.price)}, ${chain.ethText(fill.ethReceived)} to the recipient`,
        ),
      ],
    },
  ];
}
