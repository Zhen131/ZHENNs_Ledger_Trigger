import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { SCENARIOS, findTestTitles } from "../scripts/scenarios.ts";
import {
  checkTestMatrix,
  parseTables,
  type SourceTest,
} from "../scripts/testMatrix.ts";

// The test matrix check compares docs/test-matrix.md with the tests in the
// source. Sample tests and matrices are built at runtime from pieces, so that
// no line of this file is itself counted as a scenario test by the check.

const CHECK = path.join(import.meta.dirname, "..", "scripts", "scenarios.ts");

/** A scenario number: "S" followed by two digits. */
const number = (n: number) => `S${String(n).padStart(2, "0")}`;
/** `text` in code font. */
const code = (text: string) => `\`${text}\``;
const BR = "<br>";
const SCENARIO_HEADER = [
  "| ID | Scenario | Expected result | Test file | Test title |",
  "| --- | --- | --- | --- | --- |",
];
const OTHER_HEADER = [
  "| What it checks | Test file | Test title |",
  "| --- | --- | --- |",
];

/** A scenario test with number `n` in the sample file `file`. */
function scenarioTest(n: number, rest = "sample", file = "test/a.ts") {
  const test: SourceTest = {
    file,
    title: `${number(n)} ${rest}`,
    scenario: number(n),
  };
  return test;
}

/** One scenario test for each number, all in `test/a.ts`. */
const ALL: readonly SourceTest[] = SCENARIOS.map((_, index) =>
  scenarioTest(index + 1),
);

/** One scenario row: the number, then `file` and the titles of `tests`. */
function row(scenario: string, file: string, titles: readonly string[]) {
  return `| ${scenario} | s | e | ${code(file)} | ${titles.map(code).join(BR)} |`;
}

/**
 * A matrix with one row for each number that `tests` covers, listing those
 * tests, followed by `more` lines.
 */
function matrix(tests: readonly SourceTest[], ...more: string[]): string {
  const lines = ["# Sample", "", ...SCENARIO_HEADER];
  for (const scenario of SCENARIOS) {
    const own = tests.filter((test) => test.scenario === scenario);
    const first = own[0];
    if (first === undefined) continue;
    lines.push(
      row(
        scenario,
        first.file,
        own.map((test) => test.title),
      ),
    );
  }
  return [...lines, ...more].join("\n");
}

function problemsOf(markdown: string, tests: readonly SourceTest[]) {
  return checkTestMatrix(markdown, tests, SCENARIOS);
}

function assertProblem(problems: readonly string[], part: string) {
  assert.ok(
    problems.some((problem) => problem.includes(part)),
    `expected a problem containing "${part}", got: ${problems.join(" | ")}`,
  );
}

