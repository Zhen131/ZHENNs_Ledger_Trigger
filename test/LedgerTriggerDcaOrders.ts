import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  maxUint256,
  parseEventLogs,
  zeroAddress,
  type Hash,
} from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  FillBlocker,
  Kind,
  ONE_DAY,
  Status,
  setUpFills,
  type DcaInput,
} from "./setUpFills.ts";

// Placing time-scheduled (Dca) orders: what is stored and logged, and every
// input that is refused. The default Dca order buys 100 USDC's worth of ETH
// once a day for three days, at no more than 2000 USD, starting in the block
// that places it.

const MAX_ORDER = DEFAULT_LIMITS.maxOrderAmount;
const MAX_PERIODS = DEFAULT_LIMITS.maxPeriodsPerOrder;
const MAX_OPEN = DEFAULT_LIMITS.maxOpenOrdersPerOwner;
/** Solidity's panic code for an arithmetic overflow. */
const PANIC_OVERFLOW = 0x11n;

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/**
 * Asserts that the owner's open count and total are `book`, and that no order
 * has the ID `nextId`: a rejected call stored nothing.
 */
async function assertNothingPlaced(
  f: Fixture,
  book: { readonly count: bigint; readonly total: bigint },
  nextId: bigint,
) {
  assert.deepEqual(await f.bookOf(f.owner), book);
  await f.viem.assertions.revertWithCustomErrorWithArgs(
    f.trigger.read.getOrder([nextId]),
    f.trigger,
    "OrderNotFound",
    [nextId],
  );
}

/** Sends createDcaOrder with the default Dca input changed by `changes`. */
function sendDca(f: Fixture, changes: Partial<DcaInput>): Promise<Hash> {
  return f.sendPlaceDca({ ...f.defaultDcaInput(), ...changes });
}

/** Sets the time of the next block and returns it: `seconds` from now. */
async function nextBlockIn(f: Fixture, seconds: bigint): Promise<bigint> {
  const blockTime = (await f.now()) + seconds;
  await f.networkHelpers.time.setNextBlockTimestamp(blockTime);
  return blockTime;
}

/** The code of the Solidity panic that `error` comes from, if it is one. */
function panicCode(error: unknown): bigint | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  if (revert.data?.errorName !== "Panic") return undefined;
  const [code] = revert.data.args ?? [];
  return typeof code === "bigint" ? code : undefined;
}

