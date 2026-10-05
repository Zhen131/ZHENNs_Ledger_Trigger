import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cancelOrderSettingsFrom,
  cancelOrder,
} from "../scripts/cancelOrder.ts";
import {
  deploySettingsFrom,
  deployWithExternalParts,
  deployWithMocks,
  mockSettingsFrom,
} from "../scripts/deploy.ts";
import { fundVenue, fundVenueSettingsFrom } from "../scripts/fundVenue.ts";
import { placeOrder, placeOrderSettingsFrom } from "../scripts/placeOrder.ts";
import { ScriptError } from "../scripts/scriptError.ts";
import { CONFIRM_PHRASE, LOCAL_CHAIN_ID } from "../scripts/sendGate.ts";
import { VARIABLES } from "../scripts/settings.ts";
import { setMockPrice, setPriceSettingsFrom } from "../scripts/setMockPrice.ts";
import { setUpScripts } from "./setUpScripts.ts";

// Each script that sends transactions is run on an in-process chain that
// reports a chain ID other than Hardhat's local one (999). Nothing here
// connects to any network. The demo's own gate tests are in demo.ts.

const NOT_LOCAL = 999;

type Ready = Awaited<ReturnType<typeof ready>>;

async function ready(chainId: number) {
  const s = await setUpScripts({ chainId });
  const parts = await s.withParts();
  const latest = await s.publicClient.getBlock({ blockTag: "latest" });
  await s.publicClient.waitForTransactionReceipt({
    hash: await parts.trigger.write.createOrder(
      [
        1_000_000n,
        200_000_000_000n,
        s.recipient.account.address,
        s.executor.account.address,
        latest.timestamp + 3_600n,
      ],
      { account: s.owner.account },
    ),
  });
  return { ...s, ...parts };
}

/** Each sending script, run with `confirmation` on the chain of `s`. */
const SCRIPTS: readonly (readonly [
  string,
  (s: Ready, confirmation: string | undefined) => Promise<unknown>,
])[] = [
  [
    "deploy with mock parts",
    (s, confirmation) =>
      deployWithMocks({
        viem: s.viem,
        confirmation,
        settings: deploySettingsFrom({}),
        mocks: mockSettingsFrom({}),
      }),
  ],
  [
    "deploy with external parts",
    (s, confirmation) =>
      deployWithExternalParts({
        viem: s.viem,
        confirmation,
        settings: deploySettingsFrom({}),
        usdc: s.usdc.address,
        priceFeed: s.feed.address,
      }),
  ],
  [
    "place-order",
    (s, confirmation) =>
      placeOrder({
        viem: s.viem,
        confirmation,
        settings: placeOrderSettingsFrom({
          [VARIABLES.contractAddress]: s.trigger.address,
          [VARIABLES.orderUsdc]: "1",
          [VARIABLES.targetPriceUsd]: "2000",
          [VARIABLES.expiryMinutes]: "10",
          [VARIABLES.recipientAddress]: s.recipient.account.address,
          [VARIABLES.executorAddress]: s.executor.account.address,
        }),
      }),
  ],
  [
    "cancel-order",
    (s, confirmation) =>
      cancelOrder({
        viem: s.viem,
        confirmation,
        settings: cancelOrderSettingsFrom({
          [VARIABLES.contractAddress]: s.trigger.address,
          [VARIABLES.orderId]: "1",
        }),
      }),
  ],
  [
    "fund-venue",
    (s, confirmation) =>
      fundVenue({
        viem: s.viem,
        confirmation,
        settings: fundVenueSettingsFrom({
          [VARIABLES.contractAddress]: s.trigger.address,
          [VARIABLES.fundEth]: "0.1",
        }),
      }),
  ],
  [
    "set-price",
    (s, confirmation) =>
      setMockPrice({
        viem: s.viem,
        confirmation,
        settings: setPriceSettingsFrom({
          [VARIABLES.contractAddress]: s.trigger.address,
          [VARIABLES.priceUsd]: "1900",
        }),
      }),
  ],
];

const LOCAL_ONLY = new Set(["set-price", "deploy with mock parts"]);

async function assertRefusedAndNothingSent(
  s: Ready,
  run: Promise<unknown>,
  reason: RegExp,
) {
  const before = await s.blockNumber();
  await assert.rejects(
    run,
    (error) => error instanceof ScriptError && reason.test(error.message),
  );
  assert.equal(await s.blockNumber(), before);
}

describe("send gate in every script that sends", () => {
  for (const [name, run] of SCRIPTS) {
    it(`${name}: on a chain that is not local, sends nothing without the confirmation`, async () => {
      const s = await ready(NOT_LOCAL);
      await assertRefusedAndNothingSent(
        s,
        run(s, undefined),
        LOCAL_ONLY.has(name) ? /local chain only/ : /Nothing was sent/,
      );
    });

    it(`${name}: on a chain that is not local, sends nothing with a wrong confirmation`, async () => {
      const s = await ready(NOT_LOCAL);
      await assertRefusedAndNothingSent(
        s,
        run(s, `${CONFIRM_PHRASE}!`),
        LOCAL_ONLY.has(name) ? /local chain only/ : /Nothing was sent/,
      );
    });

    if (LOCAL_ONLY.has(name)) {
      it(`${name}: on a chain that is not local, still sends nothing with the exact confirmation`, async () => {
        const s = await ready(NOT_LOCAL);
        await assertRefusedAndNothingSent(
          s,
          run(s, CONFIRM_PHRASE),
          /local chain only/,
        );
      });
    } else {
      it(`${name}: on a chain that is not local, sends once the confirmation holds the exact sentence`, async () => {
        const s = await ready(NOT_LOCAL);
        const before = await s.blockNumber();
        await run(s, CONFIRM_PHRASE);
        assert.ok((await s.blockNumber()) > before);
      });
    }

    it(`${name}: on Hardhat's local chain, sends without any confirmation`, async () => {
      const s = await ready(LOCAL_CHAIN_ID);
      const before = await s.blockNumber();
      await run(s, undefined);
      assert.ok((await s.blockNumber()) > before);
    });
  }
});
