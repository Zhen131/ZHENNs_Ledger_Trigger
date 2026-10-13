// S27 and S29 of the demo: dormant limit orders.
//
// S27: a dormant order placed below its activation price is woken up and then
// filled by three keeper rounds: the first waits for the activation price; the
// price rises to it and the second activates the order (and leaves it, the
// price being above the target); the price falls to the target and the third
// fills it.
//
// S29: the executor calls fillOrder on a dormant order whose price is at its
// target, without activating it first; the contract refuses.

import { parseEventLogs } from "viem";

import { Action } from "../keeper/log.ts";
import { fillBlockerName, orderStatusName } from "../keeper/names.ts";
import type { PlayedRow } from "./demo.ts";
import type { DemoChain } from "./demoChain.ts";

/** The made-up numbers of both dormant orders, as people write them. */
export const DORMANT_NUMBERS = {
  orderUsdc: "100",
  targetPriceUsd: "2000",
  /** Above the target and above the price when S27 starts. */
  activationPriceUsd: "2100",
  validMinutes: 24n * 60n,
} as const;

/** The status an `OrderNotOpen` error names, as a word. */
function statusNamed(values: readonly unknown[]): string {
  const value = values[1];
  return typeof value === "number" ? orderStatusName(value) : String(value);
}

export async function playDormant(chain: DemoChain): Promise<PlayedRow[]> {
  const { trigger, owner, keeper } = chain;
  const amount = chain.toUsdc(DORMANT_NUMBERS.orderUsdc);
  const target = chain.toPrice(DORMANT_NUMBERS.targetPriceUsd);
  const activation = chain.toPrice(DORMANT_NUMBERS.activationPriceUsd);
  const order = `${DORMANT_NUMBERS.orderUsdc} USDC at a target of ${DORMANT_NUMBERS.targetPriceUsd} USD, activation price ${DORMANT_NUMBERS.activationPriceUsd} USD, valid for ${DORMANT_NUMBERS.validMinutes / 60n} hours`;
  const place = () =>
    chain.placeLimit({
      amount,
      targetPrice: target,
      activationPrice: activation,
      validSeconds: DORMANT_NUMBERS.validMinutes * 60n,
    });
  const ownerAddress = owner.account.address;
  const rows: PlayedRow[] = [];

  // S27: wait, activate, fill, each by one keeper round.
  {
    const startPrice = await chain.feedPrice();
    const countBefore = await trigger.read.openOrderCount([ownerAddress]);
    const totalBefore = await trigger.read.openOrderTotal([ownerAddress]);
    const placed = await place();
    const placedStatus = await chain.status(placed.orderId);
    const countAdded =
      (await trigger.read.openOrderCount([ownerAddress])) - countBefore;
    const totalAdded =
      (await trigger.read.openOrderTotal([ownerAddress])) - totalBefore;
    await chain.approve(amount);
    const log: string[] = [];
    await chain.keeperRound(placed.block, log);
    await chain.setPrice(activation);
    const priceBefore = await chain.feedPrice();
    const second = await chain.keeperRound(placed.block, log);
    const afterSecond = await chain.status(placed.orderId);
    await chain.setPrice(target);
    await chain.keeperRound(placed.block, log);
    const afterThird = await chain.status(placed.orderId);

    const [hash] = chain.hashesIn(second, placed.orderId, Action.Activate);
    const activated =
      hash === undefined
        ? undefined
        : parseEventLogs({
            abi: trigger.abi,
            logs: (await chain.receiptOf(hash)).logs,
            eventName: "OrderActivated",
          }).find((event) => event.args.orderId === placed.orderId)?.args;
    const counted =
      placedStatus === "Dormant" && countAdded === 1n && totalAdded === amount;
    rows.push({
      id: "S27",
      did: [
        `placed dormant order #${placed.orderId} (${order}) while the price was ${chain.usdText(startPrice)}, executor: the keeper's account; the owner's allowance covers it`,
        "ran one keeper round, set the price to the activation price, ran another keeper round, set the price to the target, ran a third keeper round",
        "each round looks for orders from the block that placed this one",
      ],
      actual: [
        counted
          ? "placed Dormant, counted in the owner's open orders"
          : `placed ${placedStatus}, open orders +${countAdded}, open total +${chain.usdcText(totalAdded)}`,
        `${placedStatus} -> ${afterSecond} -> ${afterThird}`,
        activated === undefined
          ? "OrderActivated: none in the second keeper round"
          : `OrderActivated: by ${chain.who(activated.activatedBy)}, at ${
              activated.price === priceBefore
                ? "the feed price"
                : `${chain.usdText(activated.price)}, not the feed price`
            }`,
      ],
      details: [
        `owner's open orders +${countAdded}, open total +${chain.usdcText(totalAdded)} when placed`,
        ...log,
        activated === undefined
          ? "no OrderActivated in the second round"
          : `OrderActivated price ${chain.usdText(activated.price)}; feed price before that round ${chain.usdText(priceBefore)}`,
      ],
    });
  }

  // S29: the price is at the target, but the order is still dormant.
  {
    const placed = await place();
    await chain.approve(amount);
    const price = await chain.feedPrice();
    const tried = await chain.tryCall(() =>
      trigger.write.fillOrder([placed.orderId], chain.as(keeper)),
    );
    const [fillable, reason] = await trigger.read.canFill([placed.orderId]);
    const after = await chain.status(placed.orderId);
    rows.push({
      id: "S29",
      did: [
        `placed dormant order #${placed.orderId} (${order}); the price is ${chain.usdText(price)}; the owner's allowance covers it`,
        "the executor called fillOrder without activating the order",
      ],
      actual: [
        tried.accepted
          ? "transaction accepted"
          : tried.errorName === "OrderNotOpen"
            ? `transaction rejected: OrderNotOpen, status ${statusNamed(tried.values)}`
            : `transaction rejected: ${tried.errorName}`,
        `canFill: ${fillable ? "yes" : "no"}, ${fillBlockerName(reason)}`,
        `order afterwards: ${after}`,
      ],
      details: tried.accepted
        ? []
        : [`${tried.errorName}(${tried.values.map(String).join(", ")})`],
    });
  }

  return rows;
}
