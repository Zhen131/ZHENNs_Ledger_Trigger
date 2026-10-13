import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, type EIP1193RequestFn } from "viem";

import {
  formatPlacedDcaOrder,
  placeDcaOrder,
  placeDcaOrderSettingsFrom,
} from "../scripts/placeDcaOrder.ts";
import {
  ScriptError,
  describeFailure,
  revertName,
} from "../scripts/scriptError.ts";
import { VARIABLES, type Environment } from "../scripts/settings.ts";
import { setUpScripts } from "./setUpScripts.ts";

// place-dca-order places a time-scheduled order from the first account, after
// simulating it and setting the allowance to the owner's open total plus the
// order's budget. The parts are deployed with the default limits: at most
// 500 USDC per fill, 5 open orders per owner and 52 periods per order; USDC
// has 6 decimals and the price feed 8.

const KIND_DCA = 1;
const STATUS_DORMANT = 1;
const STATUS_OPEN = 2;

async function ready() {
  const s = await setUpScripts();
  const parts = await s.withParts();
  return { ...s, ...parts };
}

type Ready = Awaited<ReturnType<typeof ready>>;

/** The variables of an order every test starts from, changed by `changes`. */
function variables(s: Ready, changes: Environment = {}): Environment {
  return {
    [VARIABLES.contractAddress]: s.trigger.address,
    [VARIABLES.usdcPerPeriod]: "10",
    [VARIABLES.targetPriceUsd]: "2100",
    [VARIABLES.periodSeconds]: "3600",
    [VARIABLES.periodCount]: "3",
    [VARIABLES.recipientAddress]: s.recipient.account.address,
    [VARIABLES.executorAddress]: s.executor.account.address,
    ...changes,
  };
}

function place(s: Ready, changes: Environment = {}) {
  return placeDcaOrder({
    viem: s.viem,
    confirmation: undefined,
    settings: placeDcaOrderSettingsFrom(variables(s, changes)),
  });
}

function allowance(s: Ready) {
  return s.usdc.read.allowance([s.owner.account.address, s.trigger.address]);
}

/** The latest block's time. */
async function latestTime(s: Ready): Promise<bigint> {
  return (await s.publicClient.getBlock({ blockTag: "latest" })).timestamp;
}

