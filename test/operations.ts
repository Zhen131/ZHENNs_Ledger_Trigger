import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  cancelOrder,
  cancelOrderSettingsFrom,
} from "../scripts/cancelOrder.ts";
import { fundVenue, fundVenueSettingsFrom } from "../scripts/fundVenue.ts";
import {
  formatOrderReport,
  orderStatus,
  orderStatusSettingsFrom,
} from "../scripts/orderStatus.ts";
import { placeOrder, placeOrderSettingsFrom } from "../scripts/placeOrder.ts";
import {
  ScriptError,
  describeFailure,
  revertName,
} from "../scripts/scriptError.ts";
import { VARIABLES } from "../scripts/settings.ts";
import {
  formatPriceSet,
  setMockPrice,
  setPriceSettingsFrom,
} from "../scripts/setMockPrice.ts";
import { setUpScripts } from "./setUpScripts.ts";

// Every operation runs on a brand-new in-process chain with the full set of
// parts deployed directly by the test. Inputs are written the way a person
// writes them; the whole numbers they must turn into are worked out here.

type Scripts = Awaited<ReturnType<typeof setUpScripts>>;
type Parts = Awaited<ReturnType<Scripts["withParts"]>>;

async function ready() {
  const s = await setUpScripts();
  const parts = await s.withParts();
  return { ...s, ...parts };
}

/** The place-order variables, with `changes` on top. */
function orderEnv(
  s: Scripts & Parts,
  changes: Record<string, string> = {},
): Record<string, string> {
  return {
    [VARIABLES.contractAddress]: s.trigger.address,
    [VARIABLES.orderUsdc]: "12.5",
    [VARIABLES.targetPriceUsd]: "1999.99",
    [VARIABLES.expiryMinutes]: "30",
    [VARIABLES.recipientAddress]: s.recipient.account.address,
    [VARIABLES.executorAddress]: s.executor.account.address,
    ...changes,
  };
}

async function place(s: Scripts & Parts, changes: Record<string, string> = {}) {
  return placeOrder({
    viem: s.viem,
    confirmation: undefined,
    settings: placeOrderSettingsFrom(orderEnv(s, changes)),
  });
}

