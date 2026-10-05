import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs, zeroAddress, type Address } from "viem";

import { ONE_USDC, deployLedgerTrigger, usd } from "./deployLedgerTrigger.ts";

const MAX_UINT256 = 2n ** 256n - 1n;
const ONE_HOUR = 3_600n;
const ONE_DAY = 86_400n;

/** Values of the contract's OrderStatus, in declaration order. */
const Status = {
  None: 0,
  Open: 1,
  Filled: 2,
  Cancelled: 3,
  Expired: 4,
} as const;

/** The five inputs of createOrder. */
type OrderInput = {
  readonly usdcAmount: bigint;
  readonly targetPrice: bigint;
  readonly recipient: Address;
  readonly executor: Address;
  readonly expiry: bigint;
};

type Fixture = Awaited<ReturnType<typeof deployLedgerTrigger>>;
type Wallet = Fixture["owner"];

/**
 * Deploys the full set on a new chain, gives `owner` and `otherOwner` 1000
 * USDC each with a matching allowance to the contract, and adds the order
 * helpers below. Times are set by the tests themselves.
 */
async function setUp(options: Parameters<typeof deployLedgerTrigger>[0] = {}) {
  const fixture = await deployLedgerTrigger(options);
  const {
    networkHelpers,
    publicClient,
    trigger,
    usdc,
    owner,
    otherOwner,
    executor,
    recipient,
    mined,
  } = fixture;

  for (const wallet of [owner, otherOwner]) {
    await mined(
      await usdc.write.mint([1_000n * ONE_USDC], { account: wallet.account }),
    );
    await mined(
      await usdc.write.approve([trigger.address, 1_000n * ONE_USDC], {
        account: wallet.account,
      }),
    );
  }

  async function now(): Promise<bigint> {
    return BigInt(await networkHelpers.time.latest());
  }

  /** 100 USDC at a target of 1900 USD, valid for one day. */
  async function defaultInput(): Promise<OrderInput> {
    return {
      usdcAmount: 100n * ONE_USDC,
      targetPrice: usd(1_900n),
      recipient: recipient.account.address,
      executor: executor.account.address,
      expiry: (await now()) + ONE_DAY,
    };
  }

  /** Sends createOrder; returns the transaction hash promise. */
  function sendCreate(input: OrderInput, from: Wallet = owner) {
    return trigger.write.createOrder(
      [
        input.usdcAmount,
        input.targetPrice,
        input.recipient,
        input.executor,
        input.expiry,
      ],
      { account: from.account },
    );
  }

  /**
   * Places an order with the default input changed by `changes`, as `from`.
   * Returns the new order's ID (read from its only OrderCreated event), the
   * input used and the receipt.
   */
  async function place(changes: Partial<OrderInput> = {}, from = owner) {
    const input = { ...(await defaultInput()), ...changes };
    const receipt = await mined(await sendCreate(input, from));
    const events = parseEventLogs({
      abi: trigger.abi,
      logs: receipt.logs,
      eventName: "OrderCreated",
    });
    assert.equal(events.length, 1);
    const event = events[0];
    if (event === undefined) throw new Error("no OrderCreated event");
    return { orderId: event.args.orderId, input, receipt, event };
  }

  /** Sends cancelOrder as `from`; returns the transaction hash promise. */
  function sendCancel(orderId: bigint, from: Wallet = owner) {
    return trigger.write.cancelOrder([orderId], { account: from.account });
  }

  /**
   * Cancels an order as `from`. Returns the receipt and its only
   * OrderCancelled event.
   */
  async function cancel(orderId: bigint, from: Wallet = owner) {
    const receipt = await mined(await sendCancel(orderId, from));
    const events = parseEventLogs({
      abi: trigger.abi,
      logs: receipt.logs,
      eventName: "OrderCancelled",
    });
    assert.equal(events.length, 1);
    const event = events[0];
    if (event === undefined) throw new Error("no OrderCancelled event");
    return { receipt, event };
  }

  /** The two per-owner numbers the contract keeps. */
  async function bookOf(wallet: Wallet) {
    const address = wallet.account.address;
    return {
      count: await trigger.read.openOrderCount([address]),
      total: await trigger.read.openOrderTotal([address]),
    };
  }

  /** Every balance and allowance that placing or cancelling must not move. */
  async function money() {
    const balances: Record<string, bigint> = {};
    for (const [name, wallet] of [
      ["owner", owner],
      ["otherOwner", otherOwner],
      ["executor", executor],
      ["recipient", recipient],
    ] as const) {
      const address = wallet.account.address;
      balances[`${name} USDC`] = await usdc.read.balanceOf([address]);
      balances[`${name} allowance`] = await usdc.read.allowance([
        address,
        trigger.address,
      ]);
    }
    balances["executor ETH"] = await publicClient.getBalance({
      address: executor.account.address,
    });
    balances["recipient ETH"] = await publicClient.getBalance({
      address: recipient.account.address,
    });
    balances["contract USDC"] = await usdc.read.balanceOf([trigger.address]);
    balances["contract ETH"] = await publicClient.getBalance({
      address: trigger.address,
    });
    return balances;
  }

  return {
    ...fixture,
    now,
    defaultInput,
    sendCreate,
    place,
    sendCancel,
    cancel,
    bookOf,
    money,
  };
}

