// The contract interfaces (ABIs) the keeper uses, read from Hardhat's build
// output, so they always match the compiled contracts. Run `npx hardhat build`
// (or `npm run check`) before starting the keeper.
//
// Two are read: LedgerTrigger, whose functions the keeper calls, and
// MockSwapVenue, the swap venue this project deploys, whose errors can come
// back through a fill and are decoded by name too.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { Abi } from "viem";
import type { ArtifactMap } from "hardhat/types/artifacts";

export type LedgerTriggerAbi = ArtifactMap["LedgerTrigger"]["abi"];

export type KeeperAbis = {
  /** The full LedgerTrigger ABI. */
  readonly trigger: LedgerTriggerAbi;
  /** Every error item of LedgerTrigger and of MockSwapVenue, for decoding. */
  readonly errors: Abi;
};

const CONTRACTS = path.join(
  import.meta.dirname,
  "..",
  "artifacts",
  "contracts",
);

/** Thrown when the build output is missing or not what it should be. */
export class BuildOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildOutputError";
  }
}

function readAbi(sourceFile: string, contractName: string): Abi {
  let artifact: unknown;
  try {
    const file = path.join(CONTRACTS, sourceFile, `${contractName}.json`);
    artifact = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BuildOutputError(
      `the build output of ${contractName} could not be read; run "npx hardhat build" first`,
    );
  }
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("contractName" in artifact) ||
    artifact.contractName !== contractName ||
    !("abi" in artifact) ||
    !Array.isArray(artifact.abi)
  ) {
    throw new BuildOutputError(
      `the build output of ${contractName} has no ABI; run "npx hardhat build" again`,
    );
  }
  return artifact.abi as Abi;
}

/** Reads both ABIs from the build output. Throws `BuildOutputError`. */
export function loadAbis(): KeeperAbis {
  const trigger = readAbi("LedgerTrigger.sol", "LedgerTrigger");
  const venue = readAbi("mocks/MockSwapVenue.sol", "MockSwapVenue");
  return {
    trigger: trigger as unknown as LedgerTriggerAbi,
    errors: [...trigger, ...venue].filter((item) => item.type === "error"),
  };
}
