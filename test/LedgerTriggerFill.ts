import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  ONE_ETH,
  Status,
  setUpFills,
  venueEthOut,
  type Wallet,
} from "./setUpFills.ts";

const MAX_PRICE_AGE = DEFAULT_LIMITS.maxPriceAge;

describe("LedgerTrigger fillOrder: an order is filled (S01, S02)", () => {
  it("S01 the executor fills an order at its target price: Open -> Filled, and the ETH goes to the recipient, not to the caller", async () => {
    const { trigger, owner, recipient, place, fill, balancesOf } =
      await setUpFills();
    const { orderId, input } = await place();
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    const ownerBefore = await balancesOf(owner.account.address);
    const recipientBefore = await balancesOf(recipient.account.address);

    const { event, callerEthChange } = await fill(orderId);

    const expectedEth = venueEthOut(input.usdcAmount, input.targetPrice);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Filled,
    );
    const recipientAfter = await balancesOf(recipient.account.address);
    assert.equal(recipientAfter.eth - recipientBefore.eth, expectedEth);
    assert.equal(callerEthChange, 0n);
    assert.equal(event.args.ethReceived, expectedEth);
    const ownerAfter = await balancesOf(owner.account.address);
    assert.equal(ownerBefore.usdc - ownerAfter.usdc, input.usdcAmount);
  });

  it("S02 the owner fills their own order: Open -> Filled, and the ETH goes to the recipient", async () => {
    const { trigger, owner, recipient, place, fill, balancesOf } =
      await setUpFills();
    const { orderId, input } = await place();
    const recipientBefore = await balancesOf(recipient.account.address);

    const { event, callerEthChange } = await fill(orderId, owner);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
    assert.equal(event.args.filledBy, getAddress(owner.account.address));
    const recipientAfter = await balancesOf(recipient.account.address);
    assert.equal(
      recipientAfter.eth - recipientBefore.eth,
      venueEthOut(input.usdcAmount, input.targetPrice),
    );
    assert.equal(callerEthChange, 0n);
  });

  it("S02 an owner who names themself as executor and recipient fills and receives the ETH", async () => {
    const { trigger, owner, place, fill, balancesOf } = await setUpFills();
    const { orderId, input } = await place({
      executor: owner.account.address,
      recipient: owner.account.address,
    });
    const before = await balancesOf(owner.account.address);

    const { callerEthChange } = await fill(orderId, owner);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
    assert.equal(
      callerEthChange,
      venueEthOut(input.usdcAmount, input.targetPrice),
    );
    const after = await balancesOf(owner.account.address);
    assert.equal(before.usdc - after.usdc, input.usdcAmount);
  });
});

