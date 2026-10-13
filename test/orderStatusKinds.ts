import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, type Hash } from "viem";

import {
  formatOrderReport,
  orderStatus,
  orderStatusSettingsFrom,
} from "../scripts/orderStatus.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { setUpScripts } from "./setUpScripts.ts";

// order-status for each kind of order: a limit order keeps the twelve lines it
// always printed, in the same order, with four more; a dormant order adds
// whether it can be activated now; a Dca order adds its schedule and a Ladder
// order its tiers. Every case runs on a brand-new in-process chain with the
// full set of parts (USDC with 6 decimals, a price feed with 8 decimals at
// 2000 USD, the default limits). Orders are placed straight on the contract by
// the owner, with the executor and the recipient named. The expected numbers
// are written out here, or read from the chain apart from the report.

const DAY = 86_400n;

async function ready() {
  const s = await setUpScripts();
  const parts = await s.withParts();
  return { ...s, ...parts };
}

type Ready = Awaited<ReturnType<typeof ready>>;

function report(s: Ready, orderId: bigint) {
  return orderStatus({
    viem: s.viem,
    settings: orderStatusSettingsFrom({
      [VARIABLES.contractAddress]: s.trigger.address,
      [VARIABLES.orderId]: orderId.toString(),
    }),
  });
}

/** Waits for `hash` and gives back its block's time. */
async function minedAt(s: Ready, hash: Hash): Promise<bigint> {
  const receipt = await s.publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  const block = await s.publicClient.getBlock({
    blockNumber: receipt.blockNumber,
  });
  return block.timestamp;
}

async function latestTime(s: Ready): Promise<bigint> {
  return (await s.publicClient.getBlock({ blockTag: "latest" })).timestamp;
}

