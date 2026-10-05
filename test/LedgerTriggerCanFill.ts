import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { FillBlocker, Status, setUpFills } from "./setUpFills.ts";

const MAX_PRICE_AGE = DEFAULT_LIMITS.maxPriceAge;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;
type Reason = (typeof FillBlocker)[keyof typeof FillBlocker];

/** Asserts that canFill reports `reason`, with `fillable` false. */
async function assertBlocked(f: Fixture, orderId: bigint, reason: Reason) {
  assert.notEqual(reason, FillBlocker.None);
  assert.deepEqual(await f.canFill(orderId), { fillable: false, reason });
}

/**
 * Asserts that canFill reports `None`, with `fillable` true, and that the
 * owner's fill then goes through.
 */
async function assertFillsNow(f: Fixture, orderId: bigint) {
  assert.deepEqual(await f.canFill(orderId), {
    fillable: true,
    reason: FillBlocker.None,
  });
  await f.fill(orderId, f.owner);
  assert.equal(await f.trigger.read.statusOf([orderId]), Status.Filled);
}

describe("LedgerTrigger canFill and fillOrder: one reason at a time", () => {
  it("None: canFill reports the order fillable and the owner's fill goes through", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();

    await assertFillsNow(f, orderId);
  });

  it("NotOpen for a cancelled order: canFill reports NotOpen and fillOrder reverts with OrderNotOpen", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.trigger.write.cancelOrder([orderId], { account: f.owner.account });

    await assertBlocked(f, orderId, FillBlocker.NotOpen);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "OrderNotOpen",
      [orderId, Status.Cancelled],
    );
  });

  it("NotOpen for a filled order: canFill reports NotOpen and fillOrder reverts with OrderNotOpen", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.fill(orderId);

    await assertBlocked(f, orderId, FillBlocker.NotOpen);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "OrderNotOpen",
      [orderId, Status.Filled],
    );
  });

  it("Expired: canFill reports Expired and fillOrder reverts with OrderExpired", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.networkHelpers.time.increaseTo(input.expiry + 1n);
    await f.setPrice(usd(2_000n));

    await assertBlocked(f, orderId, FillBlocker.Expired);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "OrderExpired",
      [orderId, input.expiry],
    );
  });

  it("InvalidPrice for a zero price: canFill reports InvalidPrice and fillOrder reverts with InvalidPrice; with a valid price again, canFill reports None and the fill goes through", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.setPrice(0n);

    await assertBlocked(f, orderId, FillBlocker.InvalidPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "InvalidPrice",
      [0n],
    );

    await f.setPrice(usd(2_000n));
    await assertFillsNow(f, orderId);
  });

  it("InvalidPrice for an update time in the future: canFill reports InvalidPrice and fillOrder reverts with InvalidPrice; with a fresh update time, canFill reports None and the fill goes through", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.setUpdatedAt((await f.now()) + 3_600n);

    await assertBlocked(f, orderId, FillBlocker.InvalidPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "InvalidPrice",
      [usd(2_000n)],
    );

    await f.setPrice(usd(2_000n));
    await assertFillsNow(f, orderId);
  });

  it("StalePrice: canFill reports StalePrice and fillOrder reverts with StalePrice; with a fresh price, canFill reports None and the fill goes through", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    const updatedAt = (await f.now()) - MAX_PRICE_AGE - 1n;
    await f.setUpdatedAt(updatedAt);

    await assertBlocked(f, orderId, FillBlocker.StalePrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );

    await f.setPrice(usd(2_000n));
    await assertFillsNow(f, orderId);
  });

  it("PriceAboveTarget: canFill reports PriceAboveTarget and fillOrder reverts with PriceAboveTarget; once the price falls to the target, canFill reports None and the fill goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.setPrice(input.targetPrice + 1n);

    await assertBlocked(f, orderId, FillBlocker.PriceAboveTarget);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "PriceAboveTarget",
      [input.targetPrice + 1n, input.targetPrice],
    );

    await f.setPrice(input.targetPrice);
    await assertFillsNow(f, orderId);
  });

  it("InsufficientAllowance: canFill reports InsufficientAllowance and fillOrder reverts with InsufficientAllowance; once the owner raises the allowance, canFill reports None and the fill goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.approve(f.owner, 0n, f.trigger.address);

    await assertBlocked(f, orderId, FillBlocker.InsufficientAllowance);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "InsufficientAllowance",
      [0n, input.usdcAmount],
    );

    await f.approve(f.owner, input.usdcAmount, f.trigger.address);
    await assertFillsNow(f, orderId);
  });

  it("InsufficientBalance: canFill reports InsufficientBalance and fillOrder reverts with InsufficientBalance; once the owner has enough USDC, canFill reports None and the fill goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    const balance = (await f.balancesOf(f.owner.account.address)).usdc;
    await f.usdc.write.transfer([f.stranger.account.address, balance], {
      account: f.owner.account,
    });

    await assertBlocked(f, orderId, FillBlocker.InsufficientBalance);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "InsufficientBalance",
      [0n, input.usdcAmount],
    );

    await f.usdc.write.mint([input.usdcAmount], { account: f.owner.account });
    await assertFillsNow(f, orderId);
  });
});