describe("LedgerTrigger fillOrder: what a fill records (S01)", () => {
  for (const [label, by] of [
    ["the executor", "executor"],
    ["the owner", "owner"],
  ] as const) {
    it(`S01 OrderFilled names the order, its owner, ${label} as the one who filled it, the recipient, the USDC, the ETH the recipient got and the feed price`, async () => {
      const fixture = await setUpFills();
      const { trigger, owner, recipient, place, fill, setPrice, balancesOf } =
        fixture;
      const caller: Wallet = fixture[by];
      const { orderId, input } = await place();
      const feedPrice = usd(1_950n);
      await setPrice(feedPrice);
      const recipientBefore = await balancesOf(recipient.account.address);

      const { event } = await fill(orderId, caller);

      const recipientAfter = await balancesOf(recipient.account.address);
      const received = recipientAfter.eth - recipientBefore.eth;
      assert.equal(received, venueEthOut(input.usdcAmount, feedPrice));
      assert.deepEqual(event.args, {
        orderId,
        owner: getAddress(owner.account.address),
        filledBy: getAddress(caller.account.address),
        recipient: getAddress(recipient.account.address),
        usdcAmount: input.usdcAmount,
        ethReceived: received,
        price: feedPrice,
      });
    });
  }

  it("S01 a fill takes the order off the owner's open count and total", async () => {
    const { owner, otherOwner, place, fill, bookOf } = await setUpFills();
    const { orderId } = await place({ usdcAmount: 120n * ONE_USDC });
    await place({ usdcAmount: 30n * ONE_USDC });
    await place({}, otherOwner);
    assert.deepEqual(await bookOf(owner), {
      count: 2n,
      total: 150n * ONE_USDC,
    });

    await fill(orderId);

    assert.deepEqual(await bookOf(owner), { count: 1n, total: 30n * ONE_USDC });
    assert.deepEqual(await bookOf(otherOwner), {
      count: 1n,
      total: 100n * ONE_USDC,
    });
  });

  it("S01 a fill leaves no allowance from the contract to the swap venue", async () => {
    const { trigger, usdc, venue, place, fill } = await setUpFills();
    const { orderId } = await place();

    await fill(orderId);

    assert.equal(
      await usdc.read.allowance([trigger.address, venue.address]),
      0n,
    );
  });

  it("S01 the swap venue receives exactly the order amount and pays out exactly what the recipient gets", async () => {
    const { venue, recipient, place, fill, balancesOf, setPrice } =
      await setUpFills();
    const { orderId, input } = await place();
    await setPrice(usd(1_777n));
    const venueBefore = await balancesOf(venue.address);
    const recipientBefore = await balancesOf(recipient.account.address);

    await fill(orderId);

    const venueAfter = await balancesOf(venue.address);
    const recipientAfter = await balancesOf(recipient.account.address);
    assert.equal(venueAfter.usdc - venueBefore.usdc, input.usdcAmount);
    assert.equal(
      venueBefore.eth - venueAfter.eth,
      recipientAfter.eth - recipientBefore.eth,
    );
  });
});

describe("LedgerTrigger fillOrder: who may fill (S04)", () => {
  for (const [label, who] of [
    ["a stranger", "stranger"],
    ["the recipient", "recipient"],
    ["the owner of another order", "otherOwner"],
    ["the deployer", "deployer"],
  ] as const) {
    it(`S04 ${label} cannot fill the order: NotOrderOwnerOrExecutor, and it stays Open`, async () => {
      const fixture = await setUpFills();
      const { viem, trigger, place, sendFill, balancesOf, owner, recipient } =
        fixture;
      const caller: Wallet = fixture[who];
      const { orderId } = await place();
      const ownerBefore = await balancesOf(owner.account.address);
      const recipientBefore = await balancesOf(recipient.account.address);

      await viem.assertions.revertWithCustomErrorWithArgs(
        sendFill(orderId, caller),
        trigger,
        "NotOrderOwnerOrExecutor",
        [orderId, getAddress(caller.account.address)],
      );

      assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
      assert.equal(
        (await balancesOf(owner.account.address)).usdc,
        ownerBefore.usdc,
      );
      if (who !== "recipient") {
        assert.deepEqual(
          await balancesOf(recipient.account.address),
          recipientBefore,
        );
      }
    });
  }

  it("S04 the executor of one order cannot fill another order that names someone else", async () => {
    const { viem, trigger, executor, otherOwner, place, sendFill } =
      await setUpFills();
    await place();
    const { orderId } = await place(
      { executor: otherOwner.account.address },
      otherOwner,
    );

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId, executor),
      trigger,
      "NotOrderOwnerOrExecutor",
      [orderId, getAddress(executor.account.address)],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("checks the caller before the order's status: a stranger gets NotOrderOwnerOrExecutor for a cancelled order", async () => {
    const { viem, trigger, stranger, owner, place, sendFill } =
      await setUpFills();
    const { orderId } = await place();
    await trigger.write.cancelOrder([orderId], { account: owner.account });

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId, stranger),
      trigger,
      "NotOrderOwnerOrExecutor",
      [orderId, getAddress(stranger.account.address)],
    );
  });
});

