import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_LIMITS, usd } from "./deployLedgerTrigger.ts";
import { ActivationBlocker, Status, setUpFills } from "./setUpFills.ts";

// canActivate and activateOrder run the same checks in the same order, so
// whatever canActivate reports, activateOrder rejects with the matching error,
// and once canActivate reports None the activation goes through. The price
// feed starts at 2000 USD; the default dormant order has an activation price
// of 2200 USD.

const MAX_PRICE_AGE = DEFAULT_LIMITS.maxPriceAge;
const ONE_HOUR = 3_600n;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;
type Reason = (typeof ActivationBlocker)[keyof typeof ActivationBlocker];

/** Asserts that canActivate reports `reason`, with `activatable` false. */
async function assertBlocked(f: Fixture, orderId: bigint, reason: Reason) {
  assert.notEqual(reason, ActivationBlocker.None);
  assert.deepEqual(await f.canActivate(orderId), {
    activatable: false,
    reason,
  });
}

/**
 * Asserts that canActivate reports `None`, with `activatable` true, and that
 * the executor's activation then goes through.
 */
async function assertActivatesNow(f: Fixture, orderId: bigint) {
  assert.deepEqual(await f.canActivate(orderId), {
    activatable: true,
    reason: ActivationBlocker.None,
  });
  await f.activate(orderId);
  assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
}

describe("LedgerTrigger canActivate and activateOrder: one reason at a time", () => {
  it("None: canActivate reports the order activatable and the executor's activation goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);

    await assertActivatesNow(f, orderId);
  });

  it("NotDormant for an open order: canActivate reports NotDormant and activateOrder reverts with OrderNotDormant", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.setPrice(usd(2_200n));

    await assertBlocked(f, orderId, ActivationBlocker.NotDormant);
    await f.viem.assertions.revertWithCustomError(
      f.sendActivate(orderId),
      f.trigger,
      "OrderNotDormant",
    );
  });

  it("Expired: canActivate reports Expired and activateOrder reverts with OrderExpired", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.networkHelpers.time.increaseTo(input.expiry + 1n);
    await f.setPrice(input.activationPrice);

    await assertBlocked(f, orderId, ActivationBlocker.Expired);
    await f.viem.assertions.revertWithCustomError(
      f.sendActivate(orderId),
      f.trigger,
      "OrderExpired",
    );
  });

  it("InvalidPrice for a zero price: canActivate reports InvalidPrice and activateOrder reverts with InvalidPrice; with a valid price again, canActivate reports None and the activation goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(0n);

    await assertBlocked(f, orderId, ActivationBlocker.InvalidPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "InvalidPrice",
      [0n],
    );

    await f.setPrice(input.activationPrice);
    await assertActivatesNow(f, orderId);
  });

  it("InvalidPrice for an update time in the future: canActivate reports InvalidPrice and activateOrder reverts with InvalidPrice; with a fresh update time, canActivate reports None and the activation goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);
    await f.setUpdatedAt((await f.now()) + ONE_HOUR);

    await assertBlocked(f, orderId, ActivationBlocker.InvalidPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "InvalidPrice",
      [input.activationPrice],
    );

    await f.setPrice(input.activationPrice);
    await assertActivatesNow(f, orderId);
  });

  it("StalePrice: canActivate reports StalePrice and activateOrder reverts with StalePrice; with a fresh price, canActivate reports None and the activation goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);
    const updatedAt = (await f.now()) - MAX_PRICE_AGE - 1n;
    await f.setUpdatedAt(updatedAt);

    await assertBlocked(f, orderId, ActivationBlocker.StalePrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );

    await f.setPrice(input.activationPrice);
    await assertActivatesNow(f, orderId);
  });

  it("PriceBelowActivation: canActivate reports PriceBelowActivation and activateOrder reverts with PriceBelowActivation; once the price rises to the activation price, canActivate reports None and the activation goes through", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice - 1n);

    await assertBlocked(f, orderId, ActivationBlocker.PriceBelowActivation);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "PriceBelowActivation",
      [input.activationPrice - 1n, input.activationPrice],
    );

    await f.setPrice(input.activationPrice);
    await assertActivatesNow(f, orderId);
  });
});

