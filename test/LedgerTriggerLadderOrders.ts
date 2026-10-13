import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEventLogs, zeroAddress, type Hash } from "viem";

import { DEFAULT_LIMITS, ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import {
  FillBlocker,
  Kind,
  Status,
  setUpFills,
  type LadderInput,
  type TierInput,
} from "./setUpFills.ts";

// Placing Ladder orders: what is stored and logged, and every input that is
// refused. The default Ladder order has three tiers: 100 USDC at 2000 USD,
// 150 USDC at 1900 USD and 200 USDC at 1800 USD, and is valid for one day.

const MAX_ORDER = DEFAULT_LIMITS.maxOrderAmount;
const MAX_TIERS = DEFAULT_LIMITS.maxTiersPerOrder;
const MAX_OPEN = DEFAULT_LIMITS.maxOpenOrdersPerOwner;

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

/** Sends createLadderOrder with the default input changed by `changes`. */
async function sendLadder(
  f: Fixture,
  changes: Partial<LadderInput>,
): Promise<Hash> {
  return f.sendPlaceLadder({ ...(await f.defaultLadderInput()), ...changes });
}

/** `count` tiers of 10 USDC each, at 2000, 1999, 1998 ... USD. */
function tiersOfCount(count: bigint): TierInput[] {
  return Array.from({ length: Number(count) }, (_, index) => ({
    price: usd(2_000n - BigInt(index)),
    usdcAmount: 10n * ONE_USDC,
  }));
}

/** Tier `index` of `tiers`; fails the test if there is none. */
function tierAt(tiers: readonly TierInput[], index: number): TierInput {
  const tier = tiers[index];
  if (tier === undefined) throw new Error(`no tier ${index}`);
  return tier;
}

/** `tiers` with tier `index` changed by `changes`. */
function withTier(
  tiers: readonly TierInput[],
  index: number,
  changes: Partial<TierInput>,
): TierInput[] {
  return tiers.map((tier, i) => (i === index ? { ...tier, ...changes } : tier));
}

/** Three tiers of 10, 15 and 20 USDC at 2000, 1900 and 1800 USD. */
const THREE: readonly TierInput[] = [
  { price: usd(2_000n), usdcAmount: 10n * ONE_USDC },
  { price: usd(1_900n), usdcAmount: 15n * ONE_USDC },
  { price: usd(1_800n), usdcAmount: 20n * ONE_USDC },
];

describe("LedgerTrigger createLadderOrder: a Ladder order is placed", () => {
  for (const [label, allowance, atTier0] of [
    [
      "with an allowance that covers tier 0, canFill at the price of tier 0 reports it fillable",
      100n * ONE_USDC,
      { fillable: true, reason: FillBlocker.None },
    ],
    [
      "with a zero allowance, canFill at the price of tier 0 reports InsufficientAllowance",
      0n,
      { fillable: false, reason: FillBlocker.InsufficientAllowance },
    ],
  ] as const) {
    it(`places an Open Ladder order whose budget is its tiers added up; getTiers gives the tiers as given, OrderCreated then OrderTiered record it, and no money moves; ${label}`, async () => {
      const f = await setUpFills();
      const { publicClient, trigger, usdc, owner, stranger, otherOwner } = f;
      await f.approve(owner, allowance, trigger.address);
      const tiers: TierInput[] = [
        { price: usd(2_100n) + 7n, usdcAmount: 12n * ONE_USDC + 345_678n },
        { price: usd(1_950n), usdcAmount: 40n * ONE_USDC },
        { price: usd(1_950n) - 1n, usdcAmount: 1n },
      ];
      const budget = 52n * ONE_USDC + 345_679n;
      const expiry = (await f.now()) + 5_000n;
      const input: LadderInput = {
        tiers,
        activationPrice: 0n,
        recipient: stranger.account.address,
        executor: otherOwner.account.address,
        expiry,
      };
      const ownerUsdc = (await f.balancesOf(owner.account.address)).usdc;
      const contractBefore = await f.balancesOf(trigger.address);

      const { orderId, receipt, created, tiered } = await f.placeLadder(input);

      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      assert.equal(orderId, 1n);
      assert.deepEqual(await trigger.read.getOrder([orderId]), {
        owner: getAddress(owner.account.address),
        executor: getAddress(input.executor),
        recipient: getAddress(input.recipient),
        kind: Kind.Ladder,
        status: Status.Open,
        usdcAmount: budget,
        usdcRemaining: budget,
        targetPrice: tierAt(tiers, 0).price,
        activationPrice: 0n,
        fillsTotal: 3n,
        fillsDone: 0n,
        createdAt: block.timestamp,
        expiry,
      });
      assert.deepEqual(await f.tiersOf(orderId), tiers);
      const logged = parseEventLogs({ abi: trigger.abi, logs: receipt.logs });
      assert.deepEqual(
        logged.map((log) => log.eventName),
        ["OrderCreated", "OrderTiered"],
      );
      assert.deepEqual(created.args, {
        orderId: 1n,
        owner: getAddress(owner.account.address),
        executor: getAddress(input.executor),
        recipient: getAddress(input.recipient),
        usdcAmount: budget,
        targetPrice: tierAt(tiers, 0).price,
        expiry,
        kind: Kind.Ladder,
        activationPrice: 0n,
      });
      assert.deepEqual(tiered.args, { orderId: 1n, tiers });
      assert.deepEqual(await f.bookOf(owner), { count: 1n, total: budget });
      assert.equal((await f.balancesOf(owner.account.address)).usdc, ownerUsdc);
      assert.equal(
        await usdc.read.allowance([owner.account.address, trigger.address]),
        allowance,
      );
      assert.deepEqual(await f.balancesOf(trigger.address), contractBefore);
      assert.equal(await trigger.read.statusOf([orderId]), Status.Open);

      await f.setPrice(tierAt(tiers, 0).price + 1n);
      assert.deepEqual(await f.canFill(orderId), {
        fillable: false,
        reason: FillBlocker.PriceAboveTarget,
      });
      await f.setPrice(tierAt(tiers, 0).price);
      assert.deepEqual(await f.canFill(orderId), atTier0);
    });
  }

  it("logs OrderTiered with two parameters, the order ID and the tiers, of which only the order ID is indexed", async () => {
    const f = await setUpFills();

    const event = f.trigger.abi.find(
      (item) => item.type === "event" && item.name === "OrderTiered",
    );

    assert.ok(event !== undefined && event.type === "event");
    assert.deepEqual(
      event.inputs.map((input) => [input.name, input.type, input.indexed]),
      [
        ["orderId", "uint256", true],
        ["tiers", "tuple[]", false],
      ],
    );
  });

  it("numbers Ladder orders together with the orders createOrder, createDormantOrder and createDcaOrder place", async () => {
    const f = await setUpFills();

    const ids = [
      (await f.place()).orderId,
      (await f.placeLadder()).orderId,
      (await f.placeDca()).orderId,
      (await f.placeDormant()).orderId,
      (await f.placeLadder({}, f.otherOwner)).orderId,
    ];

    assert.deepEqual(ids, [1n, 2n, 3n, 4n, 5n]);
    const kinds = [];
    for (const orderId of ids) {
      kinds.push((await f.trigger.read.getOrder([orderId])).kind);
    }
    assert.deepEqual(kinds, [
      Kind.Limit,
      Kind.Ladder,
      Kind.Dca,
      Kind.Limit,
      Kind.Ladder,
    ]);
  });
});

describe("LedgerTrigger createLadderOrder: the number of tiers (S52)", () => {
  it("S52 rejects an order with no tiers with NoTiers, and stores nothing", async () => {
    const f = await setUpFills();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { tiers: [] }),
      f.trigger,
      "NoTiers",
      [],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });

  it("S52 accepts exactly maxTiersPerOrder tiers", async () => {
    const f = await setUpFills();
    const tiers = tiersOfCount(MAX_TIERS);

    const { orderId } = await f.placeLadder({ tiers });

    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.fillsTotal, MAX_TIERS);
    assert.equal(order.usdcAmount, MAX_TIERS * 10n * ONE_USDC);
    assert.deepEqual(await f.tiersOf(orderId), tiers);
  });

  it("S52 rejects one tier more than maxTiersPerOrder with TooManyTiers naming the count and the limit", async () => {
    const f = await setUpFills();

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { tiers: tiersOfCount(MAX_TIERS + 1n) }),
      f.trigger,
      "TooManyTiers",
      [MAX_TIERS + 1n, MAX_TIERS],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });
});

