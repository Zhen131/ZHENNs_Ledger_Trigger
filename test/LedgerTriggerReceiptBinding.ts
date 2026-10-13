import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getAddress,
  getContractAddress,
  zeroAddress,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  DEFAULT_LIMITS,
  deployLedgerTrigger,
  type TriggerOverrides,
} from "./deployLedgerTrigger.ts";
import { setUpScripts } from "./setUpScripts.ts";

// LedgerTrigger and its receipt contract are bound to each other at
// deployment: the receipt contract is deployed first, bound to the address
// LedgerTrigger is about to get, and LedgerTrigger's constructor checks that
// the receipt contract names it. Also: only LedgerTrigger can issue receipts,
// and the two test helpers deploy each LedgerTrigger with its own receipt
// contract.

type Fixture = Awaited<ReturnType<typeof deployLedgerTrigger>>;

/** An address with nothing deployed at it. */
function emptyAddress(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

/** True when `address` holds no contract code. */
async function hasNoCode(f: Fixture, address: Address): Promise<boolean> {
  const code = await f.publicClient.getCode({ address });
  return code === undefined || code === "0x";
}

/** The deployer's transaction count, counting transactions not yet mined. */
function deployerNonce(f: Fixture): Promise<number> {
  return f.publicClient.getTransactionCount({
    address: f.deployer.account.address,
    blockTag: "pending",
  });
}

/** The address the deployer's next deployment after `skip` others will get. */
async function nextDeployAddress(f: Fixture, skip = 0n): Promise<Address> {
  return getContractAddress({
    from: f.deployer.account.address,
    nonce: BigInt(await deployerNonce(f)) + skip,
  });
}

/**
 * Runs `deploy`, which must be rejected, and checks that it left nothing
 * behind: the block number and the deployer's transaction count are the same
 * as before, and the address LedgerTrigger would have got holds no code.
 */
async function assertDeployLeavesNothing(
  f: Fixture,
  deploy: () => Promise<void>,
) {
  const blockBefore = await f.publicClient.getBlockNumber({ cacheTime: 0 });
  const nonceBefore = await deployerNonce(f);
  const wouldBe = await nextDeployAddress(f);

  await deploy();

  assert.equal(
    await f.publicClient.getBlockNumber({ cacheTime: 0 }),
    blockBefore,
  );
  assert.equal(await deployerNonce(f), nonceBefore);
  assert.ok(await hasNoCode(f, wouldBe));
}

/** A FillReceipt bound to `boundTo`, deployed by the deployer. */
function receiptBoundTo(f: Fixture, boundTo: Address) {
  return f.viem.deployContract("FillReceipt", [boundTo]);
}

/** deployTrigger(overrides), as a promise of the address, for the assertions. */
function deployAddress(f: Fixture, overrides: TriggerOverrides) {
  return f.deployTrigger(overrides).then((deployed) => deployed.address);
}

describe("LedgerTrigger deployment: binding to the receipt contract (S59)", () => {
  it("S59 refuses to deploy when the receipt contract address is the zero address, with ZeroReceipt, and leaves nothing behind", async () => {
    const f = await deployLedgerTrigger();

    await assertDeployLeavesNothing(f, () =>
      f.viem.assertions.revertWithCustomError(
        deployAddress(f, { receipt: zeroAddress }),
        f.trigger,
        "ZeroReceipt",
      ),
    );
  });

  it("S59 refuses to deploy with a receipt contract bound to a plain account, with ReceiptNotBound naming the receipt contract and that account, and leaves nothing behind", async () => {
    const f = await deployLedgerTrigger();
    const account = getAddress(f.stranger.account.address);
    const fillReceipt = await receiptBoundTo(f, account);

    await assertDeployLeavesNothing(f, () =>
      f.viem.assertions.revertWithCustomErrorWithArgs(
        deployAddress(f, { receipt: fillReceipt.address }),
        f.trigger,
        "ReceiptNotBound",
        [getAddress(fillReceipt.address), account],
      ),
    );
  });

  it("S59 refuses to deploy with the receipt contract of another LedgerTrigger, with ReceiptNotBound naming it and that LedgerTrigger, and leaves nothing behind", async () => {
    const f = await deployLedgerTrigger();

    await assertDeployLeavesNothing(f, () =>
      f.viem.assertions.revertWithCustomErrorWithArgs(
        deployAddress(f, { receipt: f.fillReceipt.address }),
        f.trigger,
        "ReceiptNotBound",
        [getAddress(f.fillReceipt.address), getAddress(f.trigger.address)],
      ),
    );
  });

  it("S59 refuses to deploy when the deployer sends another transaction between the receipt contract and LedgerTrigger: LedgerTrigger would get the next address, so ReceiptNotBound names the address worked out first, which stays empty", async () => {
    const f = await deployLedgerTrigger();
    const workedOut = await nextDeployAddress(f, 1n);
    const fillReceipt = await receiptBoundTo(f, workedOut);
    await f.mined(
      await f.deployer.sendTransaction({
        to: f.stranger.account.address,
        value: 1n,
      }),
    );

    await assertDeployLeavesNothing(f, () =>
      f.viem.assertions.revertWithCustomErrorWithArgs(
        deployAddress(f, { receipt: fillReceipt.address }),
        f.trigger,
        "ReceiptNotBound",
        [getAddress(fillReceipt.address), workedOut],
      ),
    );
    assert.ok(await hasNoCode(f, workedOut));
  });

  it("S59 refuses to deploy when the receipt contract address holds no code, and leaves nothing behind", async () => {
    const f = await deployLedgerTrigger();

    await assertDeployLeavesNothing(f, () =>
      assert.rejects(deployAddress(f, { receipt: emptyAddress() })),
    );
  });

  it("S59 checks the receipt contract after the nine other parameters and before reading the decimals of the token and the price feed", async () => {
    const f = await deployLedgerTrigger();
    const account = getAddress(f.stranger.account.address);
    const unbound = await receiptBoundTo(f, account);

    // The nine other parameters come first.
    await f.viem.assertions.revertWithCustomError(
      deployAddress(f, { usdc: zeroAddress, receipt: zeroAddress }),
      f.trigger,
      "ZeroUsdc",
    );
    await f.viem.assertions.revertWithCustomError(
      deployAddress(f, { maxTiersPerOrder: 0n, receipt: zeroAddress }),
      f.trigger,
      "ZeroMaxTiersPerOrder",
    );
    // The receipt contract comes before the decimals are read: a price feed
    // or a token with no code would make that reading fail with no data.
    await f.viem.assertions.revertWithCustomError(
      deployAddress(f, { receipt: zeroAddress, priceFeed: emptyAddress() }),
      f.trigger,
      "ZeroReceipt",
    );
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      deployAddress(f, { receipt: unbound.address, usdc: emptyAddress() }),
      f.trigger,
      "ReceiptNotBound",
      [getAddress(unbound.address), account],
    );
  });

  it("S59 two LedgerTriggers deployed one after the other each get a receipt contract of their own, bound to them", async () => {
    const f = await deployLedgerTrigger();

    const first = await f.deployTrigger();
    const second = await f.deployTrigger();

    const seen = new Set<string>();
    for (const trigger of [f.trigger, first, second]) {
      const receipt = await trigger.read.receipt();
      const fillReceipt = await f.viem.getContractAt("FillReceipt", receipt);
      assert.equal(
        await fillReceipt.read.trigger(),
        getAddress(trigger.address),
      );
      seen.add(receipt);
    }
    assert.equal(seen.size, 3);
  });
});