describe("test matrix check: what it accepts and what it reports", () => {
  it("passes a matrix with one row for each scenario that lists every scenario test", () => {
    assert.deepEqual(problemsOf(matrix(ALL), ALL), []);
  });

  it("reports a scenario that has no row", () => {
    const without = ALL.filter((test) => test.scenario !== number(7));
    const problems = problemsOf(matrix(without), ALL);
    assertProblem(problems, `no row for ${number(7)}`);
  });

  it("reports a second row for the same scenario", () => {
    const extra = row(number(3), "test/a.ts", [`${number(3)} sample`]);
    assertProblem(problemsOf(matrix(ALL, extra), ALL), "a second row");
  });

  it("reports a row whose first cell is not a scenario number", () => {
    const extra = row(number(27), "test/a.ts", [`${number(27)} sample`]);
    assertProblem(
      problemsOf(matrix(ALL, extra), ALL),
      "is not a scenario number",
    );
  });

  it("reports a title that is not a test in the file named for it", () => {
    const tests = ALL.map((test) =>
      test.scenario === number(5) ? scenarioTest(5, "renamed") : test,
    );
    const problems = problemsOf(matrix(ALL), tests);
    assertProblem(problems, `has no test titled "${number(5)} sample"`);
    assertProblem(problems, `"${number(5)} renamed" is not listed`);
  });

  it("reports a title that is a test only in another file", () => {
    const tests = ALL.map((test) =>
      test.scenario === number(4)
        ? scenarioTest(4, "sample", "test/b.ts")
        : test,
    );
    const problems = problemsOf(matrix(ALL), tests);
    assertProblem(
      problems,
      `test/a.ts has no test titled "${number(4)} sample"`,
    );
  });

  it("reports a file that holds no tests", () => {
    const markdown = matrix(ALL).replace(
      row(number(6), "test/a.ts", [`${number(6)} sample`]),
      row(number(6), "test/none.ts", [`${number(6)} sample`]),
    );
    assertProblem(problemsOf(markdown, ALL), "no test file test/none.ts");
  });

  it("reports a scenario test in the source that its row leaves out", () => {
    const tests = [...ALL, scenarioTest(9, "second")];
    assertProblem(
      problemsOf(matrix(ALL), tests),
      `"${number(9)} second" is not listed in the row for ${number(9)}`,
    );
  });

  it("finds every test that is not skipped, whatever its title starts with, the way the coverage check does", () => {
    const source = [
      `  it("a plain title", () => {});`,
      `  test("${number(8)} a numbered title", () => {});`,
      `  it.skip("a skipped title", () => {});`,
      `  it("an option-skipped title", { skip: true }, () => {});`,
      `  describe("a group title", () => {});`,
    ].join("\n");
    assert.deepEqual(
      findTestTitles(source, "test/a.ts").map((test) => test.title),
      ["a plain title", `${number(8)} a numbered title`],
    );
  });

  it("reports a title that does not start with the number of its row", () => {
    const markdown = matrix(ALL).replace(
      row(number(10), "test/a.ts", [`${number(10)} sample`]),
      row(number(10), "test/a.ts", [
        `${number(10)} sample`,
        `${number(11)} sample`,
      ]),
    );
    assertProblem(
      problemsOf(markdown, ALL),
      `does not start with ${number(10)}`,
    );
  });

  it("accepts one file for all titles or one file for each, and reports any other count", () => {
    const tests = [...ALL, scenarioTest(12, "other", "test/b.ts")];
    const titles = [`${number(12)} sample`, `${number(12)} other`];
    const good = matrix(ALL).replace(
      row(number(12), "test/a.ts", [`${number(12)} sample`]),
      `| ${number(12)} | s | e | ${code("test/a.ts")}${BR}${code("test/b.ts")} | ${titles.map(code).join(BR)} |`,
    );
    assert.deepEqual(problemsOf(good, tests), []);

    const bad = good.replace(
      `${code("test/b.ts")} |`,
      `${code("test/b.ts")}${BR}${code("test/c.ts")} |`,
    );
    assertProblem(problemsOf(bad, tests), "2 titles but 3 files");
  });

  it("requires files and titles in code font", () => {
    const markdown = matrix(ALL).replace(
      `${code(`${number(2)} sample`)} |`,
      `${number(2)} sample |`,
    );
    assertProblem(problemsOf(markdown, ALL), "code font");
  });

  it("checks the titles of other tables too, whatever they start with", () => {
    const plain: SourceTest = {
      file: "test/a.ts",
      title: "a plain test",
      scenario: undefined,
    };
    const tests = [...ALL, plain];
    const other = (title: string) => [
      "",
      ...OTHER_HEADER,
      `| x | ${code("test/a.ts")} | ${code(title)} |`,
    ];
    assert.deepEqual(
      problemsOf(matrix(ALL, ...other("a plain test")), tests),
      [],
    );
    assertProblem(
      problemsOf(matrix(ALL, ...other("a missing test")), tests),
      'has no test titled "a missing test"',
    );
  });

  it("reports a matrix with no scenario table, or with two", () => {
    const none = ["# Sample", "", ...OTHER_HEADER].join("\n");
    assertProblem(problemsOf(none, ALL), "expected one scenario table");
    const two = matrix(ALL, "", ...SCENARIO_HEADER);
    assertProblem(problemsOf(two, ALL), "found 2");
  });

  it("reads table rows with their line numbers, and splits cells only on bars that are not escaped", () => {
    const tables = parseTables(
      ["text", "", "| A | B |", "| --- | :-: |", "| x \\| y | z |"].join("\n"),
    );
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0]?.header, ["A", "B"]);
    assert.deepEqual(tables[0]?.rows, [{ line: 5, cells: ["x \\| y", "z"] }]);
  });
});

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A new folder under the system temp directory, removed after the run, with
 * a test/ folder holding one sample test for each scenario in `test/a.ts`.
 */
function sampleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "test-matrix-check-"));
  temporaryDirectories.push(root);
  mkdirSync(path.join(root, "test"));
  const lines = ALL.map((test) => `  it("${test.title}", () => {});`);
  writeFileSync(path.join(root, "test", "a.ts"), lines.join("\n"));
  return root;
}

function runCheck(...args: string[]) {
  const result = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("test matrix check: the command", () => {
  it("checks this repository's docs/test-matrix.md when run without a directory, and it passes", () => {
    const { status, output } = runCheck();
    assert.equal(status, 0, output);
    assert.match(output, /Scenario coverage passed/);
    assert.match(output, /Test matrix passed: .*test-matrix\.md/);
  });

  it("checks the matrix given with --matrix, taking file names relative to the folder that holds the directory", () => {
    const root = sampleRoot();
    const good = path.join(root, "good.md");
    writeFileSync(good, matrix(ALL));
    const passed = runCheck("--matrix", good, path.join(root, "test"));
    assert.equal(passed.status, 0, passed.output);
    assert.match(passed.output, /Test matrix passed/);

    const bad = path.join(root, "bad.md");
    writeFileSync(
      bad,
      matrix(ALL.filter((test) => test.scenario !== number(14))),
    );
    const failed = runCheck("--matrix", bad, path.join(root, "test"));
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /Test matrix FAILED/);
    assert.ok(failed.output.includes(`no row for ${number(14)}`));
  });

  it("checks no matrix when it is given a directory without --matrix", () => {
    const { status, output } = runCheck(path.join(sampleRoot(), "test"));
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /Test matrix/);
  });

  it("exits with 2 when the matrix cannot be read, or --matrix names no file", () => {
    const root = sampleRoot();
    const missing = runCheck(
      "--matrix",
      path.join(root, "does-not-exist.md"),
      path.join(root, "test"),
    );
    assert.equal(missing.status, 2, missing.output);
    assert.match(missing.output, /could not run/);

    const noFile = runCheck("--matrix");
    assert.equal(noFile.status, 2, noFile.output);
    assert.match(noFile.output, /--matrix needs a file/);
  });
});