describe("LedgerTrigger fillOrder: the price has not come down (S06)", () => {
  it("S06 rejects a fill while the price is above the target: PriceAboveTarget, and the order stays Open", async () => {
    const {
      viem,
      trigger,
      owner,
      recipient,
      place,
      sendFill,
      setPrice,
      balancesOf,
    } = await setUpFills();
    const { orderId, input } = await place({ targetPrice: usd(1_900n) });
    const feedPrice = usd(1_900n) + 1n;
    await setPrice(feedPrice);
    const ownerBefore = await balancesOf(owner.account.address);
    const recipientBefore = await balancesOf(recipient.account.address);

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "PriceAboveTarget",
      [feedPrice, input.targetPrice],
    );

    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await balancesOf(owner.account.address), ownerBefore);
    assert.deepEqual(
      await balancesOf(recipient.account.address),
      recipientBefore,
    );
  });

  it("S06 fills at a price equal to the target", async () => {
    const { trigger, place, fill, setPrice } = await setUpFills();
    const { orderId } = await place({ targetPrice: usd(1_900n) });
    await setPrice(usd(1_900n));

    const { event } = await fill(orderId);

    assert.equal(event.args.price, usd(1_900n));
    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
  });
});

describe("LedgerTrigger fillOrder: an order that is no longer open (S07, S08, S09)", () => {
  it("S07 a second fill of the same order is rejected with OrderNotOpen, and the recipient is paid once", async () => {
    const {
      viem,
      trigger,
      owner,
      executor,
      recipient,
      place,
      fill,
      sendFill,
      balancesOf,
    } = await setUpFills();
    const { orderId, input } = await place();
    const recipientBefore = await balancesOf(recipient.account.address);
    await fill(orderId);

    for (const caller of [executor, owner]) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        sendFill(orderId, caller),
        trigger,
        "OrderNotOpen",
        [orderId, Status.Filled],
      );
    }

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
    const recipientAfter = await balancesOf(recipient.account.address);
    assert.equal(
      recipientAfter.eth - recipientBefore.eth,
      venueEthOut(input.usdcAmount, input.targetPrice),
    );
  });

  it("S08 a cancelled order cannot be filled: OrderNotOpen", async () => {
    const { viem, trigger, owner, executor, place, sendFill } =
      await setUpFills();
    const { orderId } = await place();
    await trigger.write.cancelOrder([orderId], { account: owner.account });

    for (const caller of [executor, owner]) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        sendFill(orderId, caller),
        trigger,
        "OrderNotOpen",
        [orderId, Status.Cancelled],
      );
    }
    assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
  });

  it("S09 a filled order cannot be cancelled: OrderNotOpen", async () => {
    const { viem, trigger, owner, place, fill, bookOf } = await setUpFills();
    const { orderId } = await place();
    await fill(orderId);
    const book = await bookOf(owner);

    await viem.assertions.revertWithCustomErrorWithArgs(
      trigger.write.cancelOrder([orderId], { account: owner.account }),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Filled],
    );

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
    assert.deepEqual(await bookOf(owner), book);
  });
});

describe("LedgerTrigger fillOrder: expiry (S10, S11)", () => {
  it("S10 an expired order cannot be filled: OrderExpired, and statusOf reports Expired", async () => {
    const { viem, trigger, owner, executor, networkHelpers, place, sendFill } =
      await setUpFills();
    const { orderId, input } = await place();
    await networkHelpers.time.increaseTo(input.expiry + 1n);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);

    for (const caller of [executor, owner]) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        sendFill(orderId, caller),
        trigger,
        "OrderExpired",
        [orderId, input.expiry],
      );
    }

    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
    assert.equal((await trigger.read.getOrder([orderId])).status, Status.Open);
  });

  it("S11 fills in the very second of the expiry", async () => {
    const { trigger, networkHelpers, place, fill, setPrice, publicClient } =
      await setUpFills();
    const { orderId, input } = await place({
      expiry: BigInt(await networkHelpers.time.latest()) + 600n,
    });
    await setPrice(usd(2_000n));
    await networkHelpers.time.setNextBlockTimestamp(input.expiry);

    const { receipt } = await fill(orderId);

    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.equal(block.timestamp, input.expiry);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
  });

  it("S11 rejects a fill one second after the expiry: OrderExpired", async () => {
    const { viem, trigger, networkHelpers, place, sendFill, setPrice } =
      await setUpFills();
    const { orderId, input } = await place({
      expiry: BigInt(await networkHelpers.time.latest()) + 600n,
    });
    await setPrice(usd(2_000n));
    await networkHelpers.time.setNextBlockTimestamp(input.expiry + 1n);

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "OrderExpired",
      [orderId, input.expiry],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
  });
});

