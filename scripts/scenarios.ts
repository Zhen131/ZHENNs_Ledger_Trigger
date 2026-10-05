// Scenario coverage check.
//
// Usage: node scripts/scenarios.ts [--list] [--matrix <file>] [directory]
//
// The order contract's specification lists 26 test scenarios, numbered S01 to
// S26. This check passes only when each of them has at least one test whose
// own title starts with its number, for example
// it("S07 a second fill of the same order is rejected", ...). Only the title of
// the test itself counts, not the titles of the groups (describe) around it.
//
// It reads every .ts file under `directory`, subdirectories included (default:
// the test/ directory of this repository), and finds each test call: `it(` or
// `test(` at the start of a line, followed by a string literal in single
// quotes, double quotes or backticks, on the same line or the next. A title
// counts for a number when it starts with that number, written out, and the
// next character is not a digit. These do not count: it.skip, it.todo,
// it.only and the like; a test given a `skip` or `todo` option; a title that
// does not start with the number as literal text, for example one that starts
// with `${...}`; a call in a // comment. A call inside a /* */ comment is not
// recognised as commented out.
//
// With --list it also prints every counted test, grouped by number.
//
// It also checks the test matrix, the Markdown file that lists the tests of
// each scenario (see testMatrix.ts for what it must look like): every number
// has a row there, every title it names is a test in the file it names, and
// every scenario test in the source is listed in the row of its number. Run
// without a directory, the check reads this repository's test/ directory and
// docs/test-matrix.md. Given a directory, it checks the matrix only when
// --matrix names one; the files the matrix names are then taken relative to
// the folder that holds that directory.
//
// Exit code: 0 when every number has a test and the matrix, if checked, is
// right; 1 when some number has none or the matrix is wrong (each problem is
// named); 2 when the check itself could not run, including when the matrix
// cannot be read.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { checkTestMatrix, type SourceTest } from "./testMatrix.ts";

const ROOT = path.join(import.meta.dirname, "..");
/** The test matrix of this repository, checked when no directory is given. */
const MATRIX = path.join(ROOT, "docs", "test-matrix.md");

/** How many scenarios the specification lists. */
export const SCENARIO_COUNT = 26;

/** The scenario numbers, S01 to S26. */
export const SCENARIOS: readonly string[] = Array.from(
  { length: SCENARIO_COUNT },
  (_, index) => `S${String(index + 1).padStart(2, "0")}`,
);

export type ScenarioTest = {
  /** The scenario number the title starts with, for example `S07`. */
  readonly scenario: string;
  /** The file, as given to `findScenarioTests`. */
  readonly file: string;
  /** 1-based line of the title. */
  readonly line: number;
  /** The title as written in the source, without its quotes. */
  readonly title: string;
};

