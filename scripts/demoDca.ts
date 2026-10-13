// S37 and S38 of the demo: one Dca order of two periods, placed with
// place-dca-order, its period 0 starting in the block that places it.
//
// S37: the executor fills period 0; the order is then PartiallyFilled, one
// period's USDC is spent, and the ETH goes to the recipient.
//
// S38: the executor fills again in the same period, and the contract refuses;
// then the chain's clock moves forward one period (advance-time), the price is
// set again so that it is fresh, and the executor fills period 1, the last.
//
// A period lasts a day. Blocks on this chain can run a few seconds ahead of
// the wall clock, and the second fill of S38 and the move of the clock both
// count on landing in the period meant, so a period must be much longer than
// the few blocks in between.

import { advanceTime } from "./advanceTime.ts";
import type { PlayedRow } from "./demo.ts";
import type { DemoChain } from "./demoChain.ts";
import { placeDcaOrder } from "./placeDcaOrder.ts";

/** The made-up numbers of the Dca order, as people write them. */
export const DCA_NUMBERS = {
  usdcPerPeriod: "50",
  /** No period is bought above this price. */
  priceCapUsd: "2000",
  periodSeconds: 86_400n,
  periodCount: 2n,
} as const;

export async function playDca(chain: DemoChain): Promise<PlayedRow[]> {
  const { trigger, owner, keeper, recipient } = chain;
  const ownerAddress = owner.account.address;
  const perPeriod = chain.toUsdc(DCA_NUMBERS.usdcPerPeriod);
  const rows: PlayedRow[] = [];
  const fill = (orderId: bigint) =>
    chain.tryCall(() => trigger.write.fillOrder([orderId], chain.as(keeper)));

  const placed = await placeDcaOrder({
    viem: chain.viem,
    confirmation: undefined,
    settings: {
      contract: trigger.address,
      usdcPerPeriod: DCA_NUMBERS.usdcPerPeriod,
      targetPriceUsd: DCA_NUMBERS.priceCapUsd,
      periodSeconds: DCA_NUMBERS.periodSeconds,
      periodCount: DCA_NUMBERS.periodCount,
      startAt: 0n,
      activationPriceUsd: undefined,
      recipient: recipient.account.address,
      executor: keeper.account.address,
    },
  });
  const orderId = placed.orderId;

  // S37: the executor fills period 0.
  {
    const price = await chain.feedPrice();
    const before = await chain.status(orderId);
    const remainingBefore = (await trigger.read.getOrder([orderId]))
      .usdcRemaining;
    const totalBefore = await trigger.read.openOrderTotal([ownerAddress]);
    const ethBefore = await chain.ethOf(recipient);
    const tried = await fill(orderId);
    const after = await chain.status(orderId);
    const remainingDown =
      remainingBefore - (await trigger.read.getOrder([orderId])).usdcRemaining;
    const totalDown =
      totalBefore - (await trigger.read.openOrderTotal([ownerAddress]));
    const ethGain = (await chain.ethOf(recipient)) - ethBefore;
    const [event] = tried.accepted ? chain.fillsIn(tried.receipt, orderId) : [];
    rows.push({
      id: "S37",
      did: [
        `placed Dca order #${orderId} with place-dca-order: ${DCA_NUMBERS.usdcPerPeriod} USDC per period at no more than ${DCA_NUMBERS.priceCapUsd} USD, ${DCA_NUMBERS.periodCount} periods of ${DCA_NUMBERS.periodSeconds} seconds (1 day), period 0 starting in the block that places it, executor: the keeper's account`,
        `the price is ${chain.usdText(price)}; the executor called fillOrder in period 0`,
      ],
      actual: [
        `${before} -> ${after}`,
        event === undefined
          ? `OrderFilled: none, fillOrder ${chain.outcome(tried)}`
          : event.fillNumber === 1n &&
              event.fillsTotal === DCA_NUMBERS.periodCount &&
              event.usdcAmount === perPeriod
            ? `OrderFilled: fill 1 of ${DCA_NUMBERS.periodCount}, one period's USDC`
            : `OrderFilled: fill ${event.fillNumber} of ${event.fillsTotal}, ${chain.usdcText(event.usdcAmount)}`,
        remainingDown === perPeriod && totalDown === perPeriod
          ? "remaining and open total each down by one period"
          : `remaining down by ${chain.usdcText(remainingDown)}, open total down by ${chain.usdcText(totalDown)}`,
        event !== undefined && ethGain > 0n && ethGain === event.ethReceived
          ? "ETH to the recipient"
          : `ETH: recipient +${chain.ethText(ethGain)}, OrderFilled reports ${chain.ethText(event?.ethReceived ?? 0n)}`,
      ],
      details: [
        `remaining ${chain.usdcText(remainingBefore)} -> ${chain.usdcText(remainingBefore - remainingDown)}; owner's open total down by ${chain.usdcText(totalDown)}`,
        `recipient +${chain.ethText(ethGain)} (OrderFilled reports ${chain.ethText(event?.ethReceived ?? 0n)})`,
      ],
    });
  }

  // S38: the same period again, then the next period one period later.
  {
    const second = await fill(orderId);
    const afterSecond = await chain.status(orderId);
    const moved = await advanceTime({
      viem: chain.viem,
      confirmation: undefined,
      settings: { seconds: DCA_NUMBERS.periodSeconds },
    });
    const price = await chain.feedPrice();
    await chain.setPrice(price);
    const before = await chain.status(orderId);
    const third = await fill(orderId);
    const after = await chain.status(orderId);
    rows.push({
      id: "S38",
      did: [
        `went on with order #${orderId} of S37; the executor called fillOrder again in period 0`,
        `moved the chain's clock forward by ${DCA_NUMBERS.periodSeconds} seconds (one period) with advance-time, set the price again to ${chain.usdText(price)} so that it is fresh, and the executor called fillOrder in period 1`,
      ],
      actual: [
        `second fill in the same period ${chain.outcome(second)}`,
        `order afterwards: ${afterSecond}`,
        third.accepted
          ? `one period later: ${before} -> ${after}`
          : `one period later: fill rejected: ${third.errorName}`,
      ],
      details: [
        second.accepted
          ? "second fill accepted"
          : `second fill: ${second.errorName}(${second.values.map(String).join(", ")})`,
        `clock: block ${moved.before.number} at Unix ${moved.before.timestamp} -> block ${moved.after.number} at Unix ${moved.after.timestamp}`,
      ],
    });
  }

  return rows;
}
