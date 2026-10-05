import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeErrorResult, getAddress } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  ONE_ETH,
  Status,
  minEthOut,
  setUpFills,
  venueEthOut,
} from "./setUpFills.ts";

// Each test here watches one thing in fillOrder that only shows when some
// other part misbehaves or the setting is unusual: the status changes before
// any money moves; the decimals come from the price feed; only the ETH this
// swap brought in is sent on; and the reentrancy guard runs before any check.

const SLIPPAGE_BPS = 100n;

/** Values of ShortChangingSwapVenue's Mode, in declaration order. */
const PAY_GIVEN_AMOUNT = 0;

describe("LedgerTrigger fillOrder: an owner that cancels while being paid (S22)", () => {
  it("S22 an owner that is also the recipient calls cancelOrder on the order while receiving its ETH: the cancel is rejected with OrderNotOpen(Filled), the order is filled once, and the owner's open count and total drop once", async () => {
    const f = await setUpFills();
    const attacker = await f.viem.deployContract("CancellingRecipient", [
      f.trigger.address,
    ]);
    const amount = 100n * ONE_USDC;
    await f.mined(
      await f.usdc.write.mint([2n * amount], { account: f.stranger.account }),
    );
    await f.mined(
      await f.usdc.write.transfer([attacker.address, 2n * amount], {
        account: f.stranger.account,
      }),
    );
    await f.mined(await attacker.write.approveTrigger([2n * amount]));
    const expiry = (await f.now()) + 86_400n;
    for (let i = 0; i < 2; i += 1) {
      await f.mined(
        await attacker.write.placeOrder([
          amount,
          usd(2_000n),
          f.executor.account.address,
          expiry,
        ]),
      );
    }
    const orderId = 1n;
    const otherOrderId = 2n;
    assert.equal(
      (await f.trigger.read.getOrder([orderId])).owner,
      getAddress(attacker.address),
    );
    await f.mined(await attacker.write.setTargetOrder([orderId]));
    const ethBefore = await f.publicClient.getBalance({
      address: attacker.address,
    });

    const { event } = await f.fill(orderId);

    assert.equal(await attacker.read.cancelAttempts(), 1n);
    assert.equal(await attacker.read.cancelSucceeded(), false);
    assert.equal(
      await attacker.read.cancelError(),
      encodeErrorResult({
        abi: f.trigger.abi,
        errorName: "OrderNotOpen",
        args: [orderId, Status.Filled],
      }),
    );
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Filled);
    assert.equal(await f.trigger.read.statusOf([otherOrderId]), Status.Open);
    assert.equal(await f.trigger.read.openOrderCount([attacker.address]), 1n);
    assert.equal(
      await f.trigger.read.openOrderTotal([attacker.address]),
      amount,
    );
    const expectedEth = venueEthOut(amount, usd(2_000n));
    assert.equal(event.args.ethReceived, expectedEth);
    assert.equal(
      (await f.publicClient.getBalance({ address: attacker.address })) -
        ethBefore,
      expectedEth,
    );
  });
});

describe("LedgerTrigger fillOrder: a price feed that does not use 8 decimals", () => {
  for (const decimals of [6, 18]) {
    it(`with a feed of ${decimals} decimals, the recipient gets exactly the ETH worked out by hand, and the minimum ETH output is enforced to the wei`, async () => {
      const price = usd(2_000n, decimals);
      const f = await setUpFills({
        feedDecimals: decimals,
        initialPrice: price,
      });
      const amount = 100n * ONE_USDC;
      // 100 USDC at 2000 USD per ETH is 0.05 ETH, whatever the feed's decimals.
      const byHand = ONE_ETH / 20n;
      assert.equal(
        venueEthOut(amount, price, 0n, decimals),
        byHand,
        "the test's own formula",
      );

      const { orderId } = await f.place({
        usdcAmount: amount,
        targetPrice: price,
      });
      const recipientBefore = await f.balancesOf(f.recipient.account.address);
      const { event } = await f.fill(orderId);
      const recipientAfter = await f.balancesOf(f.recipient.account.address);
      assert.equal(event.args.ethReceived, byHand);
      assert.equal(recipientAfter.eth - recipientBefore.eth, byHand);

      const cheat = await f.viem.deployContract("ShortChangingSwapVenue", [
        f.usdc.address,
      ]);
      await f.mined(
        await f.deployer.sendTransaction({
          to: cheat.address,
          value: 10n * ONE_ETH,
        }),
      );
      const cheated = await f.deployTrigger({ swapVenue: cheat.address });
      await f.approve(f.owner, 1_000n * ONE_USDC, cheated.address);
      const target = usd(2_100n, decimals);
      const second = await f.place(
        { usdcAmount: amount, targetPrice: target },
        f.owner,
        cheated,
      );
      const m = minEthOut(amount, target, price, SLIPPAGE_BPS, decimals);

      await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m - 1n]));
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.sendFill(second.orderId, f.executor, cheated),
        cheated,
        "InsufficientEthOut",
        [m - 1n, m],
      );
      await f.mined(await cheat.write.setMode([PAY_GIVEN_AMOUNT, m]));
      const filled = await f.fill(second.orderId, f.executor, cheated);
      assert.equal(filled.event.args.ethReceived, m);
    });
  }
});

describe("LedgerTrigger fillOrder: ETH that was in the contract before the fill", () => {
  it("the recipient gets only the ETH this swap brought in, and the ETH that was already in the contract stays there", async () => {
    const f = await setUpFills();
    const leftover = 5n * ONE_ETH;
    await f.networkHelpers.setBalance(f.trigger.address, leftover);
    const { orderId, input } = await f.place();
    const recipientBefore = await f.balancesOf(f.recipient.account.address);

    const { event } = await f.fill(orderId);

    const expectedEth = venueEthOut(input.usdcAmount, input.targetPrice);
    assert.equal(event.args.ethReceived, expectedEth);
    const recipientAfter = await f.balancesOf(f.recipient.account.address);
    assert.equal(recipientAfter.eth - recipientBefore.eth, expectedEth);
    assert.equal(
      await f.publicClient.getBalance({ address: f.trigger.address }),
      leftover,
    );
  });
});

describe("LedgerTrigger fillOrder: the reentrancy guard comes first (S22)", () => {
  it("S22 a recipient that calls fillOrder with an order ID that does not exist while receiving the ETH is stopped by the reentrancy guard, not by the check that the order exists", async () => {
    const f = await setUpFills();
    const attacker = await f.viem.deployContract("ReentrantRecipient", [
      f.trigger.address,
    ]);
    const { orderId } = await f.place({
      executor: attacker.address,
      recipient: attacker.address,
    });
    const missing = 999n;
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.trigger.read.canFill([missing]),
      f.trigger,
      "OrderNotFound",
      [missing],
    );
    await f.mined(await attacker.write.setTargetOrder([missing]));

    await f.fill(orderId, f.owner);

    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Filled);
    assert.equal(await attacker.read.reentryAttempts(), 1n);
    assert.equal(await attacker.read.reentrySucceeded(), false);
    assert.equal(
      await attacker.read.reentryError(),
      encodeErrorResult({
        abi: f.trigger.abi,
        errorName: "ReentrancyGuardReentrantCall",
      }),
    );
  });
});