describe("LedgerTrigger fillOrder: the price feed (S13, S14)", () => {
  it("S13 rejects a price older than maxPriceAge: StalePrice, and the order stays Open", async () => {
    const { viem, trigger, place, sendFill, setUpdatedAt, now } =
      await setUpFills();
    const { orderId } = await place();
    const updatedAt = (await now()) - MAX_PRICE_AGE - 60n;
    await setUpdatedAt(updatedAt);

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S13 fills when the price is exactly maxPriceAge old", async () => {
    const { trigger, networkHelpers, place, fill, setUpdatedAt, now } =
      await setUpFills();
    const { orderId } = await place();
    const updatedAt = await now();
    await setUpdatedAt(updatedAt);
    await networkHelpers.time.setNextBlockTimestamp(updatedAt + MAX_PRICE_AGE);

    await fill(orderId);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
  });

  it("S13 rejects a price one second older than maxPriceAge: StalePrice", async () => {
    const {
      viem,
      trigger,
      networkHelpers,
      place,
      sendFill,
      setUpdatedAt,
      now,
    } = await setUpFills();
    const { orderId } = await place();
    const updatedAt = await now();
    await setUpdatedAt(updatedAt);
    await networkHelpers.time.setNextBlockTimestamp(
      updatedAt + MAX_PRICE_AGE + 1n,
    );

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "StalePrice",
      [updatedAt, MAX_PRICE_AGE],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S13 applies the deployed maxPriceAge, not a fixed 75 minutes", async () => {
    const {
      viem,
      feed,
      networkHelpers,
      deployTrigger,
      owner,
      approve,
      place,
      fill,
      sendFill,
      setPrice,
    } = await setUpFills();
    const shortAge = await deployTrigger({ maxPriceAge: 60n });
    await approve(owner, 1_000n * ONE_USDC, shortAge.address);
    const fresh = await place({}, owner, shortAge);
    const stale = await place({}, owner, shortAge);
    await setPrice(usd(2_000n));
    const [, , , updatedAt] = await feed.read.latestRoundData();

    await networkHelpers.time.setNextBlockTimestamp(updatedAt + 60n);
    await fill(fresh.orderId, owner, shortAge);
    await networkHelpers.time.setNextBlockTimestamp(updatedAt + 61n);
    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(stale.orderId, owner, shortAge),
      shortAge,
      "StalePrice",
      [updatedAt, 60n],
    );
  });

  for (const [label, feedPrice] of [
    ["zero", 0n],
    ["minus one", -1n],
    ["minus 2000 USD", -usd(2_000n)],
  ] as const) {
    it(`S14 rejects a price of ${label}: InvalidPrice, and the order stays Open`, async () => {
      const { viem, trigger, owner, place, sendFill, setPrice, balancesOf } =
        await setUpFills();
      const { orderId } = await place();
      await setPrice(feedPrice);
      const ownerBefore = await balancesOf(owner.account.address);

      await viem.assertions.revertWithCustomErrorWithArgs(
        sendFill(orderId),
        trigger,
        "InvalidPrice",
        [feedPrice],
      );
      assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
      assert.deepEqual(await balancesOf(owner.account.address), ownerBefore);
    });
  }

  it("S14 rejects a price whose update time is after the current block's time: InvalidPrice", async () => {
    const { viem, trigger, place, sendFill, setUpdatedAt, now } =
      await setUpFills();
    const { orderId } = await place();
    await setUpdatedAt((await now()) + 3_600n);

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "InvalidPrice",
      [usd(2_000n)],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("S14 fills when the price's update time is the very second of the fill block", async () => {
    const { trigger, networkHelpers, place, fill, setUpdatedAt, now } =
      await setUpFills();
    const { orderId } = await place();
    const fillTime = (await now()) + 100n;
    await setUpdatedAt(fillTime);
    await networkHelpers.time.setNextBlockTimestamp(fillTime);

    await fill(orderId);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
  });
});

describe("LedgerTrigger fillOrder: the owner's allowance and balance (S15, S16, S17, S19)", () => {
  it("S15 rejects a fill when the allowance is below the order amount: InsufficientAllowance, the order stays Open, and it fills once the allowance is raised", async () => {
    const { viem, trigger, owner, place, sendFill, fill, approve, balancesOf } =
      await setUpFills();
    const { orderId, input } = await place();
    await approve(owner, input.usdcAmount - 1n, trigger.address);
    const ownerBefore = await balancesOf(owner.account.address);

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "InsufficientAllowance",
      [input.usdcAmount - 1n, input.usdcAmount],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await balancesOf(owner.account.address), ownerBefore);

    await approve(owner, input.usdcAmount, trigger.address);
    await fill(orderId);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Filled);
  });

  it("S16 rejects a fill when the owner's balance is below the order amount: InsufficientBalance, and the order stays Open", async () => {
    const {
      viem,
      trigger,
      usdc,
      owner,
      stranger,
      place,
      sendFill,
      balancesOf,
    } = await setUpFills();
    const { orderId, input } = await place();
    const balance = (await balancesOf(owner.account.address)).usdc;
    await usdc.write.transfer(
      [stranger.account.address, balance - (input.usdcAmount - 1n)],
      { account: owner.account },
    );

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(orderId),
      trigger,
      "InsufficientBalance",
      [input.usdcAmount - 1n, input.usdcAmount],
    );
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.equal(
      (await balancesOf(owner.account.address)).usdc,
      input.usdcAmount - 1n,
    );
  });

  it("S17 takes only the order amount from a larger balance and leaves the rest of the balance and allowance alone", async () => {
    const { trigger, usdc, owner, place, fill, balancesOf } =
      await setUpFills();
    const { orderId, input } = await place({ usdcAmount: 123_456_789n });
    const before = await balancesOf(owner.account.address);
    const allowanceBefore = await usdc.read.allowance([
      owner.account.address,
      trigger.address,
    ]);
    assert.ok(before.usdc > input.usdcAmount);

    await fill(orderId);

    const after = await balancesOf(owner.account.address);
    assert.equal(after.usdc, before.usdc - input.usdcAmount);
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      allowanceBefore - input.usdcAmount,
    );
  });

  it("S19 two orders and an allowance for one: the first fills, the second gets InsufficientAllowance, and it fills once the allowance is topped up", async () => {
    const { viem, trigger, owner, place, sendFill, fill, approve } =
      await setUpFills();
    const first = await place();
    const second = await place();
    await approve(owner, first.input.usdcAmount, trigger.address);

    await fill(first.orderId);
    await viem.assertions.revertWithCustomErrorWithArgs(
      sendFill(second.orderId),
      trigger,
      "InsufficientAllowance",
      [0n, second.input.usdcAmount],
    );
    assert.equal(await trigger.read.statusOf([first.orderId]), Status.Filled);
    assert.equal(await trigger.read.statusOf([second.orderId]), Status.Open);

    await approve(owner, second.input.usdcAmount, trigger.address);
    await fill(second.orderId);
    assert.equal(await trigger.read.statusOf([second.orderId]), Status.Filled);
  });
});