describe("LedgerTrigger createOrder: placing an order moves no money", () => {
  it("leaves the owner's USDC and allowance and the contract's USDC and ETH unchanged", async () => {
    const { place, money } = await setUp();
    const before = await money();
    assert.ok((before["owner USDC"] ?? 0n) > 0n);
    assert.ok((before["owner allowance"] ?? 0n) > 0n);

    await place();
    await place({ usdcAmount: 500n * ONE_USDC });

    assert.deepEqual(await money(), before);
  });

  it("emits OrderCreated and nothing else, so no token moves or is approved", async () => {
    const { trigger, place } = await setUp();

    const { receipt } = await place();

    assert.equal(receipt.logs.length, 1);
    assert.equal(
      getAddress(receipt.logs[0]?.address ?? zeroAddress),
      getAddress(trigger.address),
    );
  });

  it("numbers orders 1, 2, 3 and on, across owners", async () => {
    const { place, otherOwner } = await setUp();

    const ids = [
      (await place()).orderId,
      (await place({}, otherOwner)).orderId,
      (await place()).orderId,
      (await place({}, otherOwner)).orderId,
    ];

    assert.deepEqual(ids, [1n, 2n, 3n, 4n]);
  });

  it("emits OrderCreated with every field equal to the input", async () => {
    const { owner, stranger, otherOwner, place } = await setUp();
    const input: OrderInput = {
      usdcAmount: 123n * ONE_USDC + 456_789n,
      targetPrice: usd(1_850n) + 12_345_678n,
      recipient: stranger.account.address,
      executor: otherOwner.account.address,
      expiry: 4_000_000_000n,
    };

    const { event } = await place(input);

    assert.deepEqual(event.args, {
      orderId: 1n,
      owner: getAddress(owner.account.address),
      executor: getAddress(input.executor),
      recipient: getAddress(input.recipient),
      usdcAmount: input.usdcAmount,
      targetPrice: input.targetPrice,
      expiry: input.expiry,
    });
  });

  it("stores every field; createdAt is the time of the block that placed it", async () => {
    const { publicClient, trigger, owner, place } = await setUp();

    const { orderId, input, receipt } = await place({
      usdcAmount: 77n * ONE_USDC,
    });

    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.deepEqual(await trigger.read.getOrder([orderId]), {
      owner: getAddress(owner.account.address),
      executor: getAddress(input.executor),
      recipient: getAddress(input.recipient),
      usdcAmount: 77n * ONE_USDC,
      targetPrice: input.targetPrice,
      createdAt: block.timestamp,
      expiry: input.expiry,
      status: Status.Open,
    });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
  });

  it("adds one to the owner's open count and the order's amount to the open total", async () => {
    const { owner, otherOwner, place, bookOf } = await setUp();
    assert.deepEqual(await bookOf(owner), { count: 0n, total: 0n });

    await place({ usdcAmount: 100n * ONE_USDC });
    assert.deepEqual(await bookOf(owner), {
      count: 1n,
      total: 100n * ONE_USDC,
    });

    await place({ usdcAmount: 250_000_001n });
    assert.deepEqual(await bookOf(owner), {
      count: 2n,
      total: 100n * ONE_USDC + 250_000_001n,
    });
    assert.deepEqual(await bookOf(otherOwner), { count: 0n, total: 0n });
  });

  it("does not need any USDC balance or allowance to place an order", async () => {
    const { usdc, trigger, stranger, place, bookOf } = await setUp();
    assert.equal(await usdc.read.balanceOf([stranger.account.address]), 0n);
    assert.equal(
      await usdc.read.allowance([stranger.account.address, trigger.address]),
      0n,
    );

    await place({}, stranger);

    assert.deepEqual(await bookOf(stranger), {
      count: 1n,
      total: 100n * ONE_USDC,
    });
  });

  it("rejects ETH sent straight to the contract", async () => {
    const { publicClient, trigger, stranger } = await setUp();

    await assert.rejects(
      stranger.sendTransaction({ to: trigger.address, value: 1n }),
    );

    assert.equal(
      await publicClient.getBalance({ address: trigger.address }),
      0n,
    );
  });
});

