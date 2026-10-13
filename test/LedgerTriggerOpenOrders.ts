import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { Status, setUpFills, type Wallet } from "./setUpFills.ts";

// openOrderCount and openOrderTotal are kept up to date as orders move. Here
// the test works out the same two numbers on its own, from getOrder: the
// orders of each owner whose stored status is Dormant, Open or
// PartiallyFilled, and what they have left to spend, added up.

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

const UNFINISHED: readonly number[] = [
  Status.Dormant,
  Status.Open,
  Status.PartiallyFilled,
];

/**
 * Asserts, for each of `wallets`, that the contract's open count and total
 * equal the count and the `usdcRemaining` sum of the orders among `orderIds`
 * that the wallet owns and that are stored as unfinished.
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
}

describe("LedgerTrigger open count and total: they add up from the orders", () => {
  it("after orders of three owners are placed, activated, filled, cancelled and left to expire, each owner's open count and total equal the sum over their stored Dormant, Open and PartiallyFilled orders", async () => {
    const f = await setUpFills();
    const { owner, otherOwner, stranger } = f;
    const wallets = [owner, otherOwner, stranger];
    const soon = (await f.now()) + 3_600n;
    const ids: bigint[] = [];
    const add = async (placed: Promise<{ orderId: bigint }>) => {
      const { orderId } = await placed;
      ids.push(orderId);
      return orderId;
    };

    const plain = await add(f.place({ usdcAmount: 10n * ONE_USDC }));
    const dormant = await add(f.placeDormant({ usdcAmount: 20n * ONE_USDC }));
    const dormantSoon = await add(
      f.placeDormant({ usdcAmount: 30n * ONE_USDC, expiry: soon }),
    );
    const plainSoon = await add(
      f.place({ usdcAmount: 40n * ONE_USDC, expiry: soon }),
    );
    const otherDormant = await add(
      f.placeDormant({ usdcAmount: 50n * ONE_USDC }, otherOwner),
    );
    const otherPlain = await add(
      f.place({ usdcAmount: 60n * ONE_USDC }, otherOwner),
    );
    const strangerDormant = await add(
      f.placeDormant({ usdcAmount: 70n * ONE_USDC }, stranger),
    );
    await assertBooksAddUp(f, ids, wallets);

    await f.setPrice(usd(2_200n));
    await f.activate(dormant);
    await f.activate(otherDormant, otherOwner);
    await assertBooksAddUp(f, ids, wallets);

    await f.setPrice(usd(2_000n));
    await f.fill(dormant);
    await f.fill(otherPlain, otherOwner);
    await assertBooksAddUp(f, ids, wallets);

    await f.trigger.write.cancelOrder([plain], { account: owner.account });
    await f.trigger.write.cancelOrder([strangerDormant], {
      account: stranger.account,
    });
    await assertBooksAddUp(f, ids, wallets);

    await f.networkHelpers.time.increaseTo(soon + 1n);
    assert.equal(await f.trigger.read.statusOf([dormantSoon]), Status.Expired);
    assert.equal(await f.trigger.read.statusOf([plainSoon]), Status.Expired);
    await assertBooksAddUp(f, ids, wallets);

    await f.trigger.write.cancelOrder([plainSoon], { account: owner.account });
    await f.trigger.write.cancelOrder([dormantSoon], {
      account: owner.account,
    });
    await assertBooksAddUp(f, ids, wallets);

    assert.deepEqual(await f.bookOf(owner), { count: 0n, total: 0n });
    assert.deepEqual(await f.bookOf(otherOwner), {
      count: 1n,
      total: 50n * ONE_USDC,
    });
    assert.deepEqual(await f.bookOf(stranger), { count: 0n, total: 0n });
  });
});