describe("LedgerTrigger createDcaOrder: a Dca order is placed", () => {
  it("places an Open Dca order whose budget is the amount per period times the number of periods; its schedule is stored, and OrderCreated then OrderScheduled record it", async () => {
    const f = await setUpFills();
    const { publicClient, trigger, usdc, owner, stranger, otherOwner } = f;
    const startAt = (await f.now()) + 1_000n;
    const input: DcaInput = {
      usdcPerPeriod: 12n * ONE_USDC + 345_678n,
      targetPrice: usd(1_950n) + 1n,
      periodLength: 3_600n,
      periodCount: 4n,
      startAt,
      activationPrice: 0n,
      recipient: stranger.account.address,
      executor: otherOwner.account.address,
    };
    const budget = input.usdcPerPeriod * 4n;
    const expiry = startAt + 4n * 3_600n - 1n;
    const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;
    const allowance = await usdc.read.allowance([
      owner.account.address,
      trigger.address,
    ]);
    const contractBefore = await f.balancesOf(trigger.address);

    const { orderId, receipt, created, scheduled } = await f.placeDca(input);

    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.deepEqual(await trigger.read.getOrder([orderId]), {
      owner: getAddress(owner.account.address),
      executor: getAddress(input.executor),
      recipient: getAddress(input.recipient),
      kind: Kind.Dca,
      status: Status.Open,
      usdcAmount: budget,
      usdcRemaining: budget,
      targetPrice: input.targetPrice,
      activationPrice: 0n,
      fillsTotal: 4n,
      fillsDone: 0n,
      createdAt: block.timestamp,
      expiry,
    });
    assert.deepEqual(await f.scheduleOf(orderId), {
      startAt,
      periodLength: 3_600n,
      usdcPerPeriod: input.usdcPerPeriod,
      filledThrough: 0n,
    });
    const logged = parseEventLogs({ abi: trigger.abi, logs: receipt.logs });
    assert.deepEqual(
      logged.map((log) => log.eventName),
      ["OrderCreated", "OrderScheduled"],
    );
    assert.deepEqual(created.args, {
      orderId: 1n,
      owner: getAddress(owner.account.address),
      executor: getAddress(input.executor),
      recipient: getAddress(input.recipient),
      usdcAmount: budget,
      targetPrice: input.targetPrice,
      expiry,
      kind: Kind.Dca,
      activationPrice: 0n,
    });
    assert.deepEqual(scheduled.args, {
      orderId: 1n,
      startAt,
      periodLength: 3_600n,
      periodCount: 4n,
      usdcPerPeriod: input.usdcPerPeriod,
    });
    assert.deepEqual(await f.bookOf(owner), { count: 1n, total: budget });
    assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      allowance,
    );
    assert.deepEqual(await f.balancesOf(trigger.address), contractBefore);
    assert.equal(await trigger.read.statusOf([orderId]), Status.Open);
    assert.deepEqual(await f.canFill(orderId), {
      fillable: false,
      reason: FillBlocker.NotStarted,
    });
  });

  it("needs no allowance: with a zero allowance the order is placed just the same, and the allowance stays zero", async () => {
    const f = await setUpFills();
    const { trigger, usdc, owner } = f;
    await f.approve(owner, 0n, trigger.address);

    const { orderId, input } = await f.placeDca({
      startAt: (await f.now()) + ONE_DAY,
    });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.kind, Kind.Dca);
    assert.equal(order.status, Status.Open);
    assert.equal(order.usdcAmount, input.usdcPerPeriod * input.periodCount);
    assert.equal(
      await usdc.read.allowance([owner.account.address, trigger.address]),
      0n,
    );
    assert.deepEqual(await f.bookOf(owner), {
      count: 1n,
      total: input.usdcPerPeriod * input.periodCount,
    });
  });

  it("numbers Dca orders together with the orders createOrder and createDormantOrder place", async () => {
    const f = await setUpFills();

    const ids = [
      (await f.place()).orderId,
      (await f.placeDca()).orderId,
      (await f.placeDormant()).orderId,
      (await f.placeDca({}, f.otherOwner)).orderId,
    ];

    assert.deepEqual(ids, [1n, 2n, 3n, 4n]);
    assert.equal((await f.trigger.read.getOrder([2n])).kind, Kind.Dca);
    assert.equal((await f.trigger.read.getOrder([3n])).kind, Kind.Limit);
  });
});

describe("LedgerTrigger createDcaOrder: the two limits (S46)", () => {
  it("S46 accepts an amount per period equal to maxOrderAmount over two periods: the budget is twice the limit", async () => {
    const f = await setUpFills();

    const { orderId } = await f.placeDca({
      usdcPerPeriod: MAX_ORDER,
      periodCount: 2n,
    });

    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.usdcAmount, 2n * MAX_ORDER);
    assert.equal(order.usdcRemaining, 2n * MAX_ORDER);
    assert.deepEqual(await f.bookOf(f.owner), {
      count: 1n,
      total: 2n * MAX_ORDER,
    });
  });

  it("S46 rejects an amount per period one unit above maxOrderAmount with AmountAboveMax naming the amount per period and the limit", async () => {
    const f = await setUpFills();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { usdcPerPeriod: MAX_ORDER + 1n, periodCount: 1n }),
      f.trigger,
      "AmountAboveMax",
      [MAX_ORDER + 1n, MAX_ORDER],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });

  it("S46 accepts exactly maxPeriodsPerOrder periods", async () => {
    const f = await setUpFills();

    const { orderId, input } = await f.placeDca({ periodCount: MAX_PERIODS });

    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.fillsTotal, MAX_PERIODS);
    assert.equal(order.usdcAmount, input.usdcPerPeriod * MAX_PERIODS);
  });

  it("S46 rejects one period more than maxPeriodsPerOrder with TooManyPeriods naming the count and the limit", async () => {
    const f = await setUpFills();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { periodCount: MAX_PERIODS + 1n }),
      f.trigger,
      "TooManyPeriods",
      [MAX_PERIODS + 1n, MAX_PERIODS],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });
});