describe("LedgerTrigger createOrder: who may be named", () => {
  it("accepts the owner as the order's own executor", async () => {
    const { trigger, owner, place } = await setUp();

    const { orderId } = await place({ executor: owner.account.address });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.executor, getAddress(owner.account.address));
    assert.equal(order.owner, getAddress(owner.account.address));
    assert.equal(order.status, Status.Open);
  });

  it("accepts the owner as the order's own recipient", async () => {
    const { trigger, owner, place } = await setUp();

    const { orderId } = await place({ recipient: owner.account.address });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.recipient, getAddress(owner.account.address));
  });

  it("indexes orderId, owner and executor in OrderCreated, so one executor's orders can be looked up", async () => {
    const { publicClient, trigger, owner, otherOwner, executor, place } =
      await setUp();
    const created = trigger.abi.find(
      (entry) => entry.type === "event" && entry.name === "OrderCreated",
    );
    assert.ok(created !== undefined && created.type === "event");
    assert.deepEqual(
      created.inputs
        .filter((input) => input.indexed)
        .map((input) => input.name),
      ["orderId", "owner", "executor"],
    );

    await place();
    await place({ executor: owner.account.address });
    await place({}, otherOwner);
    await place({ executor: otherOwner.account.address }, otherOwner);

    const forExecutor = await publicClient.getContractEvents({
      address: trigger.address,
      abi: trigger.abi,
      eventName: "OrderCreated",
      args: { executor: executor.account.address },
      fromBlock: 0n,
    });
    assert.deepEqual(
      forExecutor.map((log) => log.args.orderId),
      [1n, 3n],
    );
    const forOwner = await publicClient.getContractEvents({
      address: trigger.address,
      abi: trigger.abi,
      eventName: "OrderCreated",
      args: { owner: otherOwner.account.address },
      fromBlock: 0n,
    });
    assert.deepEqual(
      forOwner.map((log) => log.args.orderId),
      [3n, 4n],
    );
  });
});