/** A Unix time the way the report writes it. */
function written(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString()} (Unix ${seconds})`;
}

async function setPrice(s: Ready, price: bigint) {
  await minedAt(s, await s.feed.write.setAnswer([price]));
}

async function approve(s: Ready, amount: bigint) {
  await minedAt(s, await s.usdc.write.approve([s.trigger.address, amount]));
}

async function fillByExecutor(s: Ready, orderId: bigint) {
  await minedAt(
    s,
    await s.trigger.write.fillOrder([orderId], {
      account: s.executor.account,
    }),
  );
}

/**
 * Places a dormant limit order (100 USDC, target 1900 USD, activation
 * 2100 USD) as the chain's first order, so its ID is 1.
 */
async function placeDormant(s: Ready, validSeconds: bigint) {
  const expiry = (await latestTime(s)) + validSeconds;
  await minedAt(
    s,
    await s.trigger.write.createDormantOrder([
      100_000_000n,
      190_000_000_000n,
      210_000_000_000n,
      s.recipient.account.address,
      s.executor.account.address,
      expiry,
    ]),
  );
  return 1n;
}

/** The label of a printed line: its first 15 characters after the indent. */
function labels(lines: readonly string[]): string[] {
  return lines.slice(1).map((line) => line.slice(2, 17).trimEnd());
}

describe("order-status: the lines of a limit order", () => {
  it("prints the twelve lines it always printed, in the same order, plus kind, remaining, activation none and fills done 0 of 1", async () => {
    const s = await ready();
    const expiry = (await latestTime(s)) + 30n * 60n;
    const placedAt = await minedAt(
      s,
      await s.trigger.write.createOrder([
        12_500_000n,
        199_999_000_000n,
        s.recipient.account.address,
        s.executor.account.address,
        expiry,
      ]),
    );

    const result = await report(s, 1n);
    const lines = formatOrderReport(result);

    const owner = getAddress(s.owner.account.address);
    const executor = getAddress(s.executor.account.address);
    const recipient = getAddress(s.recipient.account.address);
    const twelve = [
      "Order 1:",
      `  owner          ${owner}`,
      `  executor       ${executor}`,
      `  recipient      ${recipient}`,
      "  amount         12.5 USDC (12500000)",
      "  target price   1999.99 USD (199999000000)",
      `  placed at      ${written(placedAt)}`,
      `  expires after  ${written(expiry)}`,
      "  stored status  Open",
      "  status now     Open  (statusOf)",
      "  can fill now   no, reason PriceAboveTarget  (canFill)",
      "  feed price     2000 USD (200000000000)",
    ];
    assert.deepEqual(lines, [
      "Order 1:",
      "  kind           Limit",
      `  owner          ${owner}`,
      `  executor       ${executor}`,
      `  recipient      ${recipient}`,
      "  amount         12.5 USDC (12500000)",
      "  remaining      12.5 USDC (12500000)",
      "  target price   1999.99 USD (199999000000)",
      "  activation     none",
      "  fills done     0 of 1",
      `  placed at      ${written(placedAt)}`,
      `  expires after  ${written(expiry)}`,
      "  stored status  Open",
      "  status now     Open  (statusOf)",
      "  can fill now   no, reason PriceAboveTarget  (canFill)",
      "  feed price     2000 USD (200000000000)",
    ]);
    const added = ["kind", "remaining", "activation", "fills done"];
    const lineLabels = ["", ...labels(lines)];
    assert.deepEqual(
      lines.filter((_line, index) => !added.includes(lineLabels[index] ?? "")),
      twelve,
    );

    assert.equal(result.kind, "Limit");
    assert.equal(result.usdcRemaining, 12_500_000n);
    assert.equal(result.activationPrice, 0n);
    assert.equal(result.fillsDone, 0n);
    assert.equal(result.fillsTotal, 1n);
    assert.equal(result.activation, undefined);
    assert.equal(result.schedule, undefined);
    assert.equal(result.tiers, undefined);
  });
});

describe("order-status: dormant orders", () => {
  it("says a dormant order cannot be activated below its activation price, and can once the price reaches it", async () => {
    const s = await ready();
    const orderId = await placeDormant(s, DAY);

    const below = await report(s, orderId);
    assert.equal(below.kind, "Limit");
    assert.equal(below.storedStatus, "Dormant");
    assert.equal(below.activationPrice, 210_000_000_000n);
    assert.deepEqual(below.activation, {
      activatable: false,
      reason: "PriceBelowActivation",
    });
    assert.equal(below.schedule, undefined);
    assert.equal(below.tiers, undefined);
    const belowLines = formatOrderReport(below);
    assert.ok(belowLines.includes("  activation     2100 USD (210000000000)"));
    assert.deepEqual(labels(belowLines).slice(-3), [
      "can fill now",
      "can activate",
      "feed price",
    ]);
    assert.ok(
      belowLines.includes(
        "  can activate   no, reason PriceBelowActivation  (canActivate)",
      ),
    );

    await setPrice(s, 210_000_000_000n);
    const reached = await report(s, orderId);
    assert.deepEqual(reached.activation, {
      activatable: true,
      reason: "None",
    });
    assert.ok(
      formatOrderReport(reached).includes(
        "  can activate   yes, reason None  (canActivate)",
      ),
    );
  });

  it("says a dormant order past its expiry is stored Dormant, is Expired now and cannot be activated because it expired", async () => {
    const s = await ready();
    const orderId = await placeDormant(s, 60n);
    await s.connection.networkHelpers.time.increase(61);

    const result = await report(s, orderId);

    assert.equal(result.storedStatus, "Dormant");
    assert.equal(result.status, "Expired");
    assert.deepEqual(result.activation, {
      activatable: false,
      reason: "Expired",
    });
    const lines = formatOrderReport(result);
    assert.ok(lines.includes("  stored status  Dormant"));
    assert.ok(lines.includes("  status now     Expired  (statusOf)"));
    assert.ok(
      lines.includes("  can activate   no, reason Expired  (canActivate)"),
    );
  });

  it("drops the can-activate line once the order is activated, and still shows its activation price", async () => {
    const s = await ready();
    const orderId = await placeDormant(s, DAY);
    await setPrice(s, 210_000_000_000n);
    await minedAt(
      s,
      await s.trigger.write.activateOrder([orderId], {
        account: s.executor.account,
      }),
    );

    const result = await report(s, orderId);

    assert.equal(result.storedStatus, "Open");
    assert.equal(result.activation, undefined);
    const lines = formatOrderReport(result);
    assert.equal(labels(lines).includes("can activate"), false);
    assert.ok(lines.includes("  activation     2100 USD (210000000000)"));
  });
});

describe("order-status: a Dca order's schedule", () => {
  it("shows the kind, one fill of three done, the remaining budget and the four schedule lines after the first period is bought", async () => {
    const s = await ready();
    await approve(s, 30_000_000n);
    const placedAt = await minedAt(
      s,
      await s.trigger.write.createDcaOrder([
        {
          usdcPerPeriod: 10_000_000n,
          targetPrice: 210_000_000_000n,
          periodLength: DAY,
          periodCount: 3n,
          startAt: 0n,
          activationPrice: 0n,
          recipient: s.recipient.account.address,
          executor: s.executor.account.address,
        },
      ]),
    );
    await fillByExecutor(s, 1n);

    const result = await report(s, 1n);

    assert.equal(result.kind, "Dca");
    assert.equal(result.usdcAmount, 30_000_000n);
    assert.equal(result.usdcRemaining, 20_000_000n);
    assert.equal(result.fillsDone, 1n);
    assert.equal(result.fillsTotal, 3n);
    assert.equal(result.activation, undefined);
    assert.equal(result.tiers, undefined);
    assert.deepEqual(result.schedule, {
      startAt: placedAt,
      periodLength: DAY,
      usdcPerPeriod: 10_000_000n,
      filledThrough: 1n,
    });
    const schedule = await s.trigger.read.getSchedule([1n]);
    assert.deepEqual(result.schedule, {
      startAt: schedule.startAt,
      periodLength: schedule.periodLength,
      usdcPerPeriod: schedule.usdcPerPeriod,
      filledThrough: schedule.filledThrough,
    });
    const lines = formatOrderReport(result);
    assert.ok(lines.includes("  kind           Dca"));
    assert.ok(lines.includes("  remaining      20 USDC (20000000)"));
    assert.ok(lines.includes("  fills done     1 of 3"));
    assert.deepEqual(lines.slice(-5), [
      "  feed price     2000 USD (200000000000)",
      "  per period     10 USDC (10000000)",
      "  period length  86400 seconds",
      `  period 0 from  ${written(placedAt)}`,
      "  next period    1 (earliest period a fill can buy)",
    ]);
  });
});

describe("order-status: a Ladder order's tiers", () => {
  it("shows the kind, one line per tier with tier 0 filled and the others not, and one fill of three done", async () => {
    const s = await ready();
    await approve(s, 45_000_000n);
    const expiry = (await latestTime(s)) + DAY;
    await minedAt(
      s,
      await s.trigger.write.createLadderOrder([
        {
          tiers: [
            { price: 200_000_000_000n, usdcAmount: 10_000_000n },
            { price: 195_000_000_000n, usdcAmount: 15_000_000n },
            { price: 190_000_000_000n, usdcAmount: 20_000_000n },
          ],
          activationPrice: 0n,
          recipient: s.recipient.account.address,
          executor: s.executor.account.address,
          expiry,
        },
      ]),
    );
    await fillByExecutor(s, 1n);

    const result = await report(s, 1n);

    assert.equal(result.kind, "Ladder");
    assert.equal(result.usdcAmount, 45_000_000n);
    assert.equal(result.usdcRemaining, 35_000_000n);
    assert.equal(result.fillsDone, 1n);
    assert.equal(result.fillsTotal, 3n);
    assert.equal(result.activation, undefined);
    assert.equal(result.schedule, undefined);
    assert.deepEqual(result.tiers, [
      { price: 200_000_000_000n, usdcAmount: 10_000_000n },
      { price: 195_000_000_000n, usdcAmount: 15_000_000n },
      { price: 190_000_000_000n, usdcAmount: 20_000_000n },
    ]);
    const lines = formatOrderReport(result);
    assert.ok(lines.includes("  kind           Ladder"));
    assert.ok(lines.includes("  fills done     1 of 3"));
    assert.deepEqual(lines.slice(-4), [
      "  feed price     2000 USD (200000000000)",
      "  tier 0         10 USDC (10000000) at no more than 2000 USD (200000000000), filled",
      "  tier 1         15 USDC (15000000) at no more than 1950 USD (195000000000), not filled",
      "  tier 2         20 USDC (20000000) at no more than 1900 USD (190000000000), not filled",
    ]);
  });
});
