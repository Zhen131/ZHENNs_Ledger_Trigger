import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeErrorResult, getAddress, type Address } from "viem";

import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  ONE_ETH,
  Status,
  minEthOut,
  minEthOutParts,
  setUpFills,
  venueEthOut,
} from "./setUpFills.ts";

const SLIPPAGE_BPS = 100n;

/** Values of ShortChangingSwapVenue's Mode, in declaration order. */
const Mode = {
  PayGivenAmount: 0,
  PayLessReportMore: 1,
  TakeLessUsdc: 2,
} as const;

/**
 * The fill set-up plus a ShortChangingSwapVenue stocked with 100 ETH and a
 * second LedgerTrigger, `cheated`, that swaps at it. The owner gives
 * `cheated` an allowance of 1000 USDC.
 */
async function setUpWithShortChangingVenue() {
  const f = await setUpFills();
  const cheat = await f.viem.deployContract("ShortChangingSwapVenue", [
    f.usdc.address,
  ]);
  await f.mined(
    await f.deployer.sendTransaction({
      to: cheat.address,
      value: 100n * ONE_ETH,
    }),
  );
  const cheated = await f.deployTrigger({ swapVenue: cheat.address });
  await f.approve(f.owner, 1_000n * ONE_USDC, cheated.address);
  return { ...f, cheat, cheated };
}

/** Owner USDC and allowance, recipient ETH, and both ends of the swap. */
async function moneyAround(
  f: Awaited<ReturnType<typeof setUpFills>>,
  trigger: { readonly address: Address },
  venue: Address,
) {
  return {
    owner: await f.balancesOf(f.owner.account.address),
    ownerAllowance: await f.usdc.read.allowance([
      f.owner.account.address,
      trigger.address,
    ]),
    recipient: await f.balancesOf(f.recipient.account.address),
    trigger: await f.balancesOf(trigger.address),
    venue: await f.balancesOf(venue),
  };
}

describe("LedgerTrigger fillOrder: the swap gives too little ETH (S21)", () => {
  it("S21 a swap venue whose fee is above the allowed slippage rejects the swap itself; the order stays Open and the owner's USDC stays put", async () => {
    const f = await setUpFills();
    const feeBps = 200n;
    const highFee = await f.viem.deployContract("MockSwapVenue", [
      f.usdc.address,
      f.feed.address,
      feeBps,
    ]);
    await f.mined(
      await f.deployer.sendTransaction({
        to: highFee.address,
        value: 100n * ONE_ETH,
      }),
    );
    const trigger = await f.deployTrigger({ swapVenue: highFee.address });
    await f.approve(f.owner, 1_000n * ONE_USDC, trigger.address);
    const { orderId, input } = await f.place({}, f.owner, trigger);
    const price = await f.price();
    const before = await moneyAround(f, trigger, highFee.address);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, trigger),
      highFee,
      "InsufficientOutput",
      [
        venueEthOut(input.usdcAmount, price, feeBps),
        minEthOut(input.usdcAmount, input.targetPrice, price, SLIPPAGE_BPS),
      ],
    );

    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, trigger, highFee.address), before);
  });

  it("S21 at the target price, a fee smaller than the allowed slippage is rejected too, because the ETH bought would cost more than the target", async () => {
    const f = await setUpFills();
    const feeBps = 1n;
    const smallFee = await f.viem.deployContract("MockSwapVenue", [
      f.usdc.address,
      f.feed.address,
      feeBps,
    ]);
    await f.mined(
      await f.deployer.sendTransaction({
        to: smallFee.address,
        value: 100n * ONE_ETH,
      }),
    );
    const trigger = await f.deployTrigger({ swapVenue: smallFee.address });
    await f.approve(f.owner, 1_000n * ONE_USDC, trigger.address);
    const { orderId, input } = await f.place({}, f.owner, trigger);
    const price = await f.price();
    assert.equal(price, input.targetPrice);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, trigger),
      smallFee,
      "InsufficientOutput",
      [
        venueEthOut(input.usdcAmount, price, feeBps),
        minEthOut(input.usdcAmount, input.targetPrice, price, SLIPPAGE_BPS),
      ],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S21 at the target price with an amount that does not divide evenly: a venue that pays the minimum less one wei is rejected with InsufficientEthOut, and one that pays the minimum fills", async () => {
    const f = await setUpWithShortChangingVenue();
    const target = usd(3_000n);
    const amount = 100n * ONE_USDC;
    await f.setPrice(target);
    const { orderId } = await f.place(
      { usdcAmount: amount, targetPrice: target },
      f.owner,
      f.cheated,
    );
    const parts = minEthOutParts(amount, target, target, SLIPPAGE_BPS);
    assert.notEqual((amount * 10n ** 20n) % target, 0n);
    assert.ok(parts.notAboveTarget > parts.withinSlippage);
    const m = parts.notAboveTarget;
    const before = await moneyAround(f, f.cheated, f.cheat.address);

    await f.cheat.write.setMode([Mode.PayGivenAmount, m - 1n]);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, f.cheated),
      f.cheated,
      "InsufficientEthOut",
      [m - 1n, m],
    );
    assert.equal(await f.cheated.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, f.cheated, f.cheat.address), before);

    await f.cheat.write.setMode([Mode.PayGivenAmount, m]);
    const { event } = await f.fill(orderId, f.executor, f.cheated);
    assert.equal(event.args.ethReceived, m);
    assert.equal(await f.cheated.read.statusOf([orderId]), Status.Filled);
    const after = await moneyAround(f, f.cheated, f.cheat.address);
    assert.equal(after.recipient.eth - before.recipient.eth, m);
    assert.equal(before.owner.usdc - after.owner.usdc, amount);
  });

  it("S21 well below the target price, where the slippage bound is the larger: a venue that pays the minimum less one wei is rejected with InsufficientEthOut, and one that pays the minimum fills", async () => {
    const f = await setUpWithShortChangingVenue();
    const target = usd(2_000n);
    const price = usd(1_900n);
    const amount = 100n * ONE_USDC;
    await f.setPrice(price);
    const { orderId } = await f.place(
      { usdcAmount: amount, targetPrice: target },
      f.owner,
      f.cheated,
    );
    assert.ok(price * 10_000n < target * (10_000n - SLIPPAGE_BPS));
    const parts = minEthOutParts(amount, target, price, SLIPPAGE_BPS);
    assert.ok(parts.withinSlippage > parts.notAboveTarget);
    const m = parts.withinSlippage;
    const before = await moneyAround(f, f.cheated, f.cheat.address);

    await f.cheat.write.setMode([Mode.PayGivenAmount, m - 1n]);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, f.cheated),
      f.cheated,
      "InsufficientEthOut",
      [m - 1n, m],
    );
    assert.equal(await f.cheated.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, f.cheated, f.cheat.address), before);

    await f.cheat.write.setMode([Mode.PayGivenAmount, m]);
    const { event } = await f.fill(orderId, f.executor, f.cheated);
    assert.equal(event.args.ethReceived, m);
    assert.equal(event.args.price, price);
    const after = await moneyAround(f, f.cheated, f.cheat.address);
    assert.equal(after.recipient.eth - before.recipient.eth, m);
  });

  it("S21 a venue that pays one wei less than the minimum but reports the full minimum is rejected with InsufficientEthOut: the contract counts its own balance", async () => {
    const f = await setUpWithShortChangingVenue();
    const { orderId, input } = await f.place({}, f.owner, f.cheated);
    const m = minEthOut(
      input.usdcAmount,
      input.targetPrice,
      await f.price(),
      SLIPPAGE_BPS,
    );
    const before = await moneyAround(f, f.cheated, f.cheat.address);

    await f.cheat.write.setMode([Mode.PayLessReportMore, 0n]);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, f.cheated),
      f.cheated,
      "InsufficientEthOut",
      [m - 1n, m],
    );

    assert.equal(await f.cheated.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, f.cheated, f.cheat.address), before);
  });
});

