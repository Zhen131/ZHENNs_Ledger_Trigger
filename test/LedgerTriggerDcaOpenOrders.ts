import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  Kind,
  ONE_DAY,
  Status,
  setUpFills,
  type Wallet,
} from "./setUpFills.ts";

// openOrderCount and openOrderTotal stay right while time-scheduled (Dca)
// orders are bought period by period, next to plain and dormant orders. Here
// the test works out the same two numbers on its own, from getOrder: the
// orders of each owner whose stored status is Dormant, Open or
// PartiallyFilled, and what they have left to spend, added up. It also checks
// that every Dca order has left exactly the periods it has not bought.

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

const UNFINISHED: readonly number[] = [
  Status.Dormant,
  Status.Open,
  Status.PartiallyFilled,
];

/**
 * Asserts, for each of `wallets`, that the contract's open count and total
 * equal the count and the `usdcRemaining` sum of the orders among `orderIds`
 * that the wallet owns and that are stored as unfinished; and, for every Dca
 * order among them, that `usdcRemaining` is its unbought fills times its
 * amount per period.
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
    if (order.kind !== Kind.Dca) continue;
    const { usdcPerPeriod } = await f.scheduleOf(orderId);
    assert.equal(
      order.usdcRemaining,
      (order.fillsTotal - order.fillsDone) * usdcPerPeriod,
      `order ${orderId}`,
    );
  }
}

describe("LedgerTrigger open count and total with Dca orders: they add up from the orders", () => {
  it("after plain, dormant and Dca orders of three owners are placed, activated, bought period by period, cancelled and left to expire, each owner's open count and total equal the sum over their stored Dormant, Open and PartiallyFilled orders", async () => {
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

    await add(f.place({ usdcAmount: 10n * ONE_USDC }));
    const dormantLimit = await add(
      f.placeDormant({ usdcAmount: 20n * ONE_USDC }),
    );
    const daily = await add(f.placeDca({ usdcPerPeriod: 30n * ONE_USDC }));
    const dormantDca = await add(
      f.placeDca({
        usdcPerPeriod: 15n * ONE_USDC,
        periodCount: 2n,
        activationPrice: usd(2_200n),
      }),
    );
    const hourly = await add(
      f.placeDca({
        usdcPerPeriod: 5n * ONE_USDC,
        periodLength: 3_600n,
        periodCount: 4n,
      }),
    );
    const otherDaily = await add(
      f.placeDca({ usdcPerPeriod: 40n * ONE_USDC }, otherOwner),
    );
    await add(f.place({ usdcAmount: 60n * ONE_USDC }, otherOwner));
    await add(
      f.placeDca(
        {
          usdcPerPeriod: 25n * ONE_USDC,
          periodCount: 2n,
          startAt: (await f.now()) + ONE_DAY,
        },
        stranger,
      ),
    );
    const strangerDormant = await add(
      f.placeDormant({ usdcAmount: 70n * ONE_USDC }, stranger),
    );
    await assertBooksAddUp(f, ids, wallets);

    await f.fill(daily);
    await f.fill(otherDaily, otherOwner);
    await assertBooksAddUp(f, ids, wallets);

    await f.setPrice(usd(2_200n));
    await f.activate(dormantDca);
    await f.activate(dormantLimit, owner);
    await f.activate(strangerDormant, stranger);
    await assertBooksAddUp(f, ids, wallets);

    await f.setPrice(usd(2_000n));
    await f.fill(dormantDca);
    await f.fill(hourly);
    await f.fill(dormantLimit);
    await assertBooksAddUp(f, ids, wallets);

    await f.networkHelpers.time.increase(ONE_DAY);
    await f.setPrice(usd(2_000n));
    assert.equal(await trigger.read.statusOf([hourly]), Status.Expired);
    await f.fill(daily);
    await f.fill(dormantDca);
    assert.equal(
      (await trigger.read.getOrder([dormantDca])).status,
      Status.Filled,
    );
    await assertBooksAddUp(f, ids, wallets);

    await cancel(otherDaily, otherOwner);
    await cancel(strangerDormant, stranger);
    await assertBooksAddUp(f, ids, wallets);

    await cancel(hourly, owner);
    await assertBooksAddUp(f, ids, wallets);

    assert.deepEqual(await f.bookOf(owner), {
      count: 2n,
      total: 40n * ONE_USDC,
    });
    assert.deepEqual(await f.bookOf(otherOwner), {
      count: 1n,
      total: 60n * ONE_USDC,
    });
    assert.deepEqual(await f.bookOf(stranger), {
      count: 1n,
      total: 50n * ONE_USDC,
    });
  });
});
