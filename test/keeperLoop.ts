import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { HttpRequestError } from "viem";

import { keepRunning } from "../keeper/keepRunning.ts";
import { Action, type LogEntry } from "../keeper/log.ts";
import { OrderStatus } from "../keeper/names.ts";
import { roundHasError, runOnce, type RoundReport } from "../keeper/runOnce.ts";
import { logText, setUpKeeper } from "./setUpKeeper.ts";

describe("keeper keep-running mode", () => {
  it("logs a round that cannot reach the node as an error, waits, and runs the next round as usual", async () => {
    const k = await setUpKeeper();
    const { orderId } = await k.place();
    const urlKey = randomBytes(16).toString("hex");
    let round = 0;
    const flaky = k.publicClientThrough(async (_args, forward) => {
      if (round === 1) {
        throw new HttpRequestError({
          url: `http://127.0.0.1:1/v3/${urlKey}`,
          details: "connection refused",
        });
      }
      return forward();
    });
    const entries: LogEntry[] = [];
    const reports: RoundReport[] = [];
    const waits: number[] = [];

    await keepRunning({
      runRound: async () => {
        round += 1;
        const report = await runOnce({
          clients: { publicClient: flaky, walletClient: k.keeper },
          settings: k.settings,
          abis: k.abis,
          log: (entry) => entries.push(entry),
        });
        reports.push(report);
        return report;
      },
      intervalMs: 30_000,
      wait: async (ms) => {
        waits.push(ms);
      },
      log: (entry) => entries.push(entry),
      maxRounds: 2,
    });

    assert.equal(reports.length, 2);
    const [first, second] = reports;
    assert.ok(first && second);
    assert.equal(first.roundError?.action, Action.Error);
    assert.equal(first.roundError?.reason, "node-unreachable");
    assert.equal(roundHasError(first), true);
    assert.equal(roundHasError(second), false);
    assert.deepEqual(
      second.orders.map((entry) => [entry.orderId, entry.action]),
      [[orderId, Action.Fill]],
    );
    assert.equal(await k.trigger.read.statusOf([orderId]), OrderStatus.Filled);
    assert.deepEqual(waits, [30_000]);
    const lines = logText(entries);
    assert.match(
      lines[0] ?? "",
      /^1970-01-01T00:00:00\.000Z order=- action=error reason=node-unreachable step=find-orders message="Could not reach the node\." types=HttpRequestError$/,
    );
    assert.ok(lines.every((line) => !line.includes(urlKey)));
  });

  it("logs a round that throws as an internal error, without its message, and still runs the next round", async () => {
    const urlKey = randomBytes(16).toString("hex");
    const entries: LogEntry[] = [];
    let rounds = 0;

    await keepRunning({
      runRound: async () => {
        rounds += 1;
        if (rounds === 1) throw new TypeError(`no ${urlKey} here`);
        return { orders: [], roundError: undefined };
      },
      intervalMs: 1,
      wait: async () => {},
      log: (entry) => entries.push(entry),
      maxRounds: 3,
    });

    assert.equal(rounds, 3);
    assert.deepEqual(logText(entries), [
      '1970-01-01T00:00:00.000Z order=- action=error reason=internal-error step=round message="The keeper met an error it did not expect." types=TypeError',
    ]);
  });
});
