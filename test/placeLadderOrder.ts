import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import {
  formatPlacedLadderOrder,
  placeLadderOrder,
  placeLadderOrderSettingsFrom,
  tiersFrom,
} from "../scripts/placeLadderOrder.ts";
import {
  ScriptError,
  describeFailure,
  revertName,
} from "../scripts/scriptError.ts";
import { VARIABLES, type Environment } from "../scripts/settings.ts";
import { setUpScripts } from "./setUpScripts.ts";

// place-ladder-order places a Ladder order from the first account, after
// simulating it and setting the allowance to the owner's open total plus the
// order's budget. The parts are deployed with the default limits: at most
// 500 USDC per fill, 5 open orders per owner and 5 tiers per order; USDC has
// 6 decimals and the price feed 8.

const KIND_LADDER = 2;
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
    [VARIABLES.tiers]: "2000:10,1900:15,1800:20",
    [VARIABLES.expiryMinutes]: "60",
    [VARIABLES.recipientAddress]: s.recipient.account.address,
    [VARIABLES.executorAddress]: s.executor.account.address,
    ...changes,
  };
}

function place(s: Ready, changes: Environment = {}) {
  return placeLadderOrder({
    viem: s.viem,
    confirmation: undefined,
    settings: placeLadderOrderSettingsFrom(variables(s, changes)),
  });
}

function allowance(s: Ready) {
  return s.usdc.read.allowance([s.owner.account.address, s.trigger.address]);
}

/** The latest block's time. */
async function latestTime(s: Ready): Promise<bigint> {
  return (await s.publicClient.getBlock({ blockTag: "latest" })).timestamp;
}

describe("place-ladder-order: places the order it is given", () => {
  it("turns prices in USD and amounts in USDC written with decimals and spaces into the order and the tiers the contract stores, and sets the expiry from the latest block", async () => {
    const s = await ready();
    const latest = await latestTime(s);

    const result = await place(s, {
      [VARIABLES.tiers]: " 2000.5 : 12.5 ,1900.25:7 , 1899.12345678 :0.000001 ",
      [VARIABLES.expiryMinutes]: " 90 ",
    });

    const tiers = [
      { price: 200_050_000_000n, usdcAmount: 12_500_000n },
      { price: 190_025_000_000n, usdcAmount: 7_000_000n },
      { price: 189_912_345_678n, usdcAmount: 1n },
    ];
    const budget = 19_500_001n;
    const order = await s.trigger.read.getOrder([result.orderId]);
    assert.equal(order.kind, KIND_LADDER);
    assert.equal(order.status, STATUS_OPEN);
    assert.equal(order.owner, getAddress(s.owner.account.address));
    assert.equal(order.recipient, getAddress(s.recipient.account.address));
    assert.equal(order.executor, getAddress(s.executor.account.address));
    assert.equal(order.usdcAmount, budget);
    assert.equal(order.targetPrice, 200_050_000_000n);
    assert.equal(order.activationPrice, 0n);
    assert.equal(order.fillsTotal, 3n);
    assert.equal(order.expiry, latest + 90n * 60n);
    assert.deepEqual(await s.trigger.read.getTiers([result.orderId]), tiers);
    assert.deepEqual(result.tiers, tiers);
    assert.equal(result.usdcAmount, budget);
    assert.equal(result.expiry, latest + 90n * 60n);
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

    const budget = 45_000_000n;
    assert.equal(await allowance(s), openBefore + budget);
    assert.equal(result.allowance, openBefore + budget);
    assert.equal(result.openOrderTotal, openBefore + budget);
    assert.equal(result.allowance, result.openOrderTotal);
    assert.equal(result.usdcAmount, budget);
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
    assert.equal(dormant.activationPrice, 225_050_000_000n);
    const awake = await s.trigger.read.getOrder([open.orderId]);
    assert.equal(awake.status, STATUS_OPEN);
    assert.equal(awake.activationPrice, 0n);
    assert.equal(open.status, "Open");
  });
});

describe("place-ladder-order: simulates the order before it approves", () => {
  for (const [label, changes, error] of [
    [
      "a tier above the largest fill",
      { [VARIABLES.tiers]: "2000:10,1900:600" },
      "AmountAboveMax",
    ],
    [
      "one tier more than allowed",
      { [VARIABLES.tiers]: "2000:1,1999:1,1998:1,1997:1,1996:1,1995:1" },
      "TooManyTiers",
    ],
    [
      "prices that do not fall",
      { [VARIABLES.tiers]: "2000:10,2000:15" },
      "TiersNotDescending",
    ],
    [
      "an activation price not above the first tier",
      { [VARIABLES.activationPriceUsd]: "2000" },
      "ActivationNotAboveTarget",
    ],
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
    assert.equal(await allowance(s), 225_000_000n);
    const blockBefore = await s.blockNumber();

    await assert.rejects(
      place(s),
      (failure) => revertName(failure) === "TooManyOpenOrders",
    );

    assert.equal(await s.blockNumber(), blockBefore);
    assert.equal(await allowance(s), 225_000_000n);
  });
});