describe("LedgerTrigger fillOrder: all the ETH from the swap goes to the recipient", () => {
  it("a venue that pays far more than the minimum: the fill goes through and the recipient gets all of it", async () => {
    const f = await setUpWithShortChangingVenue();
    const { orderId } = await f.place({}, f.owner, f.cheated);
    const generous = 3n * ONE_ETH;
    const before = await moneyAround(f, f.cheated, f.cheat.address);

    await f.cheat.write.setMode([Mode.PayGivenAmount, generous]);
    const { event } = await f.fill(orderId, f.executor, f.cheated);

    assert.equal(event.args.ethReceived, generous);
    const after = await moneyAround(f, f.cheated, f.cheat.address);
    assert.equal(after.recipient.eth - before.recipient.eth, generous);
  });
});

describe("LedgerTrigger fillOrder: the swap venue takes less USDC than the order amount", () => {
  it("rejects the fill with SwapUsdcMismatch; the order stays Open and the owner's USDC stays put", async () => {
    const f = await setUpWithShortChangingVenue();
    const { orderId } = await f.place({}, f.owner, f.cheated);
    const before = await moneyAround(f, f.cheated, f.cheat.address);
    assert.equal(before.trigger.usdc, 0n);

    await f.cheat.write.setMode([Mode.TakeLessUsdc, 0n]);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId, f.executor, f.cheated),
      f.cheated,
      "SwapUsdcMismatch",
      [0n, 1n],
    );

    assert.equal(await f.cheated.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, f.cheated, f.cheat.address), before);
  });
});

