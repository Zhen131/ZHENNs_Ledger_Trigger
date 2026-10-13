import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { Status, setUpFills } from "./setUpFills.ts";

// What getTiers returns for a Ladder order, whatever its status, and how it
// refuses every other order; and getSchedule refusing a Ladder order. The
// default Ladder order has three tiers: 100 USDC at 2000 USD, 150 USDC at
// 1900 USD and 200 USDC at 1800 USD, and is valid for one day.

describe("LedgerTrigger getTiers (S55)", () => {
  it("S55 returns every tier of a Ladder order, as given, to anyone, and the same after a tier has been filled", async () => {
    const f = await setUpFills();
    const tiers = [
      { price: usd(2_050n) + 3n, usdcAmount: 33n * ONE_USDC + 1n },
      { price: usd(1_990n), usdcAmount: 7n * ONE_USDC },
    ];
    const { orderId } = await f.placeLadder({ tiers });
    const read = () =>
      f.trigger.read.getTiers([orderId], { account: f.stranger.account });

    assert.deepEqual(await read(), tiers);

    await f.fill(orderId);

    assert.equal(
      (await f.trigger.read.getOrder([orderId])).status,
      Status.PartiallyFilled,
    );
    assert.deepEqual(await read(), tiers);
  });

  it("S55 rejects a plain order, a dormant Limit order and a Dca order with NotALadderOrder naming the order", async () => {
    const f = await setUpFills();
    const plain = (await f.place()).orderId;
    const dormant = (await f.placeDormant()).orderId;
    const dca = (await f.placeDca()).orderId;

    for (const orderId of [plain, dormant, dca]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.trigger.read.getTiers([orderId], { account: f.stranger.account }),
        f.trigger,
        "NotALadderOrder",
        [orderId],
      );
    }
  });

  it("S55 rejects ID 0 and an ID that no order has with OrderNotFound", async () => {
    const f = await setUpFills();
    await f.placeLadder();

    for (const orderId of [0n, 2n]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.trigger.read.getTiers([orderId]),
        f.trigger,
        "OrderNotFound",
        [orderId],
      );
    }
  });

  it("S55 still returns the tiers of a Ladder order that is filled, one that is cancelled and one that has expired", async () => {
    const f = await setUpFills();
    const { trigger, owner } = f;
    const filled = await f.placeLadder({
      tiers: [{ price: usd(2_000n), usdcAmount: 5n * ONE_USDC }],
    });
    await f.fill(filled.orderId);
    const cancelled = await f.placeLadder();
    await f.mined(
      await trigger.write.cancelOrder([cancelled.orderId], {
        account: owner.account,
      }),
    );
    const expired = await f.placeLadder({
      tiers: [
        { price: usd(1_000n), usdcAmount: 9n * ONE_USDC },
        { price: usd(900n), usdcAmount: 8n * ONE_USDC },
      ],
    });
    const { expiry } = await trigger.read.getOrder([expired.orderId]);
    await f.networkHelpers.time.increaseTo(expiry + 1n);

    assert.equal(await trigger.read.statusOf([filled.orderId]), Status.Filled);
    assert.equal(
      await trigger.read.statusOf([cancelled.orderId]),
      Status.Cancelled,
    );
    assert.equal(
      await trigger.read.statusOf([expired.orderId]),
      Status.Expired,
    );
    for (const { orderId, input, tiered } of [filled, cancelled, expired]) {
      assert.deepEqual(await trigger.read.getTiers([orderId]), input.tiers);
      assert.deepEqual(tiered.args.tiers, input.tiers);
    }
  });

  it("S55 getSchedule rejects a Ladder order with NotADcaOrder naming the order", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeLadder();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.trigger.read.getSchedule([orderId], { account: f.stranger.account }),
      f.trigger,
      "NotADcaOrder",
      [orderId],
    );
  });
});
