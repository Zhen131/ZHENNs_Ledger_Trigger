// Checks the test matrix, docs/test-matrix.md, against the tests in the
// source. The scenario coverage check (scenarios.ts) runs it; this file only
// reads Markdown and compares, it touches no file itself.
//
// What the matrix must look like:
//
// - A table whose first header cell is "ID" is the scenario table. There is
//   exactly one, and it has exactly one row for each scenario number, S01 to
//   S26, with the number alone in its first cell.
// - Every table with the header cells "Test file" and "Test title" names tests.
//   In each of its rows, the title cell holds one or more titles and the file
//   cell one or more files, each in code font and separated by <br>. The file
//   cell names either one file, for all the titles, or one file for each title,
//   in the same order. Files are named relative to the folder that holds the
//   test folder, for example `test/LedgerTriggerFill.ts`. Titles are written
//   exactly as in the source, without their quotes, `${...}` placeholders
//   included.
//
// What is checked:
//
// - Each title is the title of a test in the file named for it, found the way
//   the scenario coverage check finds tests: a skipped test does not count.
// - In the scenario table, each title starts with the number of its row, and
//   every scenario test in the source is listed in the row of its number.
//
// Each problem is reported with the line of the matrix it is on, when there is
// one.

/** A test found in the source. */
export type SourceTest = {
  /** The file, relative to the folder that holds the test folder, with "/". */
  readonly file: string;
  /** The title as written in the source, without its quotes. */
  readonly title: string;
  /** The scenario number the title starts with, if it starts with one. */
  readonly scenario: string | undefined;
};

type Row = {
  /** 1-based line in the Markdown file. */
  readonly line: number;
  readonly cells: readonly string[];
};

type Table = {
  readonly line: number;
  readonly header: readonly string[];
  readonly rows: readonly Row[];
};

const SEPARATOR_CELL = /^:?-+:?$/;
const LINE_BREAK = /<br\s*\/?>/i;
const CODE_SPAN = /^`([^`]+)`$/;

/** The cells of one table line: split on `|` that is not escaped, trimmed. */
function cellsOf(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Every table in `markdown`: runs of lines that start with `|`. */
export function parseTables(markdown: string): Table[] {
  const lines = markdown.split(/\r?\n/);
  const tables: Table[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] ?? "").trim().startsWith("|")) {
      i += 1;
      continue;
    }
    const start = i;
    const block: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
      block.push(lines[i] ?? "");
      i += 1;
    }
    const separator = cellsOf(block[1] ?? "");
    if (block.length < 2 || !separator.every((c) => SEPARATOR_CELL.test(c))) {
      continue;
    }
    tables.push({
      line: start + 1,
      header: cellsOf(block[0] ?? ""),
      rows: block.slice(2).map((text, index) => ({
        line: start + 3 + index,
        cells: cellsOf(text),
      })),
    });
  }
  return tables;
}

/** The code-font items of a cell, split on <br>; undefined if one is not code. */
function codeItems(cell: string): string[] | undefined {
  const items: string[] = [];
  for (const part of cell.split(LINE_BREAK)) {
    const code = CODE_SPAN.exec(part.trim());
    if (code === null) return undefined;
    items.push(code[1] ?? "");
  }
  return items;
}

/** True when `title` starts with `scenario` and the next character is not a digit. */
function startsWithNumber(title: string, scenario: string): boolean {
  return (
    title.startsWith(scenario) && !/^\d/.test(title.slice(scenario.length))
  );
}

/**
 * The problems found in the test matrix `markdown`, compared with `tests`,
 * every test in the source that is not skipped. `scenarios` lists the
 * scenario numbers, S01 to S26. An empty list means the matrix is right.
 */
export function checkTestMatrix(
  markdown: string,
  tests: readonly SourceTest[],
  scenarios: readonly string[],
): string[] {
  const problems: string[] = [];
  const tables = parseTables(markdown);
  const testTables = tables.filter(
    (table) =>
      table.header.includes("Test file") && table.header.includes("Test title"),
  );
  const scenarioTables = tables.filter((table) => table.header[0] === "ID");
  if (scenarioTables.length !== 1) {
    problems.push(
      `expected one scenario table (first header cell "ID"), found ${scenarioTables.length}`,
    );
  }
  const scenarioTable = scenarioTables[0];
  if (scenarioTable !== undefined && !testTables.includes(scenarioTable)) {
    problems.push(
      `line ${scenarioTable.line}: the scenario table has no "Test file" and "Test title" columns`,
    );
  }

  const testsIn = new Map<string, Set<string>>();
  for (const test of tests) {
    const titles = testsIn.get(test.file) ?? new Set<string>();
    titles.add(test.title);
    testsIn.set(test.file, titles);
  }

  /** The (file, title) pairs listed in each scenario row, by number. */
  const listed = new Map<string, Set<string>>();
  for (const table of testTables) {
    const fileColumn = table.header.indexOf("Test file");
    const titleColumn = table.header.indexOf("Test title");
    const isScenarioTable = table === scenarioTable;
    for (const row of table.rows) {
      const where = `line ${row.line}`;
      const scenario = isScenarioTable ? (row.cells[0] ?? "") : undefined;
      if (scenario !== undefined) {
        if (!scenarios.includes(scenario)) {
          problems.push(`${where}: "${scenario}" is not a scenario number`);
          continue;
        }
        if (listed.has(scenario)) {
          problems.push(`${where}: a second row for ${scenario}`);
          continue;
        }
        listed.set(scenario, new Set<string>());
      }
      const files = codeItems(row.cells[fileColumn] ?? "");
      const titles = codeItems(row.cells[titleColumn] ?? "");
      if (files === undefined || titles === undefined) {
        problems.push(
          `${where}: every test file and test title must be in code font, separated by <br>`,
        );
        continue;
      }
      if (files.length !== 1 && files.length !== titles.length) {
        problems.push(
          `${where}: ${titles.length} titles but ${files.length} files; give one file for all of them or one for each`,
        );
        continue;
      }
      titles.forEach((title, index) => {
        const file = files.length === 1 ? files[0] : files[index];
        if (file === undefined) return;
        const inFile = testsIn.get(file);
        if (inFile === undefined) {
          problems.push(`${where}: no test file ${file} with tests in it`);
        } else if (!inFile.has(title)) {
          problems.push(`${where}: ${file} has no test titled "${title}"`);
        }
        if (scenario !== undefined) {
          if (!startsWithNumber(title, scenario)) {
            problems.push(
              `${where}: "${title}" does not start with ${scenario}, the number of its row`,
            );
          }
          listed.get(scenario)?.add(`${file}\n${title}`);
        }
      });
    }
  }

  if (scenarioTable !== undefined) {
    for (const scenario of scenarios) {
      if (!listed.has(scenario)) {
        problems.push(`the scenario table has no row for ${scenario}`);
      }
    }
    for (const test of tests) {
      if (test.scenario === undefined) continue;
      const row = listed.get(test.scenario);
      if (row !== undefined && !row.has(`${test.file}\n${test.title}`)) {
        problems.push(
          `${test.file}: the test "${test.title}" is not listed in the row for ${test.scenario}`,
        );
      }
    }
  }
  return problems;
}