describe("LedgerTrigger fillOrder: a recipient that calls back in (S22)", () => {
  it("S22 a recipient that calls fillOrder again on the same order while receiving the ETH: the order is filled once, the recipient is paid once, and the second call hits the reentrancy guard", async () => {
    const f = await setUpFills();
    const attacker = await f.viem.deployContract("ReentrantRecipient", [
      f.trigger.address,
    ]);
    const { orderId, input } = await f.place({
      executor: attacker.address,
      recipient: attacker.address,
    });
    await f.place();
    await f.mined(await attacker.write.setTargetOrder([orderId]));
    const ownerBefore = await f.balancesOf(f.owner.account.address);
    const attackerBefore = await f.balancesOf(attacker.address);
    const bookBefore = await f.bookOf(f.owner);

    const { event } = await f.fill(orderId, f.owner);

    const expectedEth = venueEthOut(input.usdcAmount, input.targetPrice);
    assert.equal(event.args.ethReceived, expectedEth);
    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Filled);
    const attackerAfter = await f.balancesOf(attacker.address);
    assert.equal(attackerAfter.eth - attackerBefore.eth, expectedEth);
    const ownerAfter = await f.balancesOf(f.owner.account.address);
    assert.equal(ownerBefore.usdc - ownerAfter.usdc, input.usdcAmount);
    assert.deepEqual(await f.bookOf(f.owner), {
      count: bookBefore.count - 1n,
      total: bookBefore.total - input.usdcAmount,
    });
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

describe("LedgerTrigger fillOrder: a recipient that cannot take ETH (S23)", () => {
  it("S23 a recipient that refuses ETH: EthTransferFailed, the order stays Open and no USDC moves", async () => {
    const f = await setUpFills();
    const refuser = await f.viem.deployContract("EthRejectingRecipient");
    const { orderId, input } = await f.place({ recipient: refuser.address });
    const before = await moneyAround(f, f.trigger, f.venue.address);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      f.trigger,
      "EthTransferFailed",
      [
        getAddress(refuser.address),
        venueEthOut(input.usdcAmount, input.targetPrice),
      ],
    );

    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, f.trigger, f.venue.address), before);
    assert.deepEqual(await f.balancesOf(refuser.address), {
      eth: 0n,
      usdc: 0n,
    });
  });

  it("S23 an order whose recipient is the contract itself cannot be filled: the contract refuses the ETH, so EthTransferFailed, and the order stays Open", async () => {
    const f = await setUpFills();
    const { orderId, input } = await f.place({ recipient: f.trigger.address });
    const before = await moneyAround(f, f.trigger, f.venue.address);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.sendFill(orderId),
      f.trigger,
      "EthTransferFailed",
      [
        getAddress(f.trigger.address),
        venueEthOut(input.usdcAmount, input.targetPrice),
      ],
    );

    assert.equal(await f.trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await moneyAround(f, f.trigger, f.venue.address), before);
  });
});

describe("MockSwapVenue: a caller that cannot take the ETH", () => {
  it("rejects the swap with EthTransferFailed and moves nothing", async () => {
    const f = await setUpFills();
    const refuser = await f.viem.deployContract("EthRejectingRecipient");
    const amount = 100n * ONE_USDC;
    await f.mined(
      await f.usdc.write.mint([amount], { account: f.stranger.account }),
    );
    await f.mined(
      await f.usdc.write.transfer([refuser.address, amount], {
        account: f.stranger.account,
      }),
    );
    const venueBefore = await f.balancesOf(f.venue.address);

    await f.viem.assertions.revertWithCustomError(
      refuser.write.swapAt([f.venue.address, f.usdc.address, amount]),
      f.venue,
      "EthTransferFailed",
    );

    assert.deepEqual(await f.balancesOf(f.venue.address), venueBefore);
    assert.deepEqual(await f.balancesOf(refuser.address), {
      eth: 0n,
      usdc: amount,
    });
  });
});

describe("Hostile test contracts: they misbehave as described", () => {
  it("EthRejectingRecipient refuses ETH sent straight to it", async () => {
    const f = await setUpFills();
    const refuser = await f.viem.deployContract("EthRejectingRecipient");

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.stranger.sendTransaction({ to: refuser.address, value: 1n }),
      refuser,
      "EthRefused",
      [getAddress(f.stranger.account.address), 1n],
    );
  });

  it("ShortChangingSwapVenue in each mode takes and pays what its mode says, whatever it reports", async () => {
    const f = await setUpWithShortChangingVenue();
    const trader = f.otherOwner;
    const amount = 10n * ONE_USDC;
    const minimum = 1_000n;
    await f.approve(trader, 1_000n * ONE_USDC, f.cheat.address);

    const cases = [
      { mode: Mode.PayGivenAmount, ethToPay: 7n, took: amount, paid: 7n },
      {
        mode: Mode.PayLessReportMore,
        ethToPay: 0n,
        took: amount,
        paid: minimum - 1n,
      },
      {
        mode: Mode.TakeLessUsdc,
        ethToPay: 0n,
        took: amount - 1n,
        paid: minimum,
      },
    ];
    for (const { mode, ethToPay, took, paid } of cases) {
      await f.mined(await f.cheat.write.setMode([mode, ethToPay]));
      const { result: reported } = await f.cheat.simulate.swapUsdcForEth(
        [amount, minimum],
        { account: trader.account.address },
      );
      const before = await f.balancesOf(f.cheat.address);
      await f.mined(
        await f.cheat.write.swapUsdcForEth([amount, minimum], {
          account: trader.account,
        }),
      );
      const after = await f.balancesOf(f.cheat.address);
      assert.equal(after.usdc - before.usdc, took);
      assert.equal(before.eth - after.eth, paid);
      assert.equal(reported, mode === Mode.PayGivenAmount ? paid : minimum);
    }
  });
});