describe("LedgerTrigger fillOrder and canFill: an ID with no order (S24)", () => {
  for (const [label, id] of [
    ["ID 0", 0n],
    ["an ID not used yet", 2n],
  ] as const) {
    it(`S24 canFill and fillOrder report OrderNotFound for ${label}`, async () => {
      const { viem, trigger, owner, executor, stranger, place, sendFill } =
        await setUpFills();
      await place();

      await viem.assertions.revertWithCustomErrorWithArgs(
        trigger.read.canFill([id]),
        trigger,
        "OrderNotFound",
        [id],
      );
      for (const caller of [owner, executor, stranger]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          sendFill(id, caller),
          trigger,
          "OrderNotFound",
          [id],
        );
      }
    });
  }
});

describe("LedgerTrigger: the contract keeps no money (S25)", () => {
  it("S25 the contract's USDC and ETH balances are the same before and after every fill, and USDC sent to it by mistake stays untouched", async () => {
    const {
      trigger,
      usdc,
      venue,
      owner,
      otherOwner,
      stranger,
      place,
      fill,
      setPrice,
      balancesOf,
    } = await setUpFills();
    await usdc.write.mint([7n * ONE_USDC], { account: stranger.account });
    await usdc.write.transfer([trigger.address, 7n * ONE_USDC], {
      account: stranger.account,
    });
    const orders = [
      await place({ usdcAmount: 100n * ONE_USDC }),
      await place({ usdcAmount: 1n }, otherOwner),
      await place({ usdcAmount: 333_333_333n, targetPrice: usd(2_100n) }),
      await place({ usdcAmount: 500n * ONE_USDC }, otherOwner),
    ];
    const prices = [usd(2_000n), usd(1_999n), usd(1_234n) + 56n, usd(100n)];
    const start = await balancesOf(trigger.address);
    assert.deepEqual(start, { eth: 0n, usdc: 7n * ONE_USDC });

    for (const [index, { orderId }] of orders.entries()) {
      await setPrice(prices[index] ?? 0n);
      const before = await balancesOf(trigger.address);
      await fill(orderId, index % 2 === 0 ? owner : otherOwner);
      assert.deepEqual(await balancesOf(trigger.address), before);
      assert.equal(
        await usdc.read.allowance([trigger.address, venue.address]),
        0n,
      );
    }

    assert.deepEqual(await balancesOf(trigger.address), start);
  });
});