describe("LedgerTrigger createLadderOrder: rejected tiers (S52)", () => {
  for (const [label, tiers, error, args] of [
    [
      "a tier 1 at the price of tier 0",
      withTier(THREE, 1, { price: usd(2_000n) }),
      "TiersNotDescending",
      [1n],
    ],
    [
      "a tier 1 above tier 0",
      withTier(THREE, 1, { price: usd(2_000n) + 1n }),
      "TiersNotDescending",
      [1n],
    ],
    [
      "three tiers of which only tier 2 is above tier 1",
      withTier(THREE, 2, { price: usd(1_900n) + 1n }),
      "TiersNotDescending",
      [2n],
    ],
    [
      "a zero amount in tier 0",
      withTier(THREE, 0, { usdcAmount: 0n }),
      "ZeroAmount",
      [],
    ],
    [
      "a zero amount in the last tier",
      withTier(THREE, 2, { usdcAmount: 0n }),
      "ZeroAmount",
      [],
    ],
    [
      "a tier one unit above maxOrderAmount",
      withTier(THREE, 1, { usdcAmount: MAX_ORDER + 1n }),
      "AmountAboveMax",
      [MAX_ORDER + 1n, MAX_ORDER],
    ],
    [
      "a zero price in tier 0",
      withTier(THREE, 0, { price: 0n }),
      "ZeroTargetPrice",
      [],
    ],
    [
      "a zero price in the last tier",
      withTier(THREE, 2, { price: 0n }),
      "ZeroTargetPrice",
      [],
    ],
  ] as const) {
    it(`S52 rejects ${label} with ${error}, and stores nothing`, async () => {
      const f = await setUpFills();
      await f.placeLadder();
      const book = await f.bookOf(f.owner);

      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendLadder(f, { tiers }),
        f.trigger,
        error,
        [...args],
      );

      await assertNothingPlaced(f, book, 2n);
    });
  }

  it("S52 accepts a tier equal to maxOrderAmount", async () => {
    const f = await setUpFills();
    const tiers = withTier(THREE, 1, { usdcAmount: MAX_ORDER });

    const { orderId } = await f.placeLadder({ tiers });

    assert.deepEqual(await f.tiersOf(orderId), tiers);
    assert.equal(
      (await f.trigger.read.getOrder([orderId])).usdcAmount,
      MAX_ORDER + 30n * ONE_USDC,
    );
  });

  it("S52 accepts two tiers each equal to maxOrderAmount: the budget is twice the limit", async () => {
    const f = await setUpFills();
    await f.approve(f.owner, 2n * MAX_ORDER, f.trigger.address);

    const { orderId } = await f.placeLadder({
      tiers: [
        { price: usd(2_000n), usdcAmount: MAX_ORDER },
        { price: usd(1_900n), usdcAmount: MAX_ORDER },
      ],
    });

    const order = await f.trigger.read.getOrder([orderId]);
    assert.equal(order.usdcAmount, 2n * MAX_ORDER);
    assert.equal(order.usdcRemaining, 2n * MAX_ORDER);
    assert.deepEqual(await f.bookOf(f.owner), {
      count: 1n,
      total: 2n * MAX_ORDER,
    });
  });
});

