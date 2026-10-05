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

// Every key and URL here is made up on the spot and thrown away.

/** The order n of the secp256k1 group; a private key must be below it. */
const SECP256K1_ORDER = 2n ** 256n - 432420386565659656852420866394968145599n;

function freshEnvironment() {
  const privateKey = generatePrivateKey();
  const rpcUrl = `http://127.0.0.1:8545/v3/${randomBytes(16).toString("hex")}`;
  const contract = privateKeyToAccount(generatePrivateKey()).address;
  const env: Record<string, string | undefined> = {
    [ENV.rpcUrl]: rpcUrl,
    [ENV.privateKey]: privateKey,
    [ENV.contractAddress]: contract,
    [ENV.fromBlock]: "0",
    [ENV.maxFeeWei]: "1000000000000000",
  };
  return { env, privateKey, rpcUrl, contract };
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

/** No problem text holds any of `secrets`, in any letter case. */
function assertNoSecret(
  problems: readonly ConfigProblem[],
  secrets: readonly string[],
) {
  const text = JSON.stringify(problems).toLowerCase();
  for (const secret of secrets) {
    assert.ok(!text.includes(secret.toLowerCase()), "a problem repeats a key");
    assert.ok(
      !text.includes(secret.replace(/^0x/, "").toLowerCase()),
      "a problem repeats a key",
    );
  }
}

describe("keeper configuration: accepted values", () => {
  it("accepts a private key with a leading 0x and the same key without it, giving the same account", () => {
    const { env, privateKey } = freshEnvironment();
    const expected = privateKeyToAccount(privateKey).address;

    const withPrefix = expectConfig(env);
    const withoutPrefix = expectConfig({
      ...env,
      [ENV.privateKey]: privateKey.slice(2),
    });

    assert.equal(withPrefix.account.address, expected);
    assert.equal(withoutPrefix.account.address, expected);
  });

  it("accepts a private key in upper-case hex digits", () => {
    const { env, privateKey } = freshEnvironment();
    const config = expectConfig({
      ...env,
      [ENV.privateKey]: `0x${privateKey.slice(2).toUpperCase()}`,
    });
    assert.equal(
      config.account.address,
      privateKeyToAccount(privateKey).address,
    );
  });

  it("reads every setting and gives the two optional ones their defaults when they are not set", () => {
    const { env, rpcUrl, contract } = freshEnvironment();
    const config = expectConfig({ ...env, [ENV.fromBlock]: "1234" });

    assert.equal(config.rpcUrl, rpcUrl);
    assert.equal(config.contractAddress, contract);
    assert.equal(config.fromBlock, 1234n);
    assert.equal(config.maxFeeWei, 1_000_000_000_000_000n);
    assert.equal(config.intervalSeconds, DEFAULTS.intervalSeconds);
    assert.equal(config.maxBlockRange, DEFAULTS.maxBlockRange);
  });

  it("reads the two optional settings when they are set", () => {
    const { env } = freshEnvironment();
    const config = expectConfig({
      ...env,
      [ENV.intervalSeconds]: "5",
      [ENV.maxBlockRange]: "10",
    });
    assert.equal(config.intervalSeconds, 5);
    assert.equal(config.maxBlockRange, 10n);
  });

  it("ignores spaces and line breaks around a value, and treats an empty optional value as not set", () => {
    const { env, privateKey } = freshEnvironment();
    const config = expectConfig({
      ...env,
      [ENV.privateKey]: `  ${privateKey}\n`,
      [ENV.fromBlock]: " 7 ",
      [ENV.intervalSeconds]: "",
    });
    assert.equal(
      config.account.address,
      privateKeyToAccount(privateKey).address,
    );
    assert.equal(config.fromBlock, 7n);
    assert.equal(config.intervalSeconds, DEFAULTS.intervalSeconds);
  });

  it("accepts an all-lower-case contract address and returns it checksummed", () => {
    const { env, contract } = freshEnvironment();
    const config = expectConfig({
      ...env,
      [ENV.contractAddress]: contract.toLowerCase(),
    });
    assert.equal(config.contractAddress, contract);
  });
});

describe("keeper configuration: missing and invalid values", () => {
  for (const name of REQUIRED) {
    it(`names ${name} when it is missing, and repeats no key`, () => {
      const { env, privateKey, rpcUrl } = freshEnvironment();
      const problems = expectProblems({ ...env, [name]: undefined });

      assert.deepEqual(
        problems.map((p) => [p.variable, p.kind]),
        [[name, ProblemKind.Missing]],
      );
      assertNoSecret(problems, [privateKey, rpcUrl]);
    });
  }

  it("names every missing variable at once", () => {
    const problems = expectProblems({});
    assert.deepEqual(
      problems.map((p) => p.variable),
      [...REQUIRED],
    );
    assert.ok(problems.every((p) => p.kind === ProblemKind.Missing));
  });

  it("treats a blank required value as missing", () => {
    const { env } = freshEnvironment();
    const problems = expectProblems({ ...env, [ENV.contractAddress]: "   " });
    assert.deepEqual(
      problems.map((p) => [p.variable, p.kind]),
      [[ENV.contractAddress, ProblemKind.Missing]],
    );
  });

  const badKeys: readonly [string, (key: string) => string][] = [
    ["63 hex digits", (key) => key.slice(0, -1)],
    ["65 hex digits", (key) => `${key}0`],
    ["a letter that is not hex", (key) => `${key.slice(0, -1)}g`],
    ["0x twice", (key) => `0x${key}`],
    ["zero, which is no valid key", () => `0x${"0".repeat(64)}`],
    [
      "the order of the curve, which is no valid key",
      () => `0x${SECP256K1_ORDER.toString(16)}`,
    ],
  ];
  for (const [label, spoil] of badKeys) {
    it(`rejects a private key with ${label}, without repeating it`, () => {
      const { env, privateKey, rpcUrl } = freshEnvironment();
      const badKey = spoil(privateKey);
      const problems = expectProblems({ ...env, [ENV.privateKey]: badKey });

      assert.deepEqual(
        problems.map((p) => [p.variable, p.kind]),
        [[ENV.privateKey, ProblemKind.Invalid]],
      );
      assertNoSecret(problems, [privateKey, badKey, rpcUrl]);
    });
  }

  const badValues: readonly [string, string, string][] = [
    [ENV.rpcUrl, "a URL that is not http or https", "ftp://127.0.0.1/"],
    [ENV.rpcUrl, "text that is not a URL", "localhost 8545"],
    [ENV.contractAddress, "an address one digit short", "0x1234567890"],
    [
      ENV.contractAddress,
      "a mixed-case address with a wrong checksum",
      "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
    ],
    [ENV.fromBlock, "a negative block", "-1"],
    [ENV.fromBlock, "a block in hex", "0x10"],
    [ENV.maxFeeWei, "a fee cap of zero", "0"],
    [ENV.maxFeeWei, "a fee cap with a decimal point", "1.5"],
    [ENV.intervalSeconds, "an interval of zero", "0"],
    [ENV.intervalSeconds, "an interval too large for a number", "1".repeat(20)],
    [ENV.maxBlockRange, "a block range of zero", "0"],
    [ENV.maxBlockRange, "a block range that is not a number", "ten"],
  ];
  for (const [variable, label, value] of badValues) {
    it(`rejects ${variable} given ${label}`, () => {
      const { env, privateKey, rpcUrl } = freshEnvironment();
      const problems = expectProblems({ ...env, [variable]: value });

      assert.deepEqual(
        problems.map((p) => [p.variable, p.kind]),
        [[variable, ProblemKind.Invalid]],
      );
      assertNoSecret(problems, [privateKey, rpcUrl]);
    });
  }
});