describe("LedgerTrigger createOrder: rejected input (S20)", () => {
  /**
   * Checks that nothing was stored by a rejected createOrder: the owner's
   * count and total are unchanged, ID 1 is still unused, and the next valid
   * order gets ID 1.
   */
  async function assertNothingStored(
    fixture: Awaited<ReturnType<typeof setUp>>,
  ) {
    const { viem, trigger, owner, bookOf, place } = fixture;
    assert.deepEqual(await bookOf(owner), { count: 0n, total: 0n });
    await viem.assertions.revertWithCustomErrorWithArgs(
      trigger.read.getOrder([1n]),
      trigger,
      "OrderNotFound",
      [1n],
    );
    assert.equal((await place()).orderId, 1n);
  }

  it("S20 rejects a zero amount", async () => {
    const fixture = await setUp();
    const { viem, trigger, defaultInput, sendCreate } = fixture;
    const input = { ...(await defaultInput()), usdcAmount: 0n };

    await viem.assertions.revertWithCustomError(
      sendCreate(input),
      trigger,
      "ZeroAmount",
    );

    await assertNothingStored(fixture);
  });

  it("S20 rejects an amount above the single-order limit", async () => {
    const fixture = await setUp();
    const { viem, trigger, parameters, defaultInput, sendCreate } = fixture;
    const tooMuch = parameters.maxOrderAmount + 1n;
    const input = { ...(await defaultInput()), usdcAmount: tooMuch };

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCreate(input),
      trigger,
      "AmountAboveMax",
      [tooMuch, parameters.maxOrderAmount],
    );

    await assertNothingStored(fixture);
  });

  it("S20 rejects a zero target price", async () => {
    const fixture = await setUp();
    const { viem, trigger, defaultInput, sendCreate } = fixture;
    const input = { ...(await defaultInput()), targetPrice: 0n };

    await viem.assertions.revertWithCustomError(
      sendCreate(input),
      trigger,
      "ZeroTargetPrice",
    );

    await assertNothingStored(fixture);
  });

  it("S20 rejects the zero address as recipient", async () => {
    const fixture = await setUp();
    const { viem, trigger, defaultInput, sendCreate } = fixture;
    const input = { ...(await defaultInput()), recipient: zeroAddress };

    await viem.assertions.revertWithCustomError(
      sendCreate(input),
      trigger,
      "ZeroRecipient",
    );

    await assertNothingStored(fixture);
  });

  it("S20 rejects the zero address as executor", async () => {
    const fixture = await setUp();
    const { viem, trigger, defaultInput, sendCreate } = fixture;
    const input = { ...(await defaultInput()), executor: zeroAddress };

    await viem.assertions.revertWithCustomError(
      sendCreate(input),
      trigger,
      "ZeroExecutor",
    );

    await assertNothingStored(fixture);
  });

  it("S20 rejects an expiry in the past", async () => {
    const fixture = await setUp();
    const { viem, networkHelpers, trigger, now, defaultInput, sendCreate } =
      fixture;
    const blockTime = (await now()) + 100n;
    await networkHelpers.time.setNextBlockTimestamp(blockTime);
    const expiry = blockTime - ONE_HOUR;
    const input = { ...(await defaultInput()), expiry };

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCreate(input),
      trigger,
      "ExpiryNotInFuture",
      [expiry, blockTime],
    );

    await assertNothingStored(fixture);
  });

  it("accepts an amount exactly at the single-order limit", async () => {
    const { trigger, parameters, place } = await setUp();

    const { orderId } = await place({ usdcAmount: parameters.maxOrderAmount });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.usdcAmount, 500n * ONE_USDC);
  });

  it("rejects an expiry equal to the time of the block that would place it", async () => {
    const fixture = await setUp();
    const { viem, networkHelpers, trigger, now, defaultInput, sendCreate } =
      fixture;
    const blockTime = (await now()) + 100n;
    await networkHelpers.time.setNextBlockTimestamp(blockTime);
    const input = { ...(await defaultInput()), expiry: blockTime };

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCreate(input),
      trigger,
      "ExpiryNotInFuture",
      [blockTime, blockTime],
    );

    await assertNothingStored(fixture);
  });

  it("accepts an expiry one second after the time of the block that places it", async () => {
    const { networkHelpers, trigger, now, place } = await setUp();
    const blockTime = (await now()) + 100n;
    await networkHelpers.time.setNextBlockTimestamp(blockTime);

    const { orderId } = await place({ expiry: blockTime + 1n });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.createdAt, blockTime);
    assert.equal(order.expiry, blockTime + 1n);
  });
});

