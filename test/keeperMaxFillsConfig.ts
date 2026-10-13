import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  DEFAULTS,
  ENV,
  ProblemKind,
  REQUIRED,
  readConfig,
  type ConfigProblem,
  type KeeperConfig,
} from "../keeper/config.ts";

// The setting KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND: how many times one order
// may be filled in one round. Every key and URL here is made up on the spot
// and thrown away.

function freshEnvironment() {
  const privateKey = generatePrivateKey();
  const rpcUrl = `http://127.0.0.1:8545/v3/${randomBytes(16).toString("hex")}`;
  const env: Record<string, string | undefined> = {
    [ENV.rpcUrl]: rpcUrl,
    [ENV.privateKey]: privateKey,
    [ENV.contractAddress]: privateKeyToAccount(generatePrivateKey()).address,
    [ENV.fromBlock]: "0",
    [ENV.maxFeeWei]: "1000000000000000",
  };
  return { env, privateKey, rpcUrl };
}

function expectConfig(env: Record<string, string | undefined>): KeeperConfig {
  const result = readConfig(env);
  if (result.kind !== "config") {
    return assert.fail(
      `expected a configuration, got problems: ${JSON.stringify(result.problems)}`,
    );
  }
  return result.config;
}

function expectProblems(
  env: Record<string, string | undefined>,
): readonly ConfigProblem[] {
  const result = readConfig(env);
  if (result.kind !== "problems") {
    return assert.fail("expected problems, got a configuration");
  }
  return result.problems;
}

describe("keeper configuration: most fills of one order in one round", () => {
  it("is read from KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND, defaults to 5, and is not required", () => {
    assert.equal(
      ENV.maxFillsPerOrderPerRound,
      "KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND",
    );
    assert.equal(DEFAULTS.maxFillsPerOrderPerRound, 5);
    assert.deepEqual(
      [...REQUIRED],
      [
        "KEEPER_RPC_URL",
        "KEEPER_PRIVATE_KEY",
        "KEEPER_CONTRACT_ADDRESS",
        "KEEPER_FROM_BLOCK",
        "KEEPER_MAX_FEE_WEI",
      ],
    );
  });

  it("gives the default when the variable is not set or is empty, and reads 2 as 2", () => {
    const { env } = freshEnvironment();

    const unset = expectConfig(env);
    const empty = expectConfig({ ...env, [ENV.maxFillsPerOrderPerRound]: "" });
    const two = expectConfig({ ...env, [ENV.maxFillsPerOrderPerRound]: "2" });

    assert.equal(
      unset.maxFillsPerOrderPerRound,
      DEFAULTS.maxFillsPerOrderPerRound,
    );
    assert.equal(
      empty.maxFillsPerOrderPerRound,
      DEFAULTS.maxFillsPerOrderPerRound,
    );
    assert.equal(two.maxFillsPerOrderPerRound, 2);
  });

  const badValues: readonly [string, string][] = [
    ["zero", "0"],
    ["a decimal point", "1.5"],
    ["a word", "two"],
    ["a number too large for JavaScript", "1".repeat(20)],
  ];
  for (const [label, value] of badValues) {
    it(`rejects KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND given ${label}, naming the variable and repeating no key`, () => {
      const { env, privateKey, rpcUrl } = freshEnvironment();

      const problems = expectProblems({
        ...env,
        [ENV.maxFillsPerOrderPerRound]: value,
      });

      assert.deepEqual(
        problems.map((p) => [p.variable, p.kind]),
        [[ENV.maxFillsPerOrderPerRound, ProblemKind.Invalid]],
      );
      const text = JSON.stringify(problems).toLowerCase();
      for (const secret of [privateKey, privateKey.slice(2), rpcUrl]) {
        assert.ok(
          !text.includes(secret.toLowerCase()),
          "a problem repeats a key",
        );
      }
    });
  }
});
