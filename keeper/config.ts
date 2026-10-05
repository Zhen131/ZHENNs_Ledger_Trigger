// The keeper's configuration: every setting it takes, read from environment
// variables.
//
// `readConfig` is given the variables as an object (the entry point passes
// `process.env`) and never reads the environment itself. It checks every
// variable and reports every problem at once. A problem names the variable and
// says what is wrong in this file's own words; it never repeats the value,
// because two of the values are keys: the private key, and the node URL, which
// often carries an access key.

import { getAddress, isAddress, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The environment variable behind each setting. */
export const ENV = {
  rpcUrl: "KEEPER_RPC_URL",
  privateKey: "KEEPER_PRIVATE_KEY",
  contractAddress: "KEEPER_CONTRACT_ADDRESS",
  fromBlock: "KEEPER_FROM_BLOCK",
  maxFeeWei: "KEEPER_MAX_FEE_WEI",
  intervalSeconds: "KEEPER_INTERVAL_SECONDS",
  maxBlockRange: "KEEPER_MAX_BLOCK_RANGE",
} as const;

/** The variables that must be set; none of them has a default. */
export const REQUIRED = [
  ENV.rpcUrl,
  ENV.privateKey,
  ENV.contractAddress,
  ENV.fromBlock,
  ENV.maxFeeWei,
] as const;

/** Defaults of the two optional settings. */
export const DEFAULTS = {
  /** Seconds to wait between two rounds when the keeper keeps running. */
  intervalSeconds: 30,
  /**
   * Most blocks read in one event-log request. Many node services limit the
   * block span of one such request, so the keeper reads in pieces.
   */
  maxBlockRange: 500n,
} as const;

export type KeeperConfig = {
  /** URL of the node's JSON-RPC endpoint (http or https). A key: never print it. */
  readonly rpcUrl: string;
  /** The executor account, built from the private key. Never print the key. */
  readonly account: LocalAccount;
  /** The LedgerTrigger contract. */
  readonly contractAddress: Address;
  /** First block to read `OrderCreated` events from. */
  readonly fromBlock: bigint;
  /** Largest fee, in wei, the keeper may pay for one fill transaction. */
  readonly maxFeeWei: bigint;
  /** Seconds to wait between two rounds. */
  readonly intervalSeconds: number;
  /** Most blocks read in one event-log request. */
  readonly maxBlockRange: bigint;
};

/** What is wrong with one variable. */
export const ProblemKind = {
  Missing: "config-missing",
  Invalid: "config-invalid",
} as const;
export type ProblemKind = (typeof ProblemKind)[keyof typeof ProblemKind];

export type ConfigProblem = {
  readonly variable: string;
  readonly kind: ProblemKind;
  /** Says what is wrong, in this file's own words. Never holds the value. */
  readonly message: string;
};

export type ConfigResult =
  | { readonly kind: "config"; readonly config: KeeperConfig }
  | { readonly kind: "problems"; readonly problems: readonly ConfigProblem[] };

type Environment = Readonly<Record<string, string | undefined>>;

const PRIVATE_KEY = /^(?:0x)?([0-9a-fA-F]{64})$/;
const WHOLE_NUMBER = /^\d+$/;

/** Reads and checks every setting from `env`, usually `process.env`. */
export function readConfig(env: Environment): ConfigResult {
  const problems: ConfigProblem[] = [];
  const value = (name: string) => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === "" ? undefined : raw;
  };
  const invalid = (variable: string, message: string) => {
    problems.push({ variable, kind: ProblemKind.Invalid, message });
  };
  for (const name of REQUIRED) {
    if (value(name) === undefined) {
      problems.push({
        variable: name,
        kind: ProblemKind.Missing,
        message: "is required and not set",
      });
    }
  }

  const rpcUrl = value(ENV.rpcUrl);
  if (rpcUrl !== undefined && !isHttpUrl(rpcUrl)) {
    invalid(ENV.rpcUrl, "must be an http:// or https:// URL");
  }

  const account = readAccount(value(ENV.privateKey), invalid);

  const contractText = value(ENV.contractAddress);
  if (contractText !== undefined && !isAddress(contractText)) {
    invalid(
      ENV.contractAddress,
      "must be a 20-byte hex address (0x followed by 40 hex digits, with a valid checksum if mixed-case)",
    );
  }

  const fromBlock = readWhole(value(ENV.fromBlock), ENV.fromBlock, 0n, invalid);
  const maxFeeWei = readWhole(value(ENV.maxFeeWei), ENV.maxFeeWei, 1n, invalid);
  const interval = readWhole(
    value(ENV.intervalSeconds),
    ENV.intervalSeconds,
    1n,
    invalid,
  );
  const maxBlockRange = readWhole(
    value(ENV.maxBlockRange),
    ENV.maxBlockRange,
    1n,
    invalid,
  );
  if (interval !== undefined && interval > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(ENV.intervalSeconds, "is too large");
  }

  if (
    problems.length > 0 ||
    rpcUrl === undefined ||
    account === undefined ||
    contractText === undefined ||
    fromBlock === undefined ||
    maxFeeWei === undefined
  ) {
    return { kind: "problems", problems };
  }
  return {
    kind: "config",
    config: {
      rpcUrl,
      account,
      contractAddress: getAddress(contractText),
      fromBlock,
      maxFeeWei,
      intervalSeconds:
        interval === undefined ? DEFAULTS.intervalSeconds : Number(interval),
      maxBlockRange: maxBlockRange ?? DEFAULTS.maxBlockRange,
    },
  };
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The account for a private key written as 64 hex digits, with or without a
 * leading 0x. Reports a problem, without the key, when it is not one.
 */
function readAccount(
  text: string | undefined,
  invalid: (variable: string, message: string) => void,
): LocalAccount | undefined {
  if (text === undefined) return undefined;
  const digits = PRIVATE_KEY.exec(text)?.[1];
  if (digits === undefined) {
    invalid(
      ENV.privateKey,
      "must be 64 hex digits, with or without a leading 0x",
    );
    return undefined;
  }
  try {
    return privateKeyToAccount(`0x${digits.toLowerCase()}`);
  } catch {
    // The library's own message may repeat the key, so it is dropped.
    invalid(ENV.privateKey, "is not a valid secp256k1 private key");
    return undefined;
  }
}

/** A whole number in decimal digits, at least `min`, or a reported problem. */
function readWhole(
  text: string | undefined,
  variable: string,
  min: bigint,
  invalid: (variable: string, message: string) => void,
): bigint | undefined {
  if (text === undefined) return undefined;
  if (!WHOLE_NUMBER.test(text) || BigInt(text) < min) {
    invalid(variable, `must be a whole number of at least ${min}`);
    return undefined;
  }
  return BigInt(text);
}
