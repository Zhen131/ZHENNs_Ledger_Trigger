import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  Kind,
  ONE_DAY,
  Status,
  setUpFills,
  type TierInput,
  type Wallet,
} from "./setUpFills.ts";

// openOrderCount and openOrderTotal stay right while Ladder orders are filled
// tier by tier, next to plain, dormant and time-scheduled (Dca) orders. Here
// the test works out the same two numbers on its own, from getOrder: the
// orders of each owner whose stored status is Dormant, Open or
// PartiallyFilled, and what they have left to spend, added up. It also checks
// that every Ladder order has left exactly the tiers it has not filled.

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

const UNFINISHED: readonly number[] = [
  Status.Dormant,
  Status.Open,
  Status.PartiallyFilled,
];

/**
 * Asserts, for each of `wallets`, that the contract's open count and total
 * equal the count and the `usdcRemaining` sum of the orders among `orderIds`
 * that the wallet owns and that are stored as unfinished; and, for every
 * Ladder order among them, that `usdcRemaining` is the amounts of its tiers
 * from tier `fillsDone` to the last, added up.
 */
async function assertBooksAddUp(
  f: Fixture,
  orderIds: readonly bigint[],
  wallets: readonly Wallet[],
) {
  for (const wallet of wallets) {
    const address = getAddress(wallet.account.address);
    let count = 0n;
    let total = 0n;
    for (const orderId of orderIds) {
      const order = await f.trigger.read.getOrder([orderId]);
      if (order.owner !== address || !UNFINISHED.includes(order.status)) {
        continue;
      }
      count += 1n;
      total += order.usdcRemaining;
    }
    assert.deepEqual(await f.bookOf(wallet), { count, total }, address);
  }
  for (const orderId of orderIds) {
    const order = await f.trigger.read.getOrder([orderId]);
    if (order.kind !== Kind.Ladder) continue;
    const tiers = await f.tiersOf(orderId);
    const left = tiers
      .slice(Number(order.fillsDone))
      .reduce((sum, tier) => sum + tier.usdcAmount, 0n);
    assert.equal(order.usdcRemaining, left, `order ${orderId}`);
  }
}

/** Tiers of `amounts` USDC at 2000, 1900, 1800 ... USD. */
function tiers(...amounts: bigint[]): TierInput[] {
  return amounts.map((amount, index) => ({
    price: usd(2_000n - 100n * BigInt(index)),
    usdcAmount: amount * ONE_USDC,
  }));
}

describe("LedgerTrigger open count and total with Ladder orders: they add up from the orders", () => {
  it("after plain, dormant, Dca and Ladder orders of three owners are placed, activated, filled tier by tier, cancelled and left to expire, each owner's open count and total equal the sum over their stored Dormant, Open and PartiallyFilled orders", async () => {
    const f = await setUpFills();
    const { owner, otherOwner, stranger, trigger } = f;
    const wallets = [owner, otherOwner, stranger];
    const ids: bigint[] = [];
    const add = async (placed: Promise<{ orderId: bigint }>) => {
      const { orderId } = await placed;
      ids.push(orderId);
      return orderId;
    };
    const cancel = async (orderId: bigint, from: Wallet) =>
      f.mined(
        await trigger.write.cancelOrder([orderId], { account: from.account }),
      );
    await f.mined(
      await f.usdc.write.mint([1_000n * ONE_USDC], {
        account: stranger.account,
      }),
    );
    await f.approve(stranger, 1_000n * ONE_USDC, trigger.address);
    const short = (await f.now()) + 3_600n;

    await add(f.place({ usdcAmount: 10n * ONE_USDC }));
    const ladder = await add(f.placeLadder({ tiers: tiers(11n, 12n, 13n) }));
    const dormantLadder = await add(
      f.placeLadder({
        tiers: tiers(21n, 22n),
        activationPrice: usd(2_200n),
      }),
    );
    const shortLadder = await add(
      f.placeLadder({ tiers: tiers(31n, 32n, 33n, 34n), expiry: short }),
    );
    const daily = await add(f.placeDca({ usdcPerPeriod: 30n * ONE_USDC }));
    const otherLadder = await add(
      f.placeLadder({ tiers: tiers(41n, 42n, 43n) }, otherOwner),
    );
    await add(f.placeDormant({ usdcAmount: 60n * ONE_USDC }, otherOwner));
    const strangerLadder = await add(
      f.placeLadder({ tiers: tiers(51n, 52n) }, stranger),
    );
    const strangerDormant = await add(
      f.placeDormant({ usdcAmount: 70n * ONE_USDC }, stranger),
    );
    await assertBooksAddUp(f, ids, wallets);

    await f.fill(ladder);
    await f.fill(shortLadder);
    await f.fill(otherLadder, otherOwner);
    await f.fill(daily);
    await assertBooksAddUp(f, ids, wallets);

    await f.setPrice(usd(2_200n));
    await f.activate(dormantLadder);
    await f.activate(strangerDormant, stranger);
    await assertBooksAddUp(f, ids, wallets);

    await f.setPrice(usd(1_850n));
    await f.fill(ladder);
    await f.fill(dormantLadder);
    await f.fill(dormantLadder);
    await f.fill(strangerLadder, stranger);
    await f.fill(otherLadder, otherOwner);
    assert.equal(
      (await trigger.read.getOrder([dormantLadder])).status,
      Status.Filled,
    );
    await assertBooksAddUp(f, ids, wallets);

    await f.networkHelpers.time.increaseTo(short + 1n);
    await f.setPrice(usd(1_800n));
    assert.equal(await trigger.read.statusOf([shortLadder]), Status.Expired);
    await f.fill(ladder);
    await f.fill(strangerLadder, stranger);
    await assertBooksAddUp(f, ids, wallets);

    await cancel(otherLadder, otherOwner);
    await cancel(strangerDormant, stranger);
    await assertBooksAddUp(f, ids, wallets);

    await cancel(shortLadder, owner);
    await f.networkHelpers.time.increase(ONE_DAY);
    await assertBooksAddUp(f, ids, wallets);

    assert.deepEqual(await f.bookOf(owner), {
      count: 2n,
      total: 70n * ONE_USDC,
    });
    assert.deepEqual(await f.bookOf(otherOwner), {
      count: 1n,
      total: 60n * ONE_USDC,
    });
    assert.deepEqual(await f.bookOf(stranger), { count: 0n, total: 0n });
  });
});