describe("place-dca-order: places the order it is given", () => {
  it("turns USDC and USD written with decimals, and a given start time, into the order and schedule the contract stores", async () => {
    const s = await ready();
    const startAt = (await latestTime(s)) + 1_000n;

    const result = await place(s, {
      [VARIABLES.usdcPerPeriod]: "12.5",
      [VARIABLES.targetPriceUsd]: "2100.25",
      [VARIABLES.periodCount]: "4",
      [VARIABLES.startAt]: String(startAt),
    });

    const perPeriod = 12_500_000n;
    const cap = 210_025_000_000n;
    const order = await s.trigger.read.getOrder([result.orderId]);
    assert.equal(order.kind, KIND_DCA);
    assert.equal(order.status, STATUS_OPEN);
    assert.equal(order.owner, getAddress(s.owner.account.address));
    assert.equal(order.recipient, getAddress(s.recipient.account.address));
    assert.equal(order.executor, getAddress(s.executor.account.address));
    assert.equal(order.usdcAmount, 4n * perPeriod);
    assert.equal(order.targetPrice, cap);
    assert.equal(order.activationPrice, 0n);
    assert.equal(order.fillsTotal, 4n);
    assert.equal(order.expiry, startAt + 4n * 3_600n - 1n);
    assert.deepEqual(await s.trigger.read.getSchedule([result.orderId]), {
      startAt,
      periodLength: 3_600n,
      usdcPerPeriod: perPeriod,
      filledThrough: 0n,
    });
    assert.equal(result.usdcPerPeriod, perPeriod);
    assert.equal(result.targetPrice, cap);
    assert.equal(result.startAt, startAt);
    assert.equal(result.status, "Open");
  });

  it("sets the allowance to the open total before the order plus its whole budget, and reports the allowance equal to the open total after it", async () => {
    const s = await ready();
    const latest = await latestTime(s);
    await s.publicClient.waitForTransactionReceipt({
      hash: await s.trigger.write.createOrder(
        [
          7_000_000n,
          200_000_000_000n,
          s.recipient.account.address,
          s.executor.account.address,
          latest + 3_600n,
        ],
        { account: s.owner.account },
      ),
    });
    const openBefore = await s.trigger.read.openOrderTotal([
      s.owner.account.address,
    ]);
    assert.equal(openBefore, 7_000_000n);

    const result = await place(s);

    const budget = 3n * 10_000_000n;
    assert.equal(await allowance(s), openBefore + budget);
    assert.equal(result.allowance, openBefore + budget);
    assert.equal(result.openOrderTotal, openBefore + budget);
    assert.equal(result.allowance, result.openOrderTotal);
    assert.equal(result.usdcAmount, budget);
  });

  it("with no start time, starts the order in the block that places it, even when the chain's clock has moved on since the latest block", async () => {
    const s = await ready();
    const request = s.publicClient.request as unknown as EIP1193RequestFn;
    await request({ method: "evm_increaseTime", params: [3_600] } as never);
    const latestBefore = await latestTime(s);

    const result = await place(s);

    const schedule = await s.trigger.read.getSchedule([result.orderId]);
    assert.equal(schedule.startAt, result.placedAt);
    assert.ok(schedule.startAt >= latestBefore + 3_600n);
    const order = await s.trigger.read.getOrder([result.orderId]);
    assert.equal(order.createdAt, result.placedAt);
    assert.equal(order.expiry, result.placedAt + 3n * 3_600n - 1n);
  });

  it("with an activation price places the order Dormant at that price, and without one places it Open with none", async () => {
    const s = await ready();

    const dormant = await place(s, {
      [VARIABLES.activationPriceUsd]: "2250.5",
    });
    const open = await place(s);

    const asleep = await s.trigger.read.getOrder([dormant.orderId]);
    assert.equal(asleep.status, STATUS_DORMANT);
    assert.equal(asleep.activationPrice, 225_050_000_000n);
    assert.equal(dormant.status, "Dormant");
    const awake = await s.trigger.read.getOrder([open.orderId]);
    assert.equal(awake.status, STATUS_OPEN);
    assert.equal(awake.activationPrice, 0n);
    assert.equal(open.status, "Open");
  });
});

describe("place-dca-order: simulates the order before it approves", () => {
  for (const [label, changes, error] of [
    [
      "an amount per period above the largest fill",
      { [VARIABLES.usdcPerPeriod]: "600" },
      "AmountAboveMax",
    ],
    [
      "more periods than allowed",
      { [VARIABLES.periodCount]: "53" },
      "TooManyPeriods",
    ],
    ["a start time already past", { [VARIABLES.startAt]: "1" }, "StartInPast"],
  ] as const) {
    it(`sends nothing and leaves the allowance alone for ${label}`, async () => {
      const s = await ready();
      const blockBefore = await s.blockNumber();

      await assert.rejects(
        place(s, changes),
        (failure) =>
          revertName(failure) === error &&
          describeFailure(failure).startsWith(
            `The contract rejected the call with ${error}(`,
          ),
      );

      assert.equal(await s.blockNumber(), blockBefore);
      assert.equal(await allowance(s), 0n);
    });
  }

  it("sends nothing and leaves the allowance at the open-order total for a sixth open order", async () => {
    const s = await ready();
    for (let i = 0; i < 5; i += 1) await place(s);
    assert.equal(await allowance(s), 150_000_000n);
    const blockBefore = await s.blockNumber();

    await assert.rejects(
      place(s),
      (failure) => revertName(failure) === "TooManyOpenOrders",
    );

    assert.equal(await s.blockNumber(), blockBefore);
    assert.equal(await allowance(s), 150_000_000n);
  });
});

