import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  SCENARIOS,
  findScenarioTests,
  missingScenarios,
  scanDirectory,
} from "../scripts/scenarios.ts";

// Sample test files are built at runtime from pieces, so that no line of this
// file is itself counted as a scenario test by the check.
const CHECK = path.join(import.meta.dirname, "..", "scripts", "scenarios.ts");

/** A scenario number: "S" followed by two digits. */
const number = (n: number) => `S${String(n).padStart(2, "0")}`;

/** One line of test source: `<fn>(<title literal>, () => {});`. */
function call(fn: string, title: string, quote = '"', rest = ", () => {});") {
  return `  ${fn}(${quote}${title}${quote}${rest}`;
}

/** The scenario numbers counted in `lines`, joined as one file. */
function counted(...lines: string[]): string[] {
  return findScenarioTests(lines.join("\n"), "sample.ts").map(
    (test) => test.scenario,
  );
}

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A new directory under the system temp directory, removed after the run. */
function sampleDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "scenario-check-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Writes one sample test file with a test for each of `numbers`. */
function writeSample(directory: string, name: string, numbers: number[]) {
  const lines = numbers.map((n) => call("it", `${number(n)} sample`));
  writeFileSync(path.join(directory, name), lines.join("\n"));
}

function runCheck(...args: string[]) {
  const result = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("scenario coverage check: which titles count", () => {
  it("lists the 26 scenario numbers from the specification", () => {
    assert.equal(SCENARIOS.length, 26);
    assert.equal(SCENARIOS[0], number(1));
    assert.equal(SCENARIOS[25], number(26));
  });

  it("counts a test whose own title starts with the number", () => {
    assert.deepEqual(counted(call("it", `${number(7)} second fill`)), [
      number(7),
    ]);
  });

  it("counts titles in double quotes, single quotes and backticks, and test( as well as it(", () => {
    assert.deepEqual(
      counted(
        call("it", `${number(1)} a`, '"'),
        call("it", `${number(2)} b`, "'"),
        call("it", `${number(3)} c`, "`"),
        call("test", `${number(4)} d`),
      ),
      [number(1), number(2), number(3), number(4)],
    );
  });

  it("counts a template title that starts with the number and goes on with a placeholder", () => {
    assert.deepEqual(counted(call("it", `${number(24)} for \${label}`, "`")), [
      number(24),
    ]);
  });

  it("counts a title written on the line after it(", () => {
    assert.deepEqual(
      counted("  it(", `    "${number(3)} a long title",`, "  () => {});"),
      [number(3)],
    );
  });

  it("gives the file and line of each counted title", () => {
    const tests = findScenarioTests(
      ["", call("it", `${number(9)} x`)].join("\n"),
      "some.ts",
    );
    assert.deepEqual(tests, [
      {
        scenario: number(9),
        file: "some.ts",
        line: 2,
        title: `${number(9)} x`,
      },
    ]);
  });

  it("does not count the title of a describe group", () => {
    assert.deepEqual(counted(call("describe", `${number(5)} group`)), []);
  });

  it("does not count it.skip, it.todo or it.only", () => {
    assert.deepEqual(
      counted(
        call("it.skip", `${number(1)} a`),
        call("it.todo", `${number(2)} b`),
        call("it.only", `${number(3)} c`),
      ),
      [],
    );
  });

  it("does not count a test given a skip or todo option", () => {
    assert.deepEqual(
      counted(
        call("it", `${number(1)} a`, '"', ", { skip: true }, () => {});"),
        call("it", `${number(2)} b`, '"', ', { todo: "later" }, () => {});'),
        call("it", `${number(3)} c`, '"', ", { timeout: 5 }, () => {});"),
      ),
      [number(3)],
    );
  });

  it("does not count a test in a line comment", () => {
    assert.deepEqual(
      counted(`  // ${call("it", `${number(1)} a`).trim()}`),
      [],
    );
  });

  it("does not count a title with three digits, a lower-case s, or the number later in the title", () => {
    assert.deepEqual(
      counted(
        call("it", `${number(1)}0 a`),
        call("it", `s${number(1).slice(1)} b`),
        call("it", `c ${number(1)}`),
      ),
      [],
    );
  });

  it("does not count a title that starts with a placeholder, or numbers outside S01 to S26", () => {
    assert.deepEqual(
      counted(
        call("it", `\${code} a`, "`"),
        call("it", `${number(0)} b`),
        call("it", `${number(27)} c`),
      ),
      [],
    );
  });
});

describe("scenario coverage check: whole directories", () => {
  it("names every number that no test covers", () => {
    const tests = [
      { scenario: number(2), file: "a.ts", line: 1, title: "" },
      { scenario: number(26), file: "a.ts", line: 2, title: "" },
    ];
    const missing = missingScenarios(tests);
    assert.equal(missing.length, 24);
    assert.ok(!missing.includes(number(2)));
    assert.ok(!missing.includes(number(26)));
    assert.equal(missing[0], number(1));
  });

  it("reads .ts files in subdirectories too, and only .ts files", () => {
    const directory = sampleDirectory();
    mkdirSync(path.join(directory, "nested"));
    writeSample(directory, "top.ts", [1]);
    writeSample(path.join(directory, "nested"), "inner.ts", [2]);
    writeSample(directory, "notes.md", [3]);

    const found = scanDirectory(directory).map((test) => test.scenario);
    assert.deepEqual(found.sort(), [number(1), number(2)]);
  });

  it("passes and exits with 0 when every number has a test", () => {
    const directory = sampleDirectory();
    const all = SCENARIOS.map((_, index) => index + 1);
    writeSample(directory, "first.ts", all.slice(0, 13));
    writeSample(directory, "second.ts", all.slice(13));

    const { status, output } = runCheck(directory);
    assert.equal(status, 0, output);
    assert.match(output, /Scenario coverage passed/);
  });

  it("fails with exit code 1 and names the missing numbers", () => {
    const directory = sampleDirectory();
    const some = SCENARIOS.map((_, index) => index + 1).filter(
      (n) => n !== 7 && n !== 26,
    );
    writeSample(directory, "most.ts", some);

    const { status, output } = runCheck(directory);
    assert.equal(status, 1, output);
    assert.match(output, /FAILED/);
    assert.ok(output.includes(`${number(7)}, ${number(26)}`), output);
  });

  it("lists every counted test by number when asked", () => {
    const directory = sampleDirectory();
    writeSample(directory, "one.ts", [5]);

    const { output } = runCheck("--list", directory);
    assert.match(output, new RegExp(`${number(5)}: 1 test`));
    assert.match(output, new RegExp(`${number(6)}: 0 test`));
    assert.ok(output.includes("one.ts:1"), output);
  });

  it("exits with 2 when the directory cannot be read", () => {
    const missing = path.join(sampleDirectory(), "does-not-exist");

    const { status, output } = runCheck(missing);
    assert.equal(status, 2, output);
    assert.match(output, /could not run/);
  });
});