describe("LedgerTrigger createDcaOrder: rejected inputs (S46)", () => {
  for (const [label, changes, error] of [
    ["a zero amount per period", { usdcPerPeriod: 0n }, "ZeroAmount"],
    ["a zero price cap", { targetPrice: 0n }, "ZeroTargetPrice"],
    ["a zero period length", { periodLength: 0n }, "ZeroPeriodLength"],
    ["a zero number of periods", { periodCount: 0n }, "ZeroPeriodCount"],
    ["a zero recipient", { recipient: zeroAddress }, "ZeroRecipient"],
    ["a zero executor", { executor: zeroAddress }, "ZeroExecutor"],
  ] as const) {
    it(`S46 rejects ${label} with ${error}, and stores nothing`, async () => {
      const f = await setUpFills();
      await f.place();
      const book = await f.bookOf(f.owner);

      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendDca(f, changes),
        f.trigger,
        error,
        [],
      );

      await assertNothingPlaced(f, book, 2n);
    });
  }

  it("S46 rejects a start time one second before the block that would place the order with StartInPast naming the start time and the block's time", async () => {
    const f = await setUpFills();
    const blockTime = await nextBlockIn(f, 100n);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { startAt: blockTime - 1n }),
      f.trigger,
      "StartInPast",
      [blockTime - 1n, blockTime],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });

  it("S46 accepts a start time equal to the time of the block that places the order; the expiry is the last second of the last period", async () => {
    const f = await setUpFills();
    const blockTime = await nextBlockIn(f, 100n);

    const { orderId, receipt } = await f.placeDca({ startAt: blockTime });

    const block = await f.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.equal(block.timestamp, blockTime);
    assert.equal((await f.scheduleOf(orderId)).startAt, blockTime);
    assert.equal(
      (await f.trigger.read.getOrder([orderId])).expiry,
      blockTime + 3n * ONE_DAY - 1n,
    );
  });

  it("S46 takes a start time of zero as the time of the block that places the order: getSchedule and OrderScheduled both give that time, and the expiry follows from it", async () => {
    const f = await setUpFills();
    const blockTime = await nextBlockIn(f, 1_234n);

    const { orderId, receipt, scheduled } = await f.placeDca({ startAt: 0n });

    const block = await f.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    assert.equal(block.timestamp, blockTime);
    assert.equal((await f.scheduleOf(orderId)).startAt, blockTime);
    assert.equal(scheduled.args.startAt, blockTime);
    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.expiry, blockTime + 3n * ONE_DAY - 1n);
    assert.equal(order.createdAt, blockTime);
  });

  it("S46 counts Dca orders against the open-order limit: with five unfinished orders, two of them Dca orders, both createDcaOrder and createOrder are rejected with TooManyOpenOrders", async () => {
    const f = await setUpFills();
    await f.placeDca();
    await f.placeDca({ startAt: (await f.now()) + ONE_DAY });
    await f.place();
    await f.place();
    await f.placeDormant();
    const book = await f.bookOf(f.owner);
    assert.equal(book.count, MAX_OPEN);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendDca(f, {}),
      f.trigger,
      "TooManyOpenOrders",
      [getAddress(f.owner.account.address), MAX_OPEN],
    );
    const input = await f.defaultInput();
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.trigger.write.createOrder(
        [
          input.usdcAmount,
          input.targetPrice,
          input.recipient,
          input.executor,
          input.expiry,
        ],
        { account: f.owner.account },
      ),
      f.trigger,
      "TooManyOpenOrders",
      [getAddress(f.owner.account.address), MAX_OPEN],
    );

    await assertNothingPlaced(f, book, 6n);
  });

  for (const [label, startAt] of [
    ["at the time of the block that places it", "block"],
    ["given as zero", "zero"],
  ] as const) {
    it(`S46 rejects one period of one second with its start ${label} with ExpiryNotInFuture: its expiry would be the block's own time`, async () => {
      const f = await setUpFills();
      const blockTime = await nextBlockIn(f, 100n);

      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendDca(f, {
          startAt: startAt === "block" ? blockTime : 0n,
          periodLength: 1n,
          periodCount: 1n,
        }),
        f.trigger,
        "ExpiryNotInFuture",
        [blockTime, blockTime],
      );

      await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
    });
  }

  it("S46 checks in a fixed order: amount, price cap, period length, number of periods, start time, recipient, executor, expiry, slots", async () => {
    const f = await setUpFills();
    const past = (await f.now()) - 10n;
    const assertions = f.viem.assertions;
    await assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { usdcPerPeriod: 0n, periodLength: 0n }),
      f.trigger,
      "ZeroAmount",
      [],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { usdcPerPeriod: MAX_ORDER + 1n, targetPrice: 0n }),
      f.trigger,
      "AmountAboveMax",
      [MAX_ORDER + 1n, MAX_ORDER],
    );
    for (const changes of [{ periodCount: 0n }, { periodLength: 0n }]) {
      await assertions.revertWithCustomErrorWithArgs(
        sendDca(f, { targetPrice: 0n, ...changes }),
        f.trigger,
        "ZeroTargetPrice",
        [],
      );
    }
    for (const changes of [{ periodCount: 0n }, { recipient: zeroAddress }]) {
      await assertions.revertWithCustomErrorWithArgs(
        sendDca(f, { periodLength: 0n, ...changes }),
        f.trigger,
        "ZeroPeriodLength",
        [],
      );
    }
    await assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { periodCount: 0n, startAt: past }),
      f.trigger,
      "ZeroPeriodCount",
      [],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { periodCount: MAX_PERIODS + 1n, startAt: past }),
      f.trigger,
      "TooManyPeriods",
      [MAX_PERIODS + 1n, MAX_PERIODS],
    );
    for (const changes of [
      { recipient: zeroAddress },
      { executor: zeroAddress },
    ]) {
      const blockTime = await nextBlockIn(f, 10n);
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendDca(f, { startAt: past, ...changes }),
        f.trigger,
        "StartInPast",
        [past, blockTime],
      );
    }
    await f.viem.assertions.revertWithCustomError(
      sendDca(f, { recipient: zeroAddress, executor: zeroAddress }),
      f.trigger,
      "ZeroRecipient",
    );
    const blockTime = await nextBlockIn(f, 10n);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendDca(f, {
        executor: zeroAddress,
        startAt: blockTime,
        periodLength: 1n,
        periodCount: 1n,
      }),
      f.trigger,
      "ZeroExecutor",
      [],
    );
    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);

    for (let i = 0n; i < MAX_OPEN; i += 1n) await f.placeDca();
    const full = await nextBlockIn(f, 10n);
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendDca(f, { startAt: full, periodLength: 1n, periodCount: 1n }),
      f.trigger,
      "ExpiryNotInFuture",
      [full, full],
    );
  });

  it("S46 rejects a period length so large that the schedule does not fit in 256 bits: the call reverts with an overflow panic and stores nothing", async () => {
    const f = await setUpFills();

    await assert.rejects(
      sendDca(f, { periodLength: maxUint256 }),
      (error) => panicCode(error) === PANIC_OVERFLOW,
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });

  it("S46 places a Dca order with an activation price equal to, or below, its price cap: both are Dormant", async () => {
    const f = await setUpFills();
    const cap = usd(2_000n);

    const equal = await f.placeDca({ targetPrice: cap, activationPrice: cap });
    const below = await f.placeDca({
      targetPrice: cap,
      activationPrice: cap - usd(300n),
    });

    for (const [{ orderId, created }, activationPrice] of [
      [equal, cap],
      [below, cap - usd(300n)],
    ] as const) {
      const order = await f.trigger.read.getOrder([orderId]);
      assert.equal(order.status, Status.Dormant);
      assert.equal(order.kind, Kind.Dca);
      assert.equal(order.activationPrice, activationPrice);
      assert.equal(created.args.activationPrice, activationPrice);
      assert.equal(await f.trigger.read.statusOf([orderId]), Status.Dormant);
    }
    assert.deepEqual(await f.bookOf(f.owner), {
      count: 2n,
      total: 600n * ONE_USDC,
    });
  });
});
