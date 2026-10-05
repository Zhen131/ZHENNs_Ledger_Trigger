// Scenario coverage check.
//
// Usage: node scripts/scenarios.ts [--list] [directory]
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
// Exit code: 0 when every number has a test, 1 when some have none (each one
// is named), 2 when the check itself could not run.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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

/** Every test in `source` whose title starts with a scenario number. */
export function findScenarioTests(
  source: string,
  file: string,
): ScenarioTest[] {
  const found: ScenarioTest[] = [];
  for (const match of source.matchAll(TEST_CALL)) {
    const quoteAt = match.index + match[0].length - 1;
    const end = literalEnd(source, quoteAt);
    if (end < 0) continue;
    const title = source.slice(quoteAt + 1, end - 1);
    const number = NUMBER_AT_START.exec(title);
    if (number === null || !SCENARIOS.includes(number[0])) continue;
    if (isSkipped(source, end)) continue;
    found.push({
      scenario: number[0],
      file,
      line: lineAt(source, quoteAt),
      title,
    });
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

function main(): number {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const directory =
    args.find((arg) => arg !== "--list") ??
    path.join(import.meta.dirname, "..", "test");
  let tests: ScenarioTest[];
  try {
    tests = scanDirectory(directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Scenario coverage check could not run: ${reason}`);
    return 2;
  }
  if (list) printList(tests);
  const missing = missingScenarios(tests);
  if (missing.length > 0) {
    console.log(
      `Scenario coverage FAILED: no test title starts with ${missing.join(", ")} ` +
        `(${SCENARIO_COUNT - missing.length} of ${SCENARIO_COUNT} scenarios have tests).`,
    );
    return 1;
  }
  console.log(
    `Scenario coverage passed: all ${SCENARIO_COUNT} scenarios (S01 to S${SCENARIO_COUNT}) ` +
      `have tests (${tests.length} matching test titles in the source).`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