describe("LedgerTrigger createOrder: open-order limit per owner (S18)", () => {
  it("S18 rejects a sixth open order from the same owner", async () => {
    const { viem, trigger, owner, defaultInput, sendCreate, place, bookOf } =
      await setUp();
    for (let i = 0; i < 5; i += 1) await place();
    const full = await bookOf(owner);
    assert.deepEqual(full, { count: 5n, total: 500n * ONE_USDC });

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCreate(await defaultInput()),
      trigger,
      "TooManyOpenOrders",
      [getAddress(owner.account.address), 5n],
    );

    assert.deepEqual(await bookOf(owner), full);
    await viem.assertions.revertWithCustomErrorWithArgs(
      trigger.read.getOrder([6n]),
      trigger,
      "OrderNotFound",
      [6n],
    );
  });

  it("S18 accepts a new order once the owner cancels one of five", async () => {
    const { viem, trigger, owner, defaultInput, sendCreate, place, cancel } =
      await setUp();
    for (let i = 0; i < 5; i += 1) await place();
    await viem.assertions.revertWithCustomError(
      sendCreate(await defaultInput()),
      trigger,
      "TooManyOpenOrders",
    );

    await cancel(3n);
    const { orderId } = await place();

    assert.equal(orderId, 6n);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.equal(
      await trigger.read.openOrderCount([owner.account.address]),
      5n,
    );
  });

  it("S18 lets another owner place orders while one owner is at the limit", async () => {
    const { owner, otherOwner, place, bookOf } = await setUp();
    for (let i = 0; i < 5; i += 1) await place();

    const { orderId } = await place({}, otherOwner);

    assert.equal(orderId, 6n);
    assert.deepEqual(await bookOf(otherOwner), {
      count: 1n,
      total: 100n * ONE_USDC,
    });
    assert.deepEqual(await bookOf(owner), {
      count: 5n,
      total: 500n * ONE_USDC,
    });
  });

  it("S18 applies the deployed limit, not a fixed five", async () => {
    const { viem, trigger, owner, defaultInput, sendCreate, place } =
      await setUp({ parameters: { maxOpenOrdersPerOwner: 2n } });
    await place();
    await place();

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCreate(await defaultInput()),
      trigger,
      "TooManyOpenOrders",
      [getAddress(owner.account.address), 2n],
    );
  });
});

describe("LedgerTrigger queries: an ID with no order (S24)", () => {
  for (const [label, orderId] of [
    ["ID 0", 0n],
    ["the next ID not used yet", 2n],
    ["the largest uint256", MAX_UINT256],
  ] as const) {
    it(`S24 getOrder, statusOf and cancelOrder report OrderNotFound for ${label}`, async () => {
      const { viem, trigger, owner, stranger, place, sendCancel, bookOf } =
        await setUp();
      await place();
      const book = await bookOf(owner);

      await viem.assertions.revertWithCustomErrorWithArgs(
        trigger.read.getOrder([orderId]),
        trigger,
        "OrderNotFound",
        [orderId],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        trigger.read.statusOf([orderId]),
        trigger,
        "OrderNotFound",
        [orderId],
      );
      // Checked before the caller: the owner of order 1 and a stranger get
      // the same error.
      for (const caller of [owner, stranger]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          sendCancel(orderId, caller),
          trigger,
          "OrderNotFound",
          [orderId],
        );
      }
      assert.deepEqual(await bookOf(owner), book);
      assert.equal(await trigger.read.statusOf([1n]), Status.Open);
    });
  }

  it("reports zero open orders and a zero total for an address with no orders", async () => {
    const { stranger, bookOf } = await setUp();

    assert.deepEqual(await bookOf(stranger), { count: 0n, total: 0n });
  });
});