describe("LedgerTrigger receipts: only LedgerTrigger can issue them (S58)", () => {
  it("S58 refuses mint called straight on the receipt contract by a stranger, the owner, the executor or the recipient, with NotTrigger naming the caller, and no receipt comes out of it", async () => {
    const f = await deployLedgerTrigger();
    const data = {
      orderId: 1n,
      fillNumber: 1n,
      usdcIn: 100_000_000n,
      ethOut: 50_000_000_000_000_000n,
      price: 200_000_000_000n,
      filledAt: 1_800_000_000n,
    };

    for (const caller of [f.stranger, f.owner, f.executor, f.recipient]) {
      await f.viem.assertions.revertWithCustomErrorWithArgs(
        f.fillReceipt.write.mint([caller.account.address, data], {
          account: caller.account,
        }),
        f.fillReceipt,
        "NotTrigger",
        [getAddress(caller.account.address)],
      );
    }
    for (const wallet of [f.stranger, f.owner, f.executor, f.recipient]) {
      assert.equal(
        await f.fillReceipt.read.balanceOf([wallet.account.address]),
        0n,
      );
    }
    await f.viem.assertions.revertWithCustomErrorWithArgs(
      f.fillReceipt.read.ownerOf([1n]),
      f.fillReceipt,
      "ERC721NonexistentToken",
      [1n],
    );
  });
});

