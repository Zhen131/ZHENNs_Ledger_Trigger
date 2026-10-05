import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import type { Hash } from "viem";

// Prices use the feed's decimals: with 8 decimals, 2000 USD is 2000 * 10^8.
const USD_8 = 100_000_000n;

// Every test gets a brand-new local chain. Times are set by the test itself.
async function deployFixture(decimals = 8, initialAnswer = 2_000n * USD_8) {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [alice, bob] = await viem.getWalletClients();
  if (alice === undefined || bob === undefined) {
    throw new Error("the local chain must provide at least two test accounts");
  }
  const feed = await viem.deployContract("MockPriceFeed", [
    decimals,
    initialAnswer,
  ]);

  /** Timestamp of the block that included the transaction. */
  async function blockTimeOf(hash: Hash): Promise<bigint> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    return block.timestamp;
  }

  async function latest() {
    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
      await feed.read.latestRoundData();
    return { roundId, answer, startedAt, updatedAt, answeredInRound };
  }

  return {
    viem,
    networkHelpers,
    publicClient,
    feed,
    alice,
    bob,
    blockTimeOf,
    latest,
  };
}

describe("MockPriceFeed", () => {
  for (const decimals of [8, 18, 6]) {
    it(`reports the decimals given at deployment (${decimals})`, async () => {
      const { feed } = await deployFixture(decimals);

      assert.equal(await feed.read.decimals(), decimals);
    });
  }

  it("reports the initial price as round 1, stamped with the deployment block's time", async () => {
    const { networkHelpers, feed, latest } = await deployFixture(
      8,
      1_850n * USD_8,
    );
    const deployedAt = BigInt(await networkHelpers.time.latest());

    const round = await latest();

    assert.equal(round.answer, 1_850n * USD_8);
    assert.equal(round.updatedAt, deployedAt);
    assert.equal(round.roundId, 1n);
    assert.equal(await feed.read.decimals(), 8);
  });

  it("returns a newly set price unchanged, stamped with the time of the block that set it", async () => {
    const { networkHelpers, feed, blockTimeOf, latest } = await deployFixture();
    const chosenTime = BigInt(await networkHelpers.time.latest()) + 3_600n;
    await networkHelpers.time.setNextBlockTimestamp(chosenTime);

    const blockTime = await blockTimeOf(
      await feed.write.setAnswer([199_912_345_678n]),
    );

    const round = await latest();
    assert.equal(blockTime, chosenTime);
    assert.equal(round.answer, 199_912_345_678n);
    assert.equal(round.updatedAt, blockTime);
  });

  it("raises the round ID every time the price is set", async () => {
    const { networkHelpers, feed, latest } = await deployFixture();
    const seen = [(await latest()).roundId];

    for (const price of [2_100n * USD_8, 2_050n * USD_8, 2_050n * USD_8]) {
      await networkHelpers.time.increase(60);
      await feed.write.setAnswer([price]);
      const round = await latest();
      assert.equal(round.answer, price);
      seen.push(round.roundId);
    }

    for (let i = 1; i < seen.length; i += 1) {
      const previous = seen[i - 1] ?? 0n;
      const current = seen[i] ?? 0n;
      assert.ok(current > previous, `round IDs ${seen.join(", ")}`);
      assert.equal(current, previous + 1n);
    }
  });

  for (const [label, price] of [
    ["zero", 0n],
    ["minus one", -1n],
    ["a large negative number", -2_000n * USD_8],
  ] as const) {
    it(`stores a price of ${label} as given`, async () => {
      const { networkHelpers, feed, blockTimeOf, latest } =
        await deployFixture();
      await networkHelpers.time.increase(30);

      const blockTime = await blockTimeOf(await feed.write.setAnswer([price]));

      const round = await latest();
      assert.equal(round.answer, price);
      assert.equal(round.updatedAt, blockTime);
    });
  }

  it("sets the update time on its own, to a past or a future moment, leaving price and round alone", async () => {
    const { networkHelpers, feed, latest } = await deployFixture();
    await networkHelpers.time.increase(10_000);
    await feed.write.setAnswer([2_222n * USD_8]);
    const before = await latest();
    const now = BigInt(await networkHelpers.time.latest());

    for (const moment of [now - 7_200n, now + 86_400n, 0n, now]) {
      await feed.write.setUpdatedAt([moment]);

      const round = await latest();
      assert.equal(round.updatedAt, moment);
      assert.equal(round.answer, before.answer);
      assert.equal(round.roundId, before.roundId);
    }
  });

  it("keeps the rest of the round data consistent with the round and the update time", async () => {
    const { networkHelpers, feed, latest } = await deployFixture();
    await networkHelpers.time.increase(120);
    await feed.write.setAnswer([1_500n * USD_8]);
    await feed.write.setUpdatedAt([1_000n]);

    const round = await latest();

    assert.equal(round.startedAt, round.updatedAt);
    assert.equal(round.answeredInRound, round.roundId);
  });

  it("lets any account set the price and the update time", async () => {
    const { feed, bob, latest } = await deployFixture();

    await feed.write.setAnswer([-5n], { account: bob.account });
    await feed.write.setUpdatedAt([42n], { account: bob.account });

    const round = await latest();
    assert.equal(round.answer, -5n);
    assert.equal(round.updatedAt, 42n);
  });
});
