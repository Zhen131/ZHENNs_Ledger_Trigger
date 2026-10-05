// Turns the demo's result into the text `npm run demo` prints: a header, one
// block per scenario (what was done, expected, actual, PASS or FAIL) and a
// summary table.

import { describeNumbers, type DemoResult, type DemoRow } from "./demo.ts";

const PASS = "PASS";
const FAIL = "FAIL";

/** PASS or FAIL for one row. */
export function verdict(row: DemoRow): string {
  return row.pass ? PASS : FAIL;
}

/** True when every row passed. */
export function allPassed(result: DemoResult): boolean {
  return result.rows.length > 0 && result.rows.every((row) => row.pass);
}

function block(row: DemoRow): string[] {
  return [
    `${row.id} ${row.title}`,
    ...row.did.map(
      (line, index) => `  ${index === 0 ? "Did:     " : "         "} ${line}`,
    ),
    `  Expected: ${row.expected.join("; ")}`,
    `  Actual:   ${row.actual.join("; ")}`,
    ...row.details.map((line) => `            ${line}`),
    `  Result:   ${verdict(row)}`,
    "",
  ];
}

function table(rows: readonly DemoRow[]): string[] {
  const cells = rows.map((row) => [
    row.id,
    row.title,
    row.expected.join("; "),
    row.actual.join("; "),
    verdict(row),
  ]);
  const header = ["ID", "Scenario", "Expected", "Actual", "Result"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((line) => (line[column] ?? "").length)),
  );
  const line = (values: readonly string[]) =>
    `| ${values.map((value, column) => value.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...cells.map(line),
  ];
}

/** Everything the demo prints, line by line. */
export function formatDemo(result: DemoResult): string[] {
  const passed = result.rows.filter((row) => row.pass).length;
  return [
    `Ledger Trigger demo on a fresh local Hardhat chain (chain ID ${result.chainId}).`,
    "Accounts are Hardhat test accounts: #0 owner (places the orders), #1 executor (runs the keeper), #2 recipient (receives the ETH), #3 stranger (no role).",
    `Contracts: ${Object.entries(result.contracts)
      .map(([name, address]) => `${name} ${address}`)
      .join(", ")}.`,
    describeNumbers(),
    "",
    ...result.rows.flatMap(block),
    "Summary",
    ...table(result.rows),
    "",
    `${passed} of ${result.rows.length} scenarios ${PASS}.${
      allPassed(result)
        ? ""
        : ` ${FAIL}: ${result.rows
            .filter((row) => !row.pass)
            .map((row) => row.id)
            .join(", ")}.`
    }`,
  ];
}