describe("place-dca-order: settings it cannot use", () => {
  const badValues: readonly (readonly [string, string, string])[] = [
    [VARIABLES.usdcPerPeriod, "1.0000001", "digits after the dot"],
    [VARIABLES.usdcPerPeriod, "-5", "plain number"],
    [VARIABLES.targetPriceUsd, "2000.123456789", "digits after the dot"],
    [VARIABLES.activationPriceUsd, "-1", "plain number"],
    [VARIABLES.periodSeconds, "0", "whole number of at least 1"],
    [VARIABLES.periodCount, "0", "whole number of at least 1"],
    [VARIABLES.startAt, "12.5", "whole number of at least 0"],
    [VARIABLES.recipientAddress, "0x1234", "must be an address"],
    [VARIABLES.executorAddress, "keeper", "must be an address"],
    [VARIABLES.contractAddress, "0x0", "must be an address"],
  ];
  for (const [name, value, words] of badValues) {
    it(`stops before sending anything when ${name} is ${value}, and names the variable`, async () => {
      const s = await ready();
      const blockBefore = await s.blockNumber();

      await assert.rejects(
        async () => place(s, { [name]: value }),
        (failure) =>
          failure instanceof ScriptError &&
          failure.message.includes(name) &&
          failure.message.includes(words) &&
          !failure.message.includes(value),
      );

      assert.equal(await s.blockNumber(), blockBefore);
      assert.equal(await allowance(s), 0n);
    });
  }

  for (const name of [
    VARIABLES.contractAddress,
    VARIABLES.usdcPerPeriod,
    VARIABLES.targetPriceUsd,
    VARIABLES.periodSeconds,
    VARIABLES.periodCount,
    VARIABLES.recipientAddress,
    VARIABLES.executorAddress,
  ]) {
    it(`stops before sending anything when ${name} is not set, and names it`, async () => {
      const s = await ready();
      const blockBefore = await s.blockNumber();

      await assert.rejects(
        async () => place(s, { [name]: undefined }),
        (failure) =>
          failure instanceof ScriptError &&
          failure.message === `${name} is required and not set.`,
      );

      assert.equal(await s.blockNumber(), blockBefore);
    });
  }

  it("treats TRIGGER_START_AT and TRIGGER_ACTIVATION_PRICE_USD as optional: unset, the start time is 0 and there is no activation price; a start time of 0 is taken as given", () => {
    const unset = placeDcaOrderSettingsFrom(variablesWithoutChain());
    const zero = placeDcaOrderSettingsFrom({
      ...variablesWithoutChain(),
      [VARIABLES.startAt]: "0",
    });

    assert.equal(unset.startAt, 0n);
    assert.equal(unset.activationPriceUsd, undefined);
    assert.equal(zero.startAt, 0n);
  });
});

/** Settings that need no chain, with fixed addresses. */
function variablesWithoutChain(): Environment {
  return {
    [VARIABLES.contractAddress]: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    [VARIABLES.usdcPerPeriod]: "10",
    [VARIABLES.targetPriceUsd]: "2000",
    [VARIABLES.periodSeconds]: "60",
    [VARIABLES.periodCount]: "2",
    [VARIABLES.recipientAddress]: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    [VARIABLES.executorAddress]: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  };
}

describe("place-dca-order: what it prints", () => {
  it("prints the order ID, the amount per period, the cap, the periods, the budget, when period 0 begins and how far that is from the block, the last second, and the allowance", async () => {
    const s = await ready();
    const startAt = (await latestTime(s)) + 500n;
    const result = await place(s, { [VARIABLES.startAt]: String(startAt) });

    const lines = formatPlacedDcaOrder(result);

    const text = lines.join("\n");
    assert.match(
      lines[0] ?? "",
      new RegExp(
        `^Placed time-scheduled order ${result.orderId} from account `,
      ),
    );
    assert.match(text, /per period +10 USDC \(10000000\)/);
    assert.match(text, /price cap +2100 USD \(210000000000\)/);
    assert.match(text, /periods +3 of 3600 seconds each/);
    assert.match(text, /budget +30 USDC \(30000000\)/);
    assert.match(text, /activation price +none/);
    assert.match(
      text,
      new RegExp(
        `period 0 begins +${new Date(Number(startAt) * 1000).toISOString()} \\(Unix ${startAt}\\), ${startAt - result.placedAt} seconds after the block`,
      ),
    );
    const expiry = startAt + 3n * 3_600n - 1n;
    assert.match(
      text,
      new RegExp(
        `last second +${new Date(Number(expiry) * 1000).toISOString()} \\(Unix ${expiry}\\)`,
      ),
    );
    assert.match(
      text,
      /allowance +30 USDC \(30000000\), equal to the open-order total 30 USDC \(30000000\)/,
    );
  });
});