describe("LedgerTrigger cancelOrder: the owner cancels (S03)", () => {
  it("S03 owner cancels an open order: Open -> Cancelled", async () => {
    const { trigger, owner, place, cancel, bookOf } = await setUp();
    const { orderId, input } = await place({ usdcAmount: 60n * ONE_USDC });
    await place({ usdcAmount: 40n * ONE_USDC });
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);

    await cancel(orderId);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Cancelled);
    assert.equal(order.owner, getAddress(owner.account.address));
    assert.equal(order.executor, getAddress(input.executor));
    assert.equal(order.recipient, getAddress(input.recipient));
    assert.equal(order.usdcAmount, 60n * ONE_USDC);
    assert.equal(order.targetPrice, input.targetPrice);
    assert.equal(order.expiry, input.expiry);
    assert.deepEqual(await bookOf(owner), { count: 1n, total: 40n * ONE_USDC });
  });

  it("S03 emits OrderCancelled with the order, its owner and not-after-expiry, and nothing else", async () => {
    const { trigger, owner, place, cancel } = await setUp();
    const { orderId } = await place();

    const { receipt, event } = await cancel(orderId);

    assert.deepEqual(event.args, {
      orderId,
      owner: getAddress(owner.account.address),
      afterExpiry: false,
    });
    assert.equal(receipt.logs.length, 1);
    assert.equal(
      getAddress(receipt.logs[0]?.address ?? zeroAddress),
      getAddress(trigger.address),
    );
  });

  it("S03 cancelling moves no money", async () => {
    const { place, cancel, money } = await setUp();
    const { orderId } = await place();
    const before = await money();

    await cancel(orderId);

    assert.deepEqual(await money(), before);
  });

  for (const [label, badPrice] of [
    ["zero", 0n],
    ["a negative price", -1n],
  ] as const) {
    it(`S03 owner cancels while the price feed reports ${label} and its last update is long past`, async () => {
      const { trigger, feed, mined, place, cancel, bookOf, owner } =
        await setUp();
      const { orderId } = await place();
      await mined(await feed.write.setAnswer([badPrice]));
      await mined(await feed.write.setUpdatedAt([1n]));

      await cancel(orderId);

      assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
      assert.deepEqual(await bookOf(owner), { count: 0n, total: 0n });
    });
  }
});

describe("LedgerTrigger cancelOrder: only the owner (S05)", () => {
  for (const [label, role] of [
    ["a stranger", "stranger"],
    ["the order's executor", "executor"],
    ["the order's recipient", "recipient"],
    ["another owner with orders of their own", "otherOwner"],
  ] as const) {
    it(`S05 ${label} cannot cancel the order`, async () => {
      const fixture = await setUp();
      const {
        viem,
        trigger,
        owner,
        otherOwner,
        place,
        sendCancel,
        bookOf,
        money,
      } = fixture;
      const caller = fixture[role];
      await place();
      await place({}, otherOwner);
      const before = await money();
      const ownerBook = await bookOf(owner);
      const otherBook = await bookOf(otherOwner);

      await viem.assertions.revertWithCustomErrorWithArgs(
        sendCancel(1n, caller),
        trigger,
        "NotOrderOwner",
        [1n, getAddress(caller.account.address)],
      );

      assert.equal(await trigger.read.statusOf([1n]), Status.Open);
      assert.equal((await trigger.read.getOrder([1n])).status, Status.Open);
      assert.deepEqual(await bookOf(owner), ownerBook);
      assert.deepEqual(await bookOf(otherOwner), otherBook);
      assert.deepEqual(await money(), before);
    });
  }

  it("S05 the executor cannot cancel an expired order either", async () => {
    const { viem, networkHelpers, trigger, executor, place, sendCancel } =
      await setUp();
    const { input } = await place();
    await networkHelpers.time.increaseTo(input.expiry + 1n);

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCancel(1n, executor),
      trigger,
      "NotOrderOwner",
      [1n, getAddress(executor.account.address)],
    );

    assert.equal(await trigger.read.statusOf([1n]), Status.Expired);
  });
});

