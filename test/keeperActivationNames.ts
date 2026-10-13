import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ActivationBlocker,
  activationBlockerName,
  namesInOrder,
} from "../keeper/names.ts";

// The keeper writes the names of ActivationBlocker out by hand because the ABI
// has only the numbers. These tests read the enum's members, in declaration
// order, from the syntax tree in the compiler's build output and compare.

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

describe("keeper names of ActivationBlocker match the compiled contract", () => {
  it("ActivationBlocker: the same names, with the same values, as the contract declares", () => {
    const fromBuild = enumMembersFromBuild("ActivationBlocker");
    assert.deepEqual(namesInOrder(ActivationBlocker), fromBuild);
    assert.deepEqual(
      Object.values(ActivationBlocker).sort((a, b) => a - b),
      fromBuild.map((_, index) => index),
    );
  });

  it("turns each ActivationBlocker value into its name, and an unknown value into unknown(<value>)", () => {
    const fromBuild = enumMembersFromBuild("ActivationBlocker");
    for (const [index, name] of fromBuild.entries()) {
      assert.equal(activationBlockerName(index), name);
    }
    assert.equal(
      activationBlockerName(ActivationBlocker.PriceBelowActivation),
      "PriceBelowActivation",
    );
    assert.equal(
      activationBlockerName(fromBuild.length),
      `unknown(${fromBuild.length})`,
    );
    assert.equal(activationBlockerName(42), "unknown(42)");
  });
});
