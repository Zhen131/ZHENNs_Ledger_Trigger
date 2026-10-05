import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ScriptError } from "../scripts/scriptError.ts";
import {
  CONFIRM_PHRASE,
  CONFIRM_VARIABLE,
  GatedScript,
  LOCAL_CHAIN_ID,
  checkSendGate,
  passSendGate,
} from "../scripts/sendGate.ts";

// The gate is tested with chain IDs and confirmation values passed in
// directly; nothing here connects to any network.

const ALL_SCRIPTS = Object.values(GatedScript);
const CONFIRMABLE = [
  GatedScript.Deploy,
  GatedScript.PlaceOrder,
  GatedScript.CancelOrder,
  GatedScript.FundVenue,
];
const NEVER_ELSEWHERE = [GatedScript.Demo, GatedScript.SetPrice];

/** Chain IDs that are not Hardhat's local chain: Sepolia, mainnet, made up. */
const OTHER_CHAINS = [11_155_111, 1, 999];

describe("send gate: the decision", () => {
  it("lists exactly the six scripts that send transactions", () => {
    assert.deepEqual([...ALL_SCRIPTS].sort(), [
      "cancel-order",
      "demo",
      "deploy",
      "fund-venue",
      "place-order",
      "set-price",
    ]);
    assert.deepEqual(
      [...CONFIRMABLE, ...NEVER_ELSEWHERE].sort(),
      [...ALL_SCRIPTS].sort(),
    );
  });

  for (const script of ALL_SCRIPTS) {
    it(`lets ${script} send on Hardhat's local chain, with or without the confirmation`, () => {
      for (const confirmation of [undefined, "", "wrong", CONFIRM_PHRASE]) {
        assert.deepEqual(
          checkSendGate({ script, chainId: LOCAL_CHAIN_ID, confirmation }),
          { allowed: true },
        );
      }
    });

    it(`refuses ${script} on any other chain when the confirmation is not set`, () => {
      for (const chainId of OTHER_CHAINS) {
        for (const confirmation of [undefined, ""]) {
          const decision = checkSendGate({ script, chainId, confirmation });
          assert.equal(decision.allowed, false);
          assert.ok(
            !decision.allowed && decision.reason.includes("Nothing was sent"),
          );
        }
      }
    });

    it(`refuses ${script} on any other chain when the confirmation is not the exact sentence`, () => {
      const nearMisses = [
        "yes",
        CONFIRM_PHRASE.toLowerCase(),
        `${CONFIRM_PHRASE}.`,
        `${CONFIRM_PHRASE} `,
        CONFIRM_PHRASE.replace(" ", "  "),
      ];
      for (const chainId of OTHER_CHAINS) {
        for (const confirmation of nearMisses) {
          assert.equal(
            checkSendGate({ script, chainId, confirmation }).allowed,
            false,
          );
        }
      }
    });
  }

  for (const script of CONFIRMABLE) {
    it(`lets ${script} send on another chain once the confirmation holds the exact sentence`, () => {
      for (const chainId of OTHER_CHAINS) {
        assert.deepEqual(
          checkSendGate({ script, chainId, confirmation: CONFIRM_PHRASE }),
          { allowed: true },
        );
      }
    });
  }

  for (const script of NEVER_ELSEWHERE) {
    it(`refuses ${script} on another chain even with the exact sentence`, () => {
      for (const chainId of OTHER_CHAINS) {
        const decision = checkSendGate({
          script,
          chainId,
          confirmation: CONFIRM_PHRASE,
        });
        assert.equal(decision.allowed, false);
        assert.ok(
          !decision.allowed && decision.reason.includes("local chain only"),
        );
      }
    });
  }

  it("names the variable to set, but not the sentence itself, when it refuses", () => {
    const decision = checkSendGate({
      script: GatedScript.Deploy,
      chainId: 11_155_111,
      confirmation: undefined,
    });
    assert.ok(!decision.allowed);
    assert.ok(!decision.allowed && decision.reason.includes(CONFIRM_VARIABLE));
    assert.ok(!decision.allowed && !decision.reason.includes(CONFIRM_PHRASE));
  });
});

describe("send gate: asking the node", () => {
  const nodeAt = (chainId: number) => ({
    getChainId: async () => chainId,
  });

  it("returns the chain ID when the gate lets the script send", async () => {
    assert.equal(
      await passSendGate(nodeAt(LOCAL_CHAIN_ID), GatedScript.Demo, undefined),
      LOCAL_CHAIN_ID,
    );
    assert.equal(
      await passSendGate(
        nodeAt(11_155_111),
        GatedScript.Deploy,
        CONFIRM_PHRASE,
      ),
      11_155_111,
    );
  });

  it("throws a ScriptError with the reason when the gate refuses", async () => {
    await assert.rejects(
      passSendGate(nodeAt(11_155_111), GatedScript.PlaceOrder, undefined),
      (error) =>
        error instanceof ScriptError && /Nothing was sent/.test(error.message),
    );
    await assert.rejects(
      passSendGate(nodeAt(11_155_111), GatedScript.Demo, CONFIRM_PHRASE),
      (error) =>
        error instanceof ScriptError && /local chain only/.test(error.message),
    );
  });
});
