import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifacts } from "hardhat";

// The order contract talks to the price feed and the swap venue only through
// these two interfaces, so their function signatures are fixed here. The price
// feed functions must match the Chainlink Data Feeds API reference
// (https://docs.chain.link/data-feeds/api-reference, AggregatorV3Interface)
// exactly, so that a real Chainlink feed fits where the mock feed is used.

type AbiParameter = { readonly name: string; readonly type: string };
type AbiEntry = {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
  readonly inputs?: readonly AbiParameter[];
  readonly outputs?: readonly AbiParameter[];
};

/** One line per function: mutability, name, inputs and named outputs. */
function functionSignatures(abi: readonly AbiEntry[]): string[] {
  const show = (parameters: readonly AbiParameter[] = []) =>
    parameters
      .map((parameter) => `${parameter.type} ${parameter.name}`.trim())
      .join(", ");
  return abi
    .filter((entry) => entry.type === "function")
    .map(
      (entry) =>
        `${entry.name ?? ""}(${show(entry.inputs)}) ${entry.stateMutability ?? ""} returns (${show(entry.outputs)})`,
    )
    .sort();
}

describe("interfaces", () => {
  it("IPriceFeed has exactly the two Chainlink functions, with Chainlink's signatures", async () => {
    const { abi } = await artifacts.readArtifact("IPriceFeed");

    assert.deepEqual(functionSignatures(abi), [
      "decimals() view returns (uint8)",
      "latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    ]);
    assert.deepEqual(
      abi.filter((entry) => entry.type !== "function"),
      [],
      "the interface declares nothing but functions",
    );
  });

  it("ISwapVenue has exactly one function: swapUsdcForEth", async () => {
    const { abi } = await artifacts.readArtifact("ISwapVenue");

    assert.deepEqual(functionSignatures(abi), [
      "swapUsdcForEth(uint256 usdcAmount, uint256 minEthOut) nonpayable returns (uint256 ethOut)",
    ]);
    assert.deepEqual(
      abi.filter((entry) => entry.type !== "function"),
      [],
      "the interface declares nothing but functions",
    );
  });
});