describe("LedgerTrigger createLadderOrder: rejected parties, expiry and slots (S52)", () => {
  for (const [label, changes, error] of [
    ["a zero recipient", { recipient: zeroAddress }, "ZeroRecipient"],
    ["a zero executor", { executor: zeroAddress }, "ZeroExecutor"],
  ] as const) {
    it(`S52 rejects ${label} with ${error}, and stores nothing`, async () => {
      const f = await setUpFills();

      await f.viem.assertions.revertWithCustomErrorWithArgs(
        sendLadder(f, changes),
        f.trigger,
        error,
        [],
      );

      await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
    });
  }

  it("S52 rejects an expiry equal to the time of the block that would place the order with ExpiryNotInFuture naming the expiry and the block's time", async () => {
    const f = await setUpFills();
    const blockTime = (await f.now()) + 100n;
    await f.networkHelpers.time.setNextBlockTimestamp(blockTime);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { expiry: blockTime }),
      f.trigger,
      "ExpiryNotInFuture",
      [blockTime, blockTime],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);
  });

  it("S52 counts Ladder orders against the open-order limit: with five unfinished orders, two of them Ladder orders, both createLadderOrder and createOrder are rejected with TooManyOpenOrders", async () => {
    const f = await setUpFills();
    await f.placeLadder({ tiers: THREE });
    await f.placeLadder({ tiers: THREE, activationPrice: usd(2_200n) });
    await f.place();
    await f.placeDca();
    await f.placeDormant();
    const book = await f.bookOf(f.owner);
    assert.equal(book.count, MAX_OPEN);

    await f.viem.assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {}),
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
});