describe("place-ladder-order: tiers it cannot read", () => {
  const badTiers: readonly (readonly [string, string, number, string])[] = [
    ["two commas in a row", "2000:10,,1900:15", 1, "is empty"],
    ["a comma at the end", "2000:10,1900:15,", 2, "is empty"],
    ["a tier with no colon", "2000:10,1900", 1, "exactly one colon"],
    ["a tier with two colons", "2000:10:5,1900:15", 0, "exactly one colon"],
    [
      "a price with too many digits after the dot",
      "2000:10,1900.123456789:15",
      1,
      "digits after the dot",
    ],
    [
      "an amount with too many digits after the dot",
      "2000:10.1234567,1900:15",
      0,
      "digits after the dot",
    ],
    ["a negative amount", "2000:10,1900:-15", 1, "plain number"],
    ["a price that is not a number", "2000:10,cheap:15", 1, "plain number"],
    ["an empty amount", "2000:,1900:15", 0, "plain number"],
  ];
  for (const [label, value, index, words] of badTiers) {
    it(`stops before sending anything for ${label}, and names the variable and tier ${index}`, async () => {
      const s = await ready();
      const blockBefore = await s.blockNumber();

      await assert.rejects(
        async () => place(s, { [VARIABLES.tiers]: value }),
        (failure) =>
          failure instanceof ScriptError &&
          failure.message.startsWith(`${VARIABLES.tiers} tier ${index} `) &&
          failure.message.includes(words) &&
          !failure.message.includes(value),
      );

      assert.equal(await s.blockNumber(), blockBefore);
      assert.equal(await allowance(s), 0n);
    });
  }

  it("reads the tiers in the order they are written, ignoring the spaces around each tier and each number", () => {
    assert.deepEqual(tiersFrom(" 2000 : 10 , 1900.5:2.5"), [
      { priceUsd: "2000", usdc: "10" },
      { priceUsd: "1900.5", usdc: "2.5" },
    ]);
  });
});

describe("place-ladder-order: settings it cannot use", () => {
  const badValues: readonly (readonly [string, string, string])[] = [
    [VARIABLES.expiryMinutes, "0", "whole number of at least 1"],
    [VARIABLES.expiryMinutes, "1.5", "whole number of at least 1"],
    [VARIABLES.activationPriceUsd, "-1", "plain number"],
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
    VARIABLES.tiers,
    VARIABLES.expiryMinutes,
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

  it("takes TRIGGER_TIERS holding only spaces as not set, and treats TRIGGER_ACTIVATION_PRICE_USD as optional", () => {
    assert.throws(
      () =>
        placeLadderOrderSettingsFrom({
          ...variablesWithoutChain(),
          [VARIABLES.tiers]: "   ",
        }),
      (failure) =>
        failure instanceof ScriptError &&
        failure.message === `${VARIABLES.tiers} is required and not set.`,
    );
    const unset = placeLadderOrderSettingsFrom(variablesWithoutChain());
    assert.equal(unset.activationPriceUsd, undefined);
  });
});

/** Settings that need no chain, with fixed addresses. */
function variablesWithoutChain(): Environment {
  return {
    [VARIABLES.contractAddress]: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    [VARIABLES.tiers]: "2000:10,1900:15",
    [VARIABLES.expiryMinutes]: "60",
    [VARIABLES.recipientAddress]: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    [VARIABLES.executorAddress]: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  };
}

describe("place-ladder-order: what it prints", () => {
  it("prints the order ID, the status, every tier with its price and amount, the budget, the activation price, the expiry and the allowance", async () => {
    const s = await ready();
    const result = await place(s, {
      [VARIABLES.activationPriceUsd]: "2100",
    });

    const lines = formatPlacedLadderOrder(result);

    const text = lines.join("\n");
    assert.match(
      lines[0] ?? "",
      new RegExp(
        `^Placed Ladder order ${result.orderId} from account .+, now Dormant\\.$`,
      ),
    );
    assert.match(
      text,
      /tier 0 +10 USDC \(10000000\) at no more than 2000 USD \(200000000000\)/,
    );
    assert.match(
      text,
      /tier 1 +15 USDC \(15000000\) at no more than 1900 USD \(190000000000\)/,
    );
    assert.match(
      text,
      /tier 2 +20 USDC \(20000000\) at no more than 1800 USD \(180000000000\)/,
    );
    assert.match(text, /budget +45 USDC \(45000000\)/);
    assert.match(text, /activation price +2100 USD \(210000000000\)/);
    assert.match(
      text,
      new RegExp(
        `expiry +${new Date(Number(result.expiry) * 1000).toISOString()} \\(Unix ${result.expiry}\\)`,
      ),
    );
    assert.match(
      text,
      /allowance +45 USDC \(45000000\), equal to the open-order total 45 USDC \(45000000\)/,
    );
  });
});