const TEST_CALL = /^[ \t]*(?:it|test)[ \t]*\([ \t]*(?:\r?\n[ \t]*)?(["'`])/gm;
const NUMBER_AT_START = /^S\d{2}(?!\d)/;
const OPTIONS_AFTER_TITLE = /^\s*,\s*\{([^{}]*)\}/;
const SKIP_OPTION = /\b(?:skip|todo)\b/;

/**
 * Index just past the string literal whose opening quote is at `start`, or -1
 * when it does not close. Single- and double-quoted literals end at the end of
 * the line; template literals may span lines and contain `${...}`.
 */
function literalEnd(source: string, start: number): number {
  const quote = source.charAt(start);
  let depth = 0;
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source.charAt(i);
    if (c === "\\") {
      i += 1;
    } else if (depth > 0) {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
    } else if (quote === "`" && c === "$" && source.charAt(i + 1) === "{") {
      depth = 1;
      i += 1;
    } else if (c === quote) {
      return i + 1;
    } else if (c === "\n" && quote !== "`") {
      return -1;
    }
  }
  return -1;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** True when the test call goes on with an options object that skips it. */
function isSkipped(source: string, afterTitle: number): boolean {
  const options = OPTIONS_AFTER_TITLE.exec(source.slice(afterTitle));
  return options !== null && SKIP_OPTION.test(options[1] ?? "");
}

export type TestTitle = {
  /** The file, as given to `findTestTitles`. */
  readonly file: string;
  /** 1-based line of the title. */
  readonly line: number;
  /** The title as written in the source, without its quotes. */
  readonly title: string;
};

/**
 * Every test in `source` that is not skipped, found as described at the top
 * of this file, whatever its title starts with.
 */
export function findTestTitles(source: string, file: string): TestTitle[] {
  const found: TestTitle[] = [];
  for (const match of source.matchAll(TEST_CALL)) {
    const quoteAt = match.index + match[0].length - 1;
    const end = literalEnd(source, quoteAt);
    if (end < 0) continue;
    if (isSkipped(source, end)) continue;
    found.push({
      file,
      line: lineAt(source, quoteAt),
      title: source.slice(quoteAt + 1, end - 1),
    });
  }
  return found;
}

/** The scenario number `title` starts with, or undefined. */
function scenarioOf(title: string): string | undefined {
  const number = NUMBER_AT_START.exec(title);
  return number !== null && SCENARIOS.includes(number[0])
    ? number[0]
    : undefined;
}

/** Every test in `source` whose title starts with a scenario number. */
export function findScenarioTests(
  source: string,
  file: string,
): ScenarioTest[] {
  const found: ScenarioTest[] = [];
  for (const test of findTestTitles(source, file)) {
    const scenario = scenarioOf(test.title);
    if (scenario === undefined) continue;
    found.push({ scenario, file, line: test.line, title: test.title });
  }
  return found;
}

/** Every .ts file under `directory`, subdirectories included, sorted. */
function listTestFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files.sort();
}

/**
 * Every scenario test in the .ts files under `directory`. File names are
 * given relative to the current directory.
 */
export function scanDirectory(directory: string): ScenarioTest[] {
  return listTestFiles(directory).flatMap((file) =>
    findScenarioTests(
      readFileSync(file, "utf8"),
      path.relative(process.cwd(), file),
    ),
  );
}

/**
 * Every test that is not skipped in the .ts files under `directory`. File
 * names are given relative to `relativeTo`, with "/" between folders.
 */
export function scanTestTitles(
  directory: string,
  relativeTo: string,
): TestTitle[] {
  return listTestFiles(directory).flatMap((file) =>
    findTestTitles(
      readFileSync(file, "utf8"),
      path.relative(relativeTo, file).split(path.sep).join("/"),
    ),
  );
}

/**
 * The problems in the test matrix at `matrixFile`, compared with the tests
 * under `directory`. The files the matrix names are taken relative to the
 * folder that holds `directory`. Throws when a file cannot be read.
 */
export function matrixProblems(
  matrixFile: string,
  directory: string,
): string[] {
  const markdown = readFileSync(matrixFile, "utf8");
  const base = path.dirname(path.resolve(directory));
  const tests: SourceTest[] = scanTestTitles(directory, base).map((test) => ({
    file: test.file,
    title: test.title,
    scenario: scenarioOf(test.title),
  }));
  return checkTestMatrix(markdown, tests, SCENARIOS);
}

/** The scenario numbers that no test in `tests` covers, in order. */
export function missingScenarios(
  tests: readonly ScenarioTest[],
): readonly string[] {
  const covered = new Set(tests.map((test) => test.scenario));
  return SCENARIOS.filter((scenario) => !covered.has(scenario));
}

function printList(tests: readonly ScenarioTest[]): void {
  for (const scenario of SCENARIOS) {
    const own = tests.filter((test) => test.scenario === scenario);
    console.log(`${scenario}: ${own.length} test(s)`);
    for (const test of own) {
      console.log(`  ${test.file}:${test.line}  ${test.title}`);
    }
  }
}

type Options = {
  readonly list: boolean;
  readonly directory: string | undefined;
  readonly matrix: string | undefined;
};

/** The command-line options, or what is wrong with them. */
function parseArgs(args: readonly string[]): Options | string {
  let list = false;
  let directory: string | undefined;
  let matrix: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--list") {
      list = true;
    } else if (arg === "--matrix") {
      matrix = args[i + 1];
      if (matrix === undefined) return "--matrix needs a file";
      i += 1;
    } else {
      directory ??= arg;
    }
  }
  return { list, directory, matrix };
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === "string") {
    console.error(`Scenario coverage check could not run: ${options}.`);
    return 2;
  }
  const directory = options.directory ?? path.join(ROOT, "test");
  const matrix =
    options.matrix ?? (options.directory === undefined ? MATRIX : undefined);
  let tests: ScenarioTest[];
  let problems: string[] | undefined;
  try {
    tests = scanDirectory(directory);
    if (matrix !== undefined) problems = matrixProblems(matrix, directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Scenario coverage check could not run: ${reason}`);
    return 2;
  }
  if (options.list) printList(tests);
  let failed = false;
  const missing = missingScenarios(tests);
  if (missing.length > 0) {
    console.log(
      `Scenario coverage FAILED: no test title starts with ${missing.join(", ")} ` +
        `(${SCENARIO_COUNT - missing.length} of ${SCENARIO_COUNT} scenarios have tests).`,
    );
    failed = true;
  } else {
    console.log(
      `Scenario coverage passed: all ${SCENARIO_COUNT} scenarios (S01 to S${SCENARIO_COUNT}) ` +
        `have tests (${tests.length} matching test titles in the source).`,
    );
  }
  if (matrix !== undefined && problems !== undefined) {
    const name = path.relative(process.cwd(), matrix);
    if (problems.length > 0) {
      console.log(`Test matrix FAILED: ${name} does not match the tests.`);
      for (const problem of problems) console.log(`  ${problem}`);
      failed = true;
    } else {
      console.log(
        `Test matrix passed: ${name} has a row for each of the ${SCENARIO_COUNT} scenarios, ` +
          `every title it names is a test in the file it names, and every scenario test is listed.`,
      );
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