describe("LedgerTrigger: ETH sent straight to the contract (S26)", () => {
  for (const who of [
    "stranger",
    "owner",
    "executor",
    "recipient",
    "deployer",
  ] as const) {
    it(`S26 rejects ETH sent straight to the contract by the ${who}: UnexpectedEthSender`, async () => {
      const fixture = await setUpFills();
      const { viem, trigger, balancesOf } = fixture;
      const sender: Wallet = fixture[who];

      await viem.assertions.revertWithCustomErrorWithArgs(
        sender.sendTransaction({ to: trigger.address, value: ONE_ETH }),
        trigger,
        "UnexpectedEthSender",
        [getAddress(sender.account.address)],
      );
      assert.equal((await balancesOf(trigger.address)).eth, 0n);
    });
  }

  it("S26 rejects a plain transfer with no ETH from anyone but the swap venue", async () => {
    const { viem, trigger, stranger } = await setUpFills();

    await viem.assertions.revertWithCustomErrorWithArgs(
      stranger.sendTransaction({ to: trigger.address, value: 0n }),
      trigger,
      "UnexpectedEthSender",
      [getAddress(stranger.account.address)],
    );
  });
});

describe("LedgerTrigger fillOrder: one OrderFilled per fill", () => {
  it("emits exactly one OrderFilled and no OrderCreated or OrderCancelled", async () => {
    const { trigger, place, fill } = await setUpFills();
    const { orderId } = await place();

    const { receipt } = await fill(orderId);

    for (const eventName of ["OrderCreated", "OrderCancelled"] as const) {
      assert.equal(
        parseEventLogs({ abi: trigger.abi, logs: receipt.logs, eventName })
          .length,
        0,
      );
    }
  });
});