describe("LedgerTrigger cancelOrder: a cancelled order is final", () => {
  it("rejects cancelling the same order twice, and counts it off only once", async () => {
    const { viem, trigger, owner, place, cancel, sendCancel, bookOf } =
      await setUp();
    const { orderId } = await place({ usdcAmount: 30n * ONE_USDC });
    await place({ usdcAmount: 20n * ONE_USDC });
    await cancel(orderId);
    const afterFirst = await bookOf(owner);
    assert.deepEqual(afterFirst, { count: 1n, total: 20n * ONE_USDC });

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCancel(orderId),
      trigger,
      "OrderNotOpen",
      [orderId, Status.Cancelled],
    );

    assert.deepEqual(await bookOf(owner), afterFirst);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
  });

  it("reports a cancelled order as Cancelled, not Expired, after its expiry", async () => {
    const { networkHelpers, trigger, place, cancel } = await setUp();
    const { orderId, input } = await place();
    await cancel(orderId);

    await networkHelpers.time.increaseTo(input.expiry + ONE_DAY);

    assert.equal(await trigger.read.statusOf([orderId]), Status.Cancelled);
    assert.equal(
      (await trigger.read.getOrder([orderId])).status,
      Status.Cancelled,
    );
  });
});

describe("LedgerTrigger statusOf: expiry is worked out, not stored", () => {
  it("reports Open at the expiry second and Expired one second later, while getOrder keeps Open", async () => {
    const { networkHelpers, trigger, place, now } = await setUp();
    const { orderId, input } = await place();

    await networkHelpers.time.increaseTo(input.expiry);
    assert.equal(await now(), input.expiry);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.equal((await trigger.read.getOrder([orderId])).status, Status.Open);

    await networkHelpers.time.increaseTo(input.expiry + 1n);
    assert.equal(await now(), input.expiry + 1n);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Expired);
    assert.equal((await trigger.read.getOrder([orderId])).status, Status.Open);
  });

  it("keeps an expired order in the owner's open count and total", async () => {
    const { networkHelpers, owner, place, bookOf } = await setUp();
    const { input } = await place({ usdcAmount: 70n * ONE_USDC });

    await networkHelpers.time.increaseTo(input.expiry + ONE_DAY);

    assert.deepEqual(await bookOf(owner), { count: 1n, total: 70n * ONE_USDC });
  });

  it("records not-after-expiry for a cancel at the expiry second and after-expiry one second later", async () => {
    const { networkHelpers, place, cancel } = await setUp();
    const { input } = await place();
    const expiry = input.expiry;
    await place({ expiry });

    await networkHelpers.time.setNextBlockTimestamp(expiry);
    const atExpiry = await cancel(1n);
    await networkHelpers.time.setNextBlockTimestamp(expiry + 1n);
    const afterExpiry = await cancel(2n);

    assert.equal(atExpiry.event.args.afterExpiry, false);
    assert.equal(afterExpiry.event.args.afterExpiry, true);
  });
});

