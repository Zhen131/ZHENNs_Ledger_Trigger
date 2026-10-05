import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { zeroAddress } from "viem";

// 1 token in the smallest unit (6 decimals).
const ONE_TOKEN = 1_000_000n;

// Every test gets a brand-new local chain and a fresh token, so no state leaks
// between tests. Accounts are the built-in test accounts of the local chain.
async function deployFixture() {
  const { viem } = await network.create();
  const token = await viem.deployContract("MockUSDC");
  const [alice, bob] = await viem.getWalletClients();
  if (alice === undefined || bob === undefined) {
    throw new Error("the local chain must provide at least two test accounts");
  }
  return { viem, token, alice, bob };
}

describe("MockUSDC", () => {
  it("uses 6 decimals, like USDC", async () => {
    const { token } = await deployFixture();

    assert.equal(await token.read.decimals(), 6);
  });

  it("starts with zero supply", async () => {
    const { token, alice } = await deployFixture();

    assert.equal(await token.read.totalSupply(), 0n);
    assert.equal(await token.read.balanceOf([alice.account.address]), 0n);
  });

  it("lets an account mint to itself and leaves other accounts unchanged", async () => {
    const { viem, token, alice, bob } = await deployFixture();
    const amount = 250n * ONE_TOKEN;
    const aliceBefore = await token.read.balanceOf([alice.account.address]);
    const bobBefore = await token.read.balanceOf([bob.account.address]);

    await viem.assertions.emitWithArgs(
      token.write.mint([amount], { account: alice.account }),
      token,
      "Transfer",
      [zeroAddress, alice.account.address, amount],
    );

    assert.equal(
      await token.read.balanceOf([alice.account.address]),
      aliceBefore + amount,
    );
    assert.equal(await token.read.balanceOf([bob.account.address]), bobBefore);
    assert.equal(await token.read.totalSupply(), amount);
  });

  it("lets any account mint, each only to itself", async () => {
    const { token, alice, bob } = await deployFixture();

    await token.write.mint([3n * ONE_TOKEN], { account: alice.account });
    await token.write.mint([5n * ONE_TOKEN], { account: bob.account });
    await token.write.mint([7n * ONE_TOKEN], { account: alice.account });

    assert.equal(
      await token.read.balanceOf([alice.account.address]),
      10n * ONE_TOKEN,
    );
    assert.equal(
      await token.read.balanceOf([bob.account.address]),
      5n * ONE_TOKEN,
    );
    assert.equal(await token.read.totalSupply(), 15n * ONE_TOKEN);
  });

  it("moves exactly the transferred amount between the two accounts", async () => {
    const { token, alice, bob } = await deployFixture();
    await token.write.mint([100n * ONE_TOKEN], { account: alice.account });
    const sent = 40n * ONE_TOKEN;

    await token.write.transfer([bob.account.address, sent], {
      account: alice.account,
    });

    assert.equal(
      await token.read.balanceOf([alice.account.address]),
      100n * ONE_TOKEN - sent,
    );
    assert.equal(await token.read.balanceOf([bob.account.address]), sent);
    assert.equal(await token.read.totalSupply(), 100n * ONE_TOKEN);
  });

  it("rejects a transfer above the balance with a named error and moves nothing", async () => {
    const { viem, token, alice, bob } = await deployFixture();
    const balance = 10n * ONE_TOKEN;
    await token.write.mint([balance], { account: alice.account });
    const tooMuch = balance + 1n;

    await viem.assertions.revertWithCustomErrorWithArgs(
      token.write.transfer([bob.account.address, tooMuch], {
        account: alice.account,
      }),
      token,
      "ERC20InsufficientBalance",
      [alice.account.address, balance, tooMuch],
    );

    assert.equal(await token.read.balanceOf([alice.account.address]), balance);
    assert.equal(await token.read.balanceOf([bob.account.address]), 0n);
  });
});
