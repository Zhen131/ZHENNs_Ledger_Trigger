import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { namesInOrder } from "../keeper/names.ts";
import { FormKind, OrderKind, orderKindName } from "../web/src/lib/kinds.ts";

// The page writes the names of OrderKind out by hand because the ABI has only
// the numbers. These tests read the enum's members, in declaration order,
// from the syntax tree in the compiler's build output and compare.

const ARTIFACTS = path.join(import.meta.dirname, "..", "artifacts");

type AstNode = {
  readonly nodeType?: string;
  readonly name?: string;
  readonly nodes?: readonly AstNode[];
  readonly members?: readonly AstNode[];
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The members of `enumName` in `LedgerTrigger`, from the compiler's syntax tree. */
function enumMembersFromBuild(enumName: string): string[] {
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
  const definition = contract.nodes?.find(
    (node) => node.nodeType === "EnumDefinition" && node.name === enumName,
  );
  assert.ok(definition?.members, `the contract declares the enum ${enumName}`);
  return definition.members.map((member) => member.name ?? "");
}

describe("web order kinds match the compiled contract", () => {
  it("OrderKind: the same names, with the same values, as the contract declares", () => {
    const fromBuild = enumMembersFromBuild("OrderKind");
    assert.deepEqual(namesInOrder(OrderKind), fromBuild);
    assert.deepEqual(
      Object.values(OrderKind).sort((a, b) => a - b),
      fromBuild.map((_, index) => index),
    );
  });

  it("turns each OrderKind value into its name, and an unknown value into unknown(<value>)", () => {
    const fromBuild = enumMembersFromBuild("OrderKind");
    for (const [index, name] of fromBuild.entries()) {
      assert.equal(orderKindName(index), name);
    }
    assert.equal(orderKindName(OrderKind.Dca), "Dca");
    assert.equal(
      orderKindName(fromBuild.length),
      `unknown(${fromBuild.length})`,
    );
    assert.equal(orderKindName(42), "unknown(42)");
  });

  it("the order form offers four kinds, each with its own value", () => {
    assert.deepEqual(Object.values(FormKind), [
      "limit",
      "dormant-limit",
      "dca",
      "ladder",
    ]);
  });
});