describe("LedgerTrigger canFill and fillOrder: several reasons at once give the first", () => {
  it("a cancelled order that has also expired, with a zero price: NotOpen and OrderNotOpen", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.trigger.write.cancelOrder([orderId], { account: f.owner.account });
    await f.networkHelpers.time.increaseTo(input.expiry + 1n);
    await f.setPrice(0n);

    await assertBlocked(f, orderId, FillBlocker.NotOpen);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "OrderNotOpen",
      [orderId, Status.Cancelled],
    );
  });

  it("an expired order with a zero price and no allowance: Expired and OrderExpired", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.approve(f.owner, 0n, f.trigger.address);
    await f.networkHelpers.time.increaseTo(input.expiry + 1n);
    await f.setPrice(0n);

    await assertBlocked(f, orderId, FillBlocker.Expired);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "OrderExpired",
      [orderId, input.expiry],
    );
  });

  it("a negative price that is also stale: InvalidPrice", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.setPrice(-1n);
    await f.setUpdatedAt((await f.now()) - MAX_PRICE_AGE - 1n);

    await assertBlocked(f, orderId, FillBlocker.InvalidPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "InvalidPrice",
      [-1n],
    );
  });

  it("a stale price above the target, with no allowance: StalePrice", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.approve(f.owner, 0n, f.trigger.address);
    await f.setPrice(input.targetPrice * 2n);
    const updatedAt = (await f.now()) - MAX_PRICE_AGE - 1n;
    await f.setUpdatedAt(updatedAt);

    await assertBlocked(f, orderId, FillBlocker.StalePrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );
  });

  it("a price above the target, with no allowance and no balance: PriceAboveTarget", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.approve(f.owner, 0n, f.trigger.address);
    await f.usdc.write.transfer(
      [f.stranger.account.address, 1_000n * ONE_USDC],
      {
        account: f.owner.account,
      },
    );
    await f.setPrice(input.targetPrice + 1n);

    await assertBlocked(f, orderId, FillBlocker.PriceAboveTarget);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "PriceAboveTarget",
      [input.targetPrice + 1n, input.targetPrice],
    );
  });

  it("no allowance and no balance: InsufficientAllowance", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.approve(f.owner, 0n, f.trigger.address);
    await f.usdc.write.transfer(
      [f.stranger.account.address, 1_000n * ONE_USDC],
      {
        account: f.owner.account,
      },
    );

    await assertBlocked(f, orderId, FillBlocker.InsufficientAllowance);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.owner),
      f.trigger,
      "InsufficientAllowance",
      [0n, input.usdcAmount],
    );
  });
});

describe("LedgerTrigger canFill: what it does and does not look at", () => {
  it("answers anyone, even a stranger who may not fill the order", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();

    assert.deepEqual(await f.canFill(orderId, f.stranger), {
      fillable: true,
      reason: FillBlocker.None,
    });
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.stranger),
      f.trigger,
      "NotOrderOwnerOrExecutor",
      [orderId, getAddress(f.stranger.account.address)],
    );
  });

  it("does not try the swap: it reports None even with no ETH at the swap venue, and the fill then fails at the venue", async () => {
    const f = await setUpFills({ venueEth: 0n });
    const { orderId } = await f.place();

    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    await f.viem.assertions.revertWithCustomError(
      f.sendFill(orderId),
      f.venue,
      "InsufficientEthReserve",
    );
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
  });

  it("reports None in the very second of the expiry and Expired one second later", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place({
      expiry: (await f.now()) + 600n,
    });

    await f.networkHelpers.time.increaseTo(input.expiry);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    await f.networkHelpers.mine();
    await assertBlocked(f, orderId, FillBlocker.Expired);
  });

  it("reports None for a price exactly maxPriceAge old and StalePrice one second later", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    const updatedAt = await f.now();
    await f.setUpdatedAt(updatedAt);

    await f.networkHelpers.time.increaseTo(updatedAt + MAX_PRICE_AGE);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: true,
      reason: FillBlocker.None,
    });
    await f.networkHelpers.mine();
    await assertBlocked(f, orderId, FillBlocker.StalePrice);
  });
});