describe("LedgerTrigger cancelOrder: an expired order (S12)", () => {
  it("S12 an expired order keeps its slot until the owner cancels it: Expired -> Cancelled frees one", async () => {
    const {
      viem,
      networkHelpers,
      trigger,
      owner,
      now,
      defaultInput,
      sendCreate,
      place,
      cancel,
      bookOf,
    } = await setUp();
    const expiry = (await now()) + ONE_HOUR;
    for (let i = 0; i < 5; i += 1) await place({ expiry });
    await networkHelpers.time.increaseTo(expiry + 1n);
    for (let id = 1n; id <= 5n; id += 1n) {
      assert.equal(await trigger.read.statusOf([id]), Status.Expired);
    }
    assert.deepEqual(await bookOf(owner), {
      count: 5n,
      total: 500n * ONE_USDC,
    });

    await viem.assertions.revertWithCustomErrorWithArgs(
      sendCreate(await defaultInput()),
      trigger,
      "TooManyOpenOrders",
      [getAddress(owner.account.address), 5n],
    );

    const { event } = await cancel(4n);
    assert.deepEqual(event.args, {
      orderId: 4n,
      owner: getAddress(owner.account.address),
      afterExpiry: true,
    });
    assert.equal(await trigger.read.statusOf([4n]), Status.Cancelled);
    assert.equal((await trigger.read.getOrder([4n])).status, Status.Cancelled);
    assert.deepEqual(await bookOf(owner), {
      count: 4n,
      total: 400n * ONE_USDC,
    });

    const { orderId } = await place();
    assert.equal(orderId, 6n);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await bookOf(owner), {
      count: 5n,
      total: 500n * ONE_USDC,
    });
  });
});

describe("LedgerTrigger bookkeeping: open count and total always match the orders", () => {
  it("keeps every owner's open count and total equal to the sum over their Open orders, through mixed steps", async () => {
    const fixture = await setUp();
    const {
      networkHelpers,
      trigger,
      owner,
      otherOwner,
      stranger,
      now,
      place,
      cancel,
      bookOf,
    } = fixture;
    const owners = [owner, otherOwner, stranger];
    let lastId = 0n;

    async function assertBooksMatchOrders(step: string) {
      const expected = new Map<string, { count: bigint; total: bigint }>();
      for (const wallet of owners) {
        expected.set(getAddress(wallet.account.address), {
          count: 0n,
          total: 0n,
        });
      }
      for (let id = 1n; id <= lastId; id += 1n) {
        const order = await trigger.read.getOrder([id]);
        const sums = expected.get(getAddress(order.owner));
        assert.ok(sums !== undefined, `order ${id} has an unknown owner`);
        if (order.status === Status.Open) {
          sums.count += 1n;
          sums.total += order.usdcAmount;
        }
      }
      for (const wallet of owners) {
        assert.deepEqual(
          await bookOf(wallet),
          expected.get(getAddress(wallet.account.address)),
          `after ${step}, for ${wallet.account.address}`,
        );
      }
    }

    async function placeAs(
      wallet: (typeof owners)[number],
      usdcAmount: bigint,
      expiry: bigint,
    ) {
      const { orderId } = await place({ usdcAmount, expiry }, wallet);
      lastId = orderId;
    }

    const soon = (await now()) + ONE_HOUR;
    const later = (await now()) + ONE_DAY;
    await placeAs(owner, 100n * ONE_USDC, later); // 1
    await placeAs(otherOwner, 250_000_001n, soon); // 2
    await placeAs(owner, 500n * ONE_USDC, soon); // 3
    await placeAs(stranger, 1n, later); // 4
    await placeAs(otherOwner, 42n * ONE_USDC, later); // 5
    await assertBooksMatchOrders("five orders from three owners");

    await cancel(1n, owner);
    await assertBooksMatchOrders("owner cancels order 1");

    await networkHelpers.time.increaseTo(soon + 1n);
    await assertBooksMatchOrders("orders 2 and 3 expire");

    await cancel(2n, otherOwner);
    await assertBooksMatchOrders("otherOwner cancels expired order 2");

    await placeAs(owner, 7n * ONE_USDC, later); // 6
    await placeAs(stranger, 3n * ONE_USDC, later); // 7
    await cancel(4n, stranger);
    await assertBooksMatchOrders("two more orders and a stranger's cancel");

    await cancel(3n, owner);
    await cancel(6n, owner);
    await cancel(5n, otherOwner);
    await cancel(7n, stranger);
    await assertBooksMatchOrders("every order cancelled");
    for (const wallet of owners) {
      assert.deepEqual(await bookOf(wallet), { count: 0n, total: 0n });
    }
  });
});