describe("LedgerTrigger createLadderOrder: the checks come in a fixed order (S52)", () => {
  it("S52 checks the number of tiers first, then each tier in full from tier 0 on, then the activation price, then recipient, executor, expiry and slots", async () => {
    const f = await setUpFills();
    const top = tierAt(THREE, 0).price;
    const now = await f.now();
    const assertions = f.viem.assertions;

    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { tiers: [], recipient: zeroAddress }),
      f.trigger,
      "NoTiers",
      [],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(tiersOfCount(MAX_TIERS + 1n), 0, { usdcAmount: 0n }),
      }),
      f.trigger,
      "TooManyTiers",
      [MAX_TIERS + 1n, MAX_TIERS],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(withTier(THREE, 0, { usdcAmount: 0n }), 1, {
          price: top,
        }),
      }),
      f.trigger,
      "ZeroAmount",
      [],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(withTier(THREE, 1, { price: top }), 2, {
          usdcAmount: 0n,
        }),
      }),
      f.trigger,
      "TiersNotDescending",
      [1n],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(withTier(THREE, 0, { price: 0n }), 1, {
          usdcAmount: 0n,
        }),
      }),
      f.trigger,
      "ZeroTargetPrice",
      [],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(THREE, 1, {
          usdcAmount: MAX_ORDER + 1n,
          price: top + 1n,
        }),
      }),
      f.trigger,
      "AmountAboveMax",
      [MAX_ORDER + 1n, MAX_ORDER],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(THREE, 1, { price: top }),
        activationPrice: top,
      }),
      f.trigger,
      "TiersNotDescending",
      [1n],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { activationPrice: top, recipient: zeroAddress }),
      f.trigger,
      "ActivationNotAboveTarget",
      [top, top],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        tiers: withTier(THREE, 2, { price: top }),
        expiry: now - 1n,
      }),
      f.trigger,
      "TiersNotDescending",
      [2n],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, {
        recipient: zeroAddress,
        executor: zeroAddress,
        expiry: now - 1n,
      }),
      f.trigger,
      "ZeroRecipient",
      [],
    );
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { executor: zeroAddress, expiry: now - 1n }),
      f.trigger,
      "ZeroExecutor",
      [],
    );

    await assertNothingPlaced(f, { count: 0n, total: 0n }, 1n);

    for (let i = 0n; i < MAX_OPEN; i += 1n) {
      await f.placeLadder({ tiers: THREE });
    }
    const full = (await f.now()) + 10n;
    await f.networkHelpers.time.setNextBlockTimestamp(full);
    await assertions.revertWithCustomErrorWithArgs(
      sendLadder(f, { tiers: THREE, expiry: full }),
      f.trigger,
      "ExpiryNotInFuture",
      [full, full],
    );
  });
});
