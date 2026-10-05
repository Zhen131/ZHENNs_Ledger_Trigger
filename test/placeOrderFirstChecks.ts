import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeOrder, placeOrderSettingsFrom } from "../scripts/placeOrder.ts";
import { describeFailure, revertName } from "../scripts/scriptError.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { setUpScripts } from "./setUpScripts.ts";

// place-order simulates the order before it sends anything: an order the
// contract would reject leaves no allowance behind and sends no transaction.
// The parts are deployed with the default limits: at most 500 USDC per order
// and 5 open orders per owner.

async function ready() {
  const s = await setUpScripts();
  const parts = await s.withParts();
  return { ...s, ...parts };
}

type Ready = Awaited<ReturnType<typeof ready>>;

function place(s: Ready, usdc: string) {
  return placeOrder({
    viem: s.viem,
    confirmation: undefined,
    settings: placeOrderSettingsFrom({
      [VARIABLES.contractAddress]: s.trigger.address,
      [VARIABLES.orderUsdc]: usdc,
      [VARIABLES.targetPriceUsd]: "1900",
      [VARIABLES.expiryMinutes]: "30",
      [VARIABLES.recipientAddress]: s.recipient.account.address,
      [VARIABLES.executorAddress]: s.executor.account.address,
    }),
  });
}

function allowance(s: Ready) {
  return s.usdc.read.allowance([s.owner.account.address, s.trigger.address]);
}

describe("place-order: simulates the order before it approves", () => {
  it("sends nothing and leaves the allowance alone for an order above the largest order", async () => {
    const s = await ready();
    const blockBefore = await s.blockNumber();

    await assert.rejects(
      place(s, "600"),
      (error) =>
        revertName(error) === "AmountAboveMax" &&
        describeFailure(error).startsWith(
          "The contract rejected the call with AmountAboveMax(",
        ),
    );

    assert.equal(await s.blockNumber(), blockBefore);
    assert.equal(await allowance(s), 0n);
  });

  it("sends nothing and leaves the allowance at the open-order total for a sixth open order", async () => {
    const s = await ready();
    for (let i = 0; i < 5; i += 1) await place(s, "10");
    assert.equal(await allowance(s), 50_000_000n);
    const blockBefore = await s.blockNumber();

    await assert.rejects(
      place(s, "10"),
      (error) => revertName(error) === "TooManyOpenOrders",
    );

    assert.equal(await s.blockNumber(), blockBefore);
    assert.equal(await allowance(s), 50_000_000n);
    assert.equal(
      await s.trigger.read.openOrderTotal([s.owner.account.address]),
      50_000_000n,
    );
  });
});
