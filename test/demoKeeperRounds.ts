import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDemo, type DemoResult } from "../scripts/demo.ts";
import { setUpScripts } from "./setUpScripts.ts";

// The keeper's rounds the demo runs for its dormant order (three rounds) and
// its Ladder order (two rounds), read from the keeper log lines the demo
// prints under those scenarios. Each line is checked by its action, its reason
// and the counts it carries; times, transaction hashes and block numbers,
// which change from run to run, are taken out first, and the order ID is
// written as N. Each round must find exactly one order: the scenario's own,
// not the ones earlier scenarios left open.

/** The keeper lines of one scenario, cut into rounds, without what changes. */
function rounds(result: DemoResult, id: string): string[][] {
  const row = result.rows.find((entry) => entry.id === id);
  assert.ok(row !== undefined, `no row ${id}`);
  const lines = row.details
    .filter((line) => line.startsWith("keeper: "))
    .map((line) =>
      line
        .replace(/^keeper: \S+ /, "")
        .replace(/ tx=0x[0-9a-f]+/, "")
        .replace(/ from-block=\d+ to-block=\d+/, "")
        .replace(/^order=\d+ /, "order=N "),
    );
  const cut: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("order=- action=round-start ")) cut.push([]);
    cut.at(-1)?.push(line);
  }
  return cut;
}

/** The order IDs the keeper lines of one scenario name. */
function orderIds(result: DemoResult, id: string): string[] {
  const row = result.rows.find((entry) => entry.id === id);
  const ids = (row?.details ?? []).flatMap((line) => {
    const match = /^keeper: \S+ order=(\d+) /.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return [...new Set(ids)];
}

const START = "order=- action=round-start reason=orders-found orders=1";

describe("demo: the keeper's rounds", () => {
  it("wait, activate and fill the dormant order in three rounds, and fill two Ladder tiers in one round and the third in the next, each round finding one order", async () => {
    const { viem } = await setUpScripts();

    const result = await runDemo({ viem, confirmation: undefined });

    assert.deepEqual(rounds(result, "S27"), [
      [
        START,
        "order=N action=skip reason=PriceBelowActivation check=canActivate",
        "order=- action=round-end reason=done activated=0 filled=0 skipped=1 errors=0",
      ],
      [
        START,
        "order=N action=activated reason=transaction-succeeded",
        "order=N action=skip reason=PriceAboveTarget check=canFill",
        "order=- action=round-end reason=done activated=1 filled=0 skipped=1 errors=0",
      ],
      [
        START,
        "order=N action=filled reason=transaction-succeeded",
        "order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0",
      ],
    ]);
    assert.equal(orderIds(result, "S27").length, 1);

    assert.deepEqual(rounds(result, "S50"), [
      [
        START,
        "order=N action=filled reason=transaction-succeeded",
        "order=N action=filled reason=transaction-succeeded",
        "order=- action=round-end reason=done activated=0 filled=2 skipped=0 errors=0",
      ],
      [
        START,
        "order=N action=filled reason=transaction-succeeded",
        "order=- action=round-end reason=done activated=0 filled=1 skipped=0 errors=0",
      ],
    ]);
    assert.equal(orderIds(result, "S50").length, 1);
    assert.notDeepEqual(orderIds(result, "S50"), orderIds(result, "S27"));
  });
});