describe("test helpers: each LedgerTrigger with a receipt contract of its own", () => {
  it("deployLedgerTrigger returns the receipt contract bound to the LedgerTrigger it returns, with the same parameters and defaults as before", async () => {
    const f = await deployLedgerTrigger();

    assert.equal(
      await f.fillReceipt.read.trigger(),
      getAddress(f.trigger.address),
    );
    assert.equal(
      await f.trigger.read.receipt(),
      getAddress(f.fillReceipt.address),
    );
    assert.deepEqual(f.parameters, {
      usdc: f.usdc.address,
      priceFeed: f.feed.address,
      swapVenue: f.venue.address,
      ...DEFAULT_LIMITS,
    });
    assert.equal(
      await f.trigger.read.maxOrderAmount(),
      DEFAULT_LIMITS.maxOrderAmount,
    );
    assert.equal(
      await f.trigger.read.maxTiersPerOrder(),
      DEFAULT_LIMITS.maxTiersPerOrder,
    );
  });

  it("deployTrigger deploys a new receipt contract before each LedgerTrigger, two blocks in all, the LedgerTrigger landing on the address worked out first", async () => {
    const f = await deployLedgerTrigger();
    const blockBefore = await f.publicClient.getBlockNumber({ cacheTime: 0 });
    const receiptToBe = await nextDeployAddress(f);
    const triggerToBe = await nextDeployAddress(f, 1n);

    const trigger = await f.deployTrigger();

    assert.equal(getAddress(trigger.address), triggerToBe);
    assert.equal(await trigger.read.receipt(), receiptToBe);
    assert.equal(
      await f.publicClient.getBlockNumber({ cacheTime: 0 }),
      blockBefore + 2n,
    );
  });

  it("deployTrigger uses a receipt contract it is given as it is, and deploys nothing else", async () => {
    const f = await deployLedgerTrigger();
    const fillReceipt = await receiptBoundTo(f, await nextDeployAddress(f, 1n));
    const blockBefore = await f.publicClient.getBlockNumber({ cacheTime: 0 });

    const trigger = await f.deployTrigger({ receipt: fillReceipt.address });

    assert.equal(await trigger.read.receipt(), getAddress(fillReceipt.address));
    assert.equal(
      await f.publicClient.getBlockNumber({ cacheTime: 0 }),
      blockBefore + 1n,
    );
  });

  it("setUpScripts().withParts() returns the receipt contract bound to the LedgerTrigger it returns", async () => {
    const s = await setUpScripts();

    const { trigger, fillReceipt } = await s.withParts();

    assert.equal(await fillReceipt.read.trigger(), getAddress(trigger.address));
    assert.equal(await trigger.read.receipt(), getAddress(fillReceipt.address));
    assert.equal(await trigger.read.maxPriceAge(), 4_500n);
  });
});
