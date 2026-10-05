import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONFIRM_PHRASE,
  GatedScript,
  OPEN_GATE_METHOD,
  openSendGate,
  redeemSendGateToken,
} from "../scripts/sendGate.ts";

// The token that `openSendGate` sends with its opening request works once:
// redeeming it removes it at once, not only when the opening request returns.
// The client here is a stand-in that redeems the token itself while the
// opening request is still running. Nothing here connects to any network.

/** A chain ID that is not Hardhat's local one. No node serves it here. */
const OTHER_CHAIN_ID = 5_011;

describe("send gate: the opening token", () => {
  it("can be redeemed once only, even while the opening request is still running", async () => {
    const redeemed: (number | undefined)[] = [];
    let requests = 0;
    const client = {
      getChainId: async () => OTHER_CHAIN_ID,
      request: async (args: {
        readonly method: string;
        readonly params: readonly unknown[];
      }) => {
        requests += 1;
        assert.equal(args.method, OPEN_GATE_METHOD);
        const token = args.params[0];
        redeemed.push(redeemSendGateToken(token));
        redeemed.push(redeemSendGateToken(token));
        return false;
      },
    };

    await assert.rejects(
      openSendGate(client, GatedScript.PlaceOrder, CONFIRM_PHRASE),
      /could not open this connection/,
    );

    assert.equal(requests, 1);
    assert.deepEqual(redeemed, [OTHER_CHAIN_ID, undefined]);
  });
});
