import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { ActivationBlocker, FillBlocker, Kind, Status } from "./setUpFills.ts";

// The contract's four enums are part of its interface: the ABI carries their
// values as plain numbers, and the keeper, the web page and these tests name
// those numbers. Their members and the order of the members are fixed. These
// tests read the members, in declaration order, from the syntax tree in the
// compiler's build output and compare them with the fixed lists, and with the
// value lists the tests use.

const ARTIFACTS = path.join(import.meta.dirname, "..", "artifacts");

/** The fixed members of each enum, in declaration order. */
const MEMBERS = {
  OrderKind: ["Limit", "Dca", "Ladder"],
  OrderStatus: [
    "None",
    "Dormant",
    "Open",
    "PartiallyFilled",
    "Filled",
    "Cancelled",
    "Expired",
  ],
  FillBlocker: [
    "None",
    "NotOpen",
    "Dormant",
    "Expired",
    "NotStarted",
    "PeriodAlreadyFilled",
    "InvalidPrice",
    "StalePrice",
    "PriceAboveTarget",
    "InsufficientAllowance",
    "InsufficientBalance",
  ],
  ActivationBlocker: [
    "None",
    "NotDormant",
    "Expired",
    "InvalidPrice",
    "StalePrice",
    "PriceBelowActivation",
  ],
} as const;

type AstNode = {
  readonly nodeType?: string;
  readonly name?: string;
  readonly nodes?: readonly AstNode[];
  readonly members?: readonly AstNode[];
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The LedgerTrigger contract node of the compiler's syntax tree. */
function contractNode(): AstNode {
  const artifact = readJson(
    path.join(
      ARTIFACTS,
      "contracts",
      "LedgerTrigger.sol",
      "LedgerTrigger.json",
    ),
  ) as { buildInfoId: string; inputSourceName: string };
  const buildOutput = readJson(
    path.join(ARTIFACTS, "build-info", `${artifact.buildInfoId}.output.json`),
  ) as { output: { sources: Record<string, { ast: AstNode }> } };
  const source = buildOutput.output.sources[artifact.inputSourceName];
  assert.ok(source, "the build output has the LedgerTrigger source");
  const contract = source.ast.nodes?.find(
    (node) =>
      node.nodeType === "ContractDefinition" && node.name === "LedgerTrigger",
  );
  assert.ok(contract, "the syntax tree has the LedgerTrigger contract");
  return contract;
}

/** The names of every enum LedgerTrigger declares, in declaration order. */
function enumNames(): string[] {
  return (contractNode().nodes ?? [])
    .filter((node) => node.nodeType === "EnumDefinition")
    .map((node) => node.name ?? "");
}

/** The members of `enumName` in LedgerTrigger, in declaration order. */
function enumMembers(enumName: string): string[] {
  const definition = contractNode().nodes?.find(
    (node) => node.nodeType === "EnumDefinition" && node.name === enumName,
  );
  assert.ok(definition?.members, `the contract declares the enum ${enumName}`);
  return definition.members.map((member) => member.name ?? "");
}

/** The names of a value list, ordered by value, after checking the values run 0, 1, 2 and on. */
function namesByValue(values: Readonly<Record<string, number>>): string[] {
  const entries = Object.entries(values).sort(([, a], [, b]) => a - b);
  assert.deepEqual(
    entries.map(([, value]) => value),
    entries.map((_, index) => index),
  );
  return entries.map(([name]) => name);
}

describe("LedgerTrigger enums: fixed members in a fixed order", () => {
  it("declares exactly four enums: OrderKind, OrderStatus, FillBlocker and ActivationBlocker", () => {
    assert.deepEqual(enumNames(), [
      "OrderKind",
      "OrderStatus",
      "FillBlocker",
      "ActivationBlocker",
    ]);
  });

  for (const [enumName, members] of Object.entries(MEMBERS)) {
    it(`${enumName} has exactly the fixed members, in the fixed order`, () => {
      assert.deepEqual(enumMembers(enumName), [...members]);
    });
  }

  it("the value lists the tests use match the compiled enums, name for name and value for value", () => {
    assert.deepEqual(namesByValue(Kind), enumMembers("OrderKind"));
    assert.deepEqual(namesByValue(Status), enumMembers("OrderStatus"));
    assert.deepEqual(namesByValue(FillBlocker), enumMembers("FillBlocker"));
    assert.deepEqual(
      namesByValue(ActivationBlocker),
      enumMembers("ActivationBlocker"),
    );
  });
});
