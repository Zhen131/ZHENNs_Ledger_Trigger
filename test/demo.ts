import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DEMO_SCENARIOS,
  EXPECTED,
  judge,
  runDemo,
  type DemoResult,
} from "../scripts/demo.ts";
import { allPassed, formatDemo } from "../scripts/demoReport.ts";
import { ScriptError } from "../scripts/scriptError.ts";
import { CONFIRM_PHRASE } from "../scripts/sendGate.ts";
import { setUpScripts } from "./setUpScripts.ts";

const ROOT = path.join(import.meta.dirname, "..");
const HARDHAT = path.join(ROOT, "node_modules", ".bin", "hardhat");
const TIME_LIMIT_MS = 120_000;

/** What each row should expect, written out here from the scenario table. */
const SCENARIO_TABLE = {
  S01: ["Open -> Filled", "ETH to the recipient, not to the caller"],
  S03: ["Open -> Cancelled"],
  S04: ["transaction rejected: NotOrderOwnerOrExecutor"],
  S06: ["transaction rejected: PriceAboveTarget", "order afterwards: Open"],
  S07: ["first fill: Open -> Filled", "second fill rejected: OrderNotOpen"],
  S15: [
    "transaction rejected: InsufficientAllowance",
    "order afterwards: Open",
    "after topping up the allowance: Open -> Filled",
  ],
} as const;

async function playOnFreshChain(): Promise<DemoResult> {
  const { viem } = await setUpScripts();
  return runDemo({ viem, confirmation: undefined });
}

/** What must be the same on every run: ID, actual result, verdict. */
function stablePart(result: DemoResult) {
  return result.rows.map((row) => [row.id, row.actual, row.pass]);
}

describe("demo: the six scenarios on a fresh local chain", () => {
  it("plays S01, S03, S04, S06, S07 and S15 in order, and every one passes", async () => {
    const result = await playOnFreshChain();

    assert.deepEqual(
      result.rows.map((row) => row.id),
      ["S01", "S03", "S04", "S06", "S07", "S15"],
    );
    assert.deepEqual(DEMO_SCENARIOS, [
      "S01",
      "S03",
      "S04",
      "S06",
      "S07",
      "S15",
    ]);
    for (const row of result.rows) {
      assert.equal(row.pass, true, `${row.id}: ${row.actual.join("; ")}`);
      assert.deepEqual(row.actual, row.expected);
    }
    assert.equal(allPassed(result), true);
    assert.equal(result.chainId, 31_337);
  });

  it("expects for each scenario what the scenario table says", () => {
    for (const id of DEMO_SCENARIOS) {
      assert.deepEqual(EXPECTED[id].expected, SCENARIO_TABLE[id], id);
    }
  });

  it("gives the same IDs, actual results and verdicts on a second run", async () => {
    const first = await playOnFreshChain();
    const second = await playOnFreshChain();
    assert.deepEqual(stablePart(second), stablePart(first));
  });

  it("prints a block per scenario and a summary table, all PASS", async () => {
    const lines = formatDemo(await playOnFreshChain());
    const text = lines.join("\n");

    assert.equal(lines.filter((line) => line === "  Result:   PASS").length, 6);
    for (const id of DEMO_SCENARIOS) {
      assert.match(text, new RegExp(`^\\| ${id} \\|.*\\| PASS   \\|$`, "m"));
    }
    assert.equal(lines.at(-1), "6 of 6 scenarios PASS.");
    assert.doesNotMatch(text, /FAIL/);
  });
});

describe("demo: a result that is not the expected one", () => {
  it("judges a row by comparing the lists item by item", () => {
    assert.equal(judge(["a", "b"], ["a", "b"]), true);
    assert.equal(judge(["a", "b"], ["a", "c"]), false);
    assert.equal(judge(["a", "b"], ["a"]), false);
    assert.equal(judge(["a"], ["a", "b"]), false);
  });

  it("marks such a row FAIL, names it in the last line, and does not count the run as passed", async () => {
    const result = await playOnFreshChain();
    const spoiled: DemoResult = {
      ...result,
      rows: result.rows.map((row) =>
        row.id === "S06"
          ? {
              ...row,
              expected: ["transaction rejected: StalePrice"],
              pass: judge(["transaction rejected: StalePrice"], row.actual),
            }
          : row,
      ),
    };

    const lines = formatDemo(spoiled);

    assert.equal(allPassed(spoiled), false);
    assert.match(lines.join("\n"), /^\| S06 \|.*\| FAIL   \|$/m);
    assert.equal(lines.at(-1), "5 of 6 scenarios PASS. FAIL: S06.");
  });
});

describe("demo: only on Hardhat's local chain", () => {
  for (const [label, confirmation] of [
    ["without the confirmation", undefined],
    ["with a wrong confirmation", "yes"],
    ["even with the exact confirmation sentence", CONFIRM_PHRASE],
  ] as const) {
    it(`refuses a chain that is not local ${label}, and sends nothing`, async () => {
      const s = await setUpScripts({ chainId: 999 });
      const before = await s.blockNumber();

      await assert.rejects(
        runDemo({ viem: s.viem, confirmation }),
        (error) =>
          error instanceof ScriptError &&
          /local chain only/.test(error.message),
      );

      assert.equal(await s.blockNumber(), before);
    });
  }
});

describe("demo: the npm run demo entry point", () => {
  it("runs as a Hardhat script, prints six PASS rows without any node URL, and exits with 0", async () => {
    const run = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(HARDHAT, ["run", "scripts/cli/demo.ts"], {
          cwd: ROOT,
          env: { ...process.env, HARDHAT_DISABLE_TELEMETRY: "true" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on(
          "data",
          (chunk: Buffer) => (output += chunk.toString()),
        );
        child.stderr.on(
          "data",
          (chunk: Buffer) => (output += chunk.toString()),
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), TIME_LIMIT_MS);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output });
        });
      },
    );

    assert.equal(run.code, 0, run.output);
    assert.equal(run.output.match(/^ {2}Result: {3}PASS$/gm)?.length, 6);
    assert.match(run.output, /^6 of 6 scenarios PASS\.$/m);
    assert.doesNotMatch(run.output, /https?:\/\//);
  });
});