describe("LedgerTrigger canActivate and activateOrder: several reasons at once give the first", () => {
  it("an open order that has also expired, with a zero price: NotDormant and OrderNotDormant", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place();
    await f.networkHelpers.time.increaseTo(input.expiry + 1n);
    await f.setPrice(0n);

    await assertBlocked(f, orderId, ActivationBlocker.NotDormant);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "OrderNotDormant",
      [orderId, Status.Open],
    );
  });

  it("an expired dormant order with a price below its activation price: Expired and OrderExpired", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.networkHelpers.time.increaseTo(input.expiry + 1n);
    await f.setPrice(input.activationPrice - 1n);

    await assertBlocked(f, orderId, ActivationBlocker.Expired);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "OrderExpired",
      [orderId, input.expiry],
    );
  });

  it("an update time in the future with a price below the activation price: InvalidPrice and InvalidPrice", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDormant();
    await f.setUpdatedAt((await f.now()) + ONE_HOUR);

    await assertBlocked(f, orderId, ActivationBlocker.InvalidPrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "InvalidPrice",
      [usd(2_000n)],
    );
  });

  it("a stale price below the activation price: StalePrice and StalePrice", async () => {
    const f = await setUpFills();
    const { orderId } = await f.placeDormant();
    const updatedAt = (await f.now()) - MAX_PRICE_AGE - 1n;
    await f.setUpdatedAt(updatedAt);

    await assertBlocked(f, orderId, ActivationBlocker.StalePrice);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendActivate(orderId),
      f.trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );
  });
});

describe("LedgerTrigger canActivate: who may ask, which IDs, and the edges", () => {
  it("gives anyone the same answer, the owner, the executor and a stranger alike", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();

    for (const [price, reason] of [
      [input.activationPrice - 1n, ActivationBlocker.PriceBelowActivation],
      [input.activationPrice, ActivationBlocker.None],
    ] as const) {
      await f.setPrice(price);
      for (const asker of [f.owner, f.executor, f.stranger, f.recipient]) {
        assert.deepEqual(await f.canActivate(orderId, asker), {
          activatable: reason === ActivationBlocker.None,
          reason,
        });
      }
    }
  });

  it("canActivate and activateOrder reject ID 0 and an ID that no order has with OrderNotFound", async () => {
    const f = await setUpFills();
    await f.placeDormant();
    await f.setPrice(usd(2_200n));

    for (const orderId of [0n, 2n]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.trigger.read.canActivate([orderId]),
        f.trigger,
        "OrderNotFound",
        [orderId],
      );
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendActivate(orderId, f.owner),
        f.trigger,
        "OrderNotFound",
        [orderId],
      );
    }
  });

  it("reports None in the very second of the expiry and Expired one second later", async () => {
    const f = await setUpFills();
    const expiry = (await f.now()) + 600n;
    const { orderId, input } = await f.placeDormant({ expiry });
    await f.setPrice(input.activationPrice);

    await f.networkHelpers.time.increaseTo(expiry);
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: true,
      reason: ActivationBlocker.None,
    });
    await f.networkHelpers.mine();
    await assertBlocked(f, orderId, ActivationBlocker.Expired);
  });

  it("reports None for a price exactly maxPriceAge old and StalePrice one second later", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.placeDormant();
    await f.setPrice(input.activationPrice);
    const updatedAt = await f.now();

    await f.networkHelpers.time.increaseTo(updatedAt + MAX_PRICE_AGE);
    assert.deepEqual(await f.canActivate(orderId), {
      activatable: true,
      reason: ActivationBlocker.None,
    });
    await f.networkHelpers.mine();
    await assertBlocked(f, orderId, ActivationBlocker.StalePrice);
  });
});