describe("place-order", () => {
  it("places the order with the amount, target and expiry worked out from the human-readable input", async () => {
    const s = await ready();
    const latest = await s.publicClient.getBlock({ blockTag: "latest" });

    const placed = await place(s);

    const order = await s.trigger.read.getOrder([placed.orderId]);
    assert.equal(order.owner, getAddress(s.owner.account.address));
    assert.equal(order.recipient, getAddress(s.recipient.account.address));
    assert.equal(order.executor, getAddress(s.executor.account.address));
    // 12.5 USDC with 6 decimals; 1999.99 USD with 8 decimals; 30 minutes.
    assert.equal(order.usdcAmount, 12_500_000n);
    assert.equal(order.targetPrice, 199_999_000_000n);
    assert.equal(order.expiry, latest.timestamp + 30n * 60n);
    assert.equal(order.status, 1);
    assert.equal(placed.orderId, 1n);
  });

  it("sets the allowance to the owner's open-order total after the order, each time", async () => {
    const s = await ready();
    const allowance = () =>
      s.usdc.read.allowance([s.owner.account.address, s.trigger.address]);

    const first = await place(s);
    assert.equal(await allowance(), 12_500_000n);
    assert.equal(
      await s.trigger.read.openOrderTotal([s.owner.account.address]),
      12_500_000n,
    );
    assert.equal(first.allowance, 12_500_000n);
    assert.equal(first.openOrderTotal, 12_500_000n);

    const second = await place(s, { [VARIABLES.orderUsdc]: "7.25" });
    assert.equal(await allowance(), 19_750_000n);
    assert.equal(
      await s.trigger.read.openOrderTotal([s.owner.account.address]),
      19_750_000n,
    );
    assert.equal(second.allowance, second.openOrderTotal);
  });

  for (const [name, value] of [
    [VARIABLES.orderUsdc, "12.1234567"],
    [VARIABLES.orderUsdc, "-1"],
    [VARIABLES.targetPriceUsd, "2000.123456789"],
    [VARIABLES.targetPriceUsd, "1,999"],
  ] as const) {
    it(`sends nothing when ${name} is ${value}, and names the variable`, async () => {
      const s = await ready();
      const before = await s.blockNumber();
      await assert.rejects(
        place(s, { [name]: value }),
        (error) =>
          error instanceof ScriptError && error.message.startsWith(name),
      );
      assert.equal(await s.blockNumber(), before);
    });
  }

  it("names every missing variable it needs", () => {
    for (const name of [
      VARIABLES.contractAddress,
      VARIABLES.orderUsdc,
      VARIABLES.targetPriceUsd,
      VARIABLES.expiryMinutes,
      VARIABLES.recipientAddress,
      VARIABLES.executorAddress,
    ]) {
      const env: Record<string, string> = {
        [VARIABLES.contractAddress]:
          privateKeyToAccount(generatePrivateKey()).address,
        [VARIABLES.orderUsdc]: "1",
        [VARIABLES.targetPriceUsd]: "1",
        [VARIABLES.expiryMinutes]: "1",
        [VARIABLES.recipientAddress]:
          privateKeyToAccount(generatePrivateKey()).address,
        [VARIABLES.executorAddress]:
          privateKeyToAccount(generatePrivateKey()).address,
      };
      delete env[name];
      assert.throws(
        () => placeOrderSettingsFrom(env),
        (error) =>
          error instanceof ScriptError &&
          error.message === `${name} is required and not set.`,
      );
    }
  });

  it("sends nothing when nothing is deployed at the contract address, and says so", async () => {
    const s = await ready();
    const before = await s.blockNumber();
    await assert.rejects(
      place(s, {
        [VARIABLES.contractAddress]:
          privateKeyToAccount(generatePrivateKey()).address,
      }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(`${VARIABLES.contractAddress} (`) &&
        error.message.includes("holds no contract code"),
    );
    assert.equal(await s.blockNumber(), before);
  });
});

describe("cancel-order", () => {
  it("cancels the order: Open -> Cancelled", async () => {
    const s = await ready();
    const { orderId } = await place(s);

    const result = await cancelOrder({
      viem: s.viem,
      confirmation: undefined,
      settings: cancelOrderSettingsFrom({
        [VARIABLES.contractAddress]: s.trigger.address,
        [VARIABLES.orderId]: orderId.toString(),
      }),
    });

    assert.deepEqual(result, {
      orderId,
      statusBefore: "Open",
      statusAfter: "Cancelled",
    });
    assert.equal(await s.trigger.read.statusOf([orderId]), 3);
  });

  it("reports the contract's error by name when the order is already cancelled", async () => {
    const s = await ready();
    const { orderId } = await place(s);
    const settings = cancelOrderSettingsFrom({
      [VARIABLES.contractAddress]: s.trigger.address,
      [VARIABLES.orderId]: orderId.toString(),
    });
    await cancelOrder({ viem: s.viem, confirmation: undefined, settings });

    await assert.rejects(
      cancelOrder({ viem: s.viem, confirmation: undefined, settings }),
      (error) =>
        revertName(error) === "OrderNotOpen" &&
        describeFailure(error).startsWith(
          "The contract rejected the call with OrderNotOpen(",
        ),
    );
  });
});

describe("fund-venue", () => {
  it("raises the swap venue's balance by exactly the ETH sent", async () => {
    const s = await ready();
    const before = await s.publicClient.getBalance({
      address: s.venue.address,
    });

    const result = await fundVenue({
      viem: s.viem,
      confirmation: undefined,
      settings: fundVenueSettingsFrom({
        [VARIABLES.contractAddress]: s.trigger.address,
        [VARIABLES.fundEth]: "0.75",
      }),
    });

    const after = await s.publicClient.getBalance({ address: s.venue.address });
    assert.equal(after - before, 750_000_000_000_000_000n);
    assert.equal(result.venue, getAddress(s.venue.address));
    assert.equal(result.sent, 750_000_000_000_000_000n);
    assert.equal(result.after - result.before, result.sent);
  });

  it("refuses to send nothing", () => {
    assert.throws(
      () =>
        fundVenueSettingsFrom({
          [VARIABLES.contractAddress]:
            privateKeyToAccount(generatePrivateKey()).address,
          [VARIABLES.fundEth]: "0",
        }),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith(VARIABLES.fundEth),
    );
  });
});

describe("order-status", () => {
  it("names the status and the canFill reason as the order moves along", async () => {
    const s = await ready();
    const { orderId } = await place(s, { [VARIABLES.targetPriceUsd]: "1900" });
    const settings = orderStatusSettingsFrom({
      [VARIABLES.contractAddress]: s.trigger.address,
      [VARIABLES.orderId]: orderId.toString(),
    });
    const read = () => orderStatus({ viem: s.viem, settings });

    const above = await read();
    assert.equal(above.status, "Open");
    assert.equal(above.storedStatus, "Open");
    assert.equal(above.fillable, false);
    assert.equal(above.reason, "PriceAboveTarget");
    assert.equal(above.usdcAmount, 12_500_000n);
    assert.equal(above.targetPrice, 190_000_000_000n);
    assert.equal(above.latestPrice, 200_000_000_000n);

    await s.feed.write.setAnswer([190_000_000_000n]);
    const atTarget = await read();
    assert.equal(atTarget.fillable, true);
    assert.equal(atTarget.reason, "None");

    const text = formatOrderReport(atTarget).join("\n");
    assert.match(text, /amount +12\.5 USDC \(12500000\)/);
    assert.match(text, /target price +1900 USD \(190000000000\)/);
    assert.match(text, /status now +Open/);
    assert.match(text, /can fill now +yes, reason None/);

    await cancelOrder({
      viem: s.viem,
      confirmation: undefined,
      settings: cancelOrderSettingsFrom({
        [VARIABLES.contractAddress]: s.trigger.address,
        [VARIABLES.orderId]: orderId.toString(),
      }),
    });
    const cancelled = await read();
    assert.equal(cancelled.status, "Cancelled");
    assert.equal(cancelled.reason, "NotOpen");
  });

  it("names an order past its expiry Expired, while its stored status stays Open", async () => {
    const s = await ready();
    const { orderId } = await place(s, { [VARIABLES.expiryMinutes]: "1" });
    await s.connection.networkHelpers.time.increase(61);

    const report = await orderStatus({
      viem: s.viem,
      settings: orderStatusSettingsFrom({
        [VARIABLES.contractAddress]: s.trigger.address,
        [VARIABLES.orderId]: orderId.toString(),
      }),
    });

    assert.equal(report.status, "Expired");
    assert.equal(report.storedStatus, "Open");
    assert.equal(report.reason, "Expired");
  });
});

describe("set-price", () => {
  it("sets the mock feed to the price given, read back from the feed", async () => {
    const s = await ready();

    const result = await setMockPrice({
      viem: s.viem,
      confirmation: undefined,
      settings: setPriceSettingsFrom({
        [VARIABLES.contractAddress]: s.trigger.address,
        [VARIABLES.priceUsd]: "1950.5",
      }),
    });

    const [, answer] = await s.feed.read.latestRoundData();
    assert.equal(answer, 195_050_000_000n);
    assert.equal(result.sent, 195_050_000_000n);
    assert.equal(result.readBack, 195_050_000_000n);
    assert.equal(result.feed, getAddress(s.feed.address));
    assert.match(formatPriceSet(result).join("\n"), /now reports 1950\.5 USD/);
  });
});
