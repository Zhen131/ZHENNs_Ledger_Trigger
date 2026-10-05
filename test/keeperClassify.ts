import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  TimeoutError,
  createPublicClient,
  encodeErrorResult,
  http,
  parseAbi,
  toFunctionSelector,
  type Hash,
} from "viem";

import { loadAbis } from "../keeper/abi.ts";
import {
  Cause,
  FailureKind,
  Verdict,
  classifyFailure,
  type Classification,
} from "../keeper/classify.ts";
import { failureEntry, formatLogLine } from "../keeper/log.ts";
import { ONE_USDC, usd } from "./deployLedgerTrigger.ts";
import { ONE_ETH, setUpFills, type Wallet } from "./setUpFills.ts";
import { unusedPort } from "./unusedPort.ts";

// One case per row of the keeper's failure table: a named contract error, a
// mined transaction whose receipt says it failed, revert data no ABI here can
// name, a node error that is not a revert, and a node that cannot be reached.
// Wherever the local chain can produce the failure for real, it does.

const abis = loadAbis();

function classify(error: unknown): Classification {
  return classifyFailure({ kind: FailureKind.Thrown, error }, abis.errors);
}

/** The log line for a failure, stamped at a fixed time. */
function logLine(orderId: bigint | undefined, c: Classification): string {
  return formatLogLine(failureEntry(orderId, "simulate", c), new Date(0));
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected the call to fail");
}

type Fixture = Awaited<ReturnType<typeof setUpFills>>;

/** Simulates `fillOrder` as `from` and returns what it threw. */
function simulateFill(
  f: Fixture,
  orderId: bigint,
  trigger: Fixture["trigger"] = f.trigger,
  from: Wallet = f.executor,
) {
  return caught(
    f.publicClient.simulateContract({
      address: trigger.address,
      abi: trigger.abi,
      functionName: "fillOrder",
      args: [orderId],
      account: from.account,
    }),
  );
}

/** A revert error as viem builds it, around the given revert data. */
function revertWith(data: `0x${string}` | undefined) {
  const revert = new ContractFunctionRevertedError({
    abi: [],
    data,
    functionName: "fillOrder",
  });
  return new ContractFunctionExecutionError(revert, {
    abi: [],
    functionName: "fillOrder",
  });
}

describe("keeper failure table: a revert with a name is a skip, logged by name", () => {
  it("names a LedgerTrigger error: the price is above the target", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place({ targetPrice: usd(1_900n) });

    const c = classify(await simulateFill(f, orderId));

    assert.deepEqual(c, {
      verdict: Verdict.Skip,
      cause: Cause.NamedError,
      errorName: "PriceAboveTarget",
    });
    assert.match(
      logLine(orderId, c),
      /^1970-01-01T00:00:00\.000Z order=1 action=skip reason=PriceAboveTarget step=simulate$/,
    );
  });

  it("names the error after the owner cancelled first (OrderNotOpen) and after the order expired (OrderExpired)", async () => {
    const f = await setUpFills();
    const cancelled = await f.place();
    const expiring = await f.place();
    await f.mined(
      await f.trigger.write.cancelOrder([cancelled.orderId], {
        account: f.owner.account,
      }),
    );
    await f.networkHelpers.time.increaseTo(expiring.input.expiry + 1n);

    assert.deepEqual(classify(await simulateFill(f, cancelled.orderId)), {
      verdict: Verdict.Skip,
      cause: Cause.NamedError,
      errorName: "OrderNotOpen",
    });
    assert.deepEqual(classify(await simulateFill(f, expiring.orderId)), {
      verdict: Verdict.Skip,
      cause: Cause.NamedError,
      errorName: "OrderExpired",
    });
  });

  it("names a swap venue error that comes back through the fill", async () => {
    const f = await setUpFills();
    const highFee = await f.viem.deployContract("MockSwapVenue", [
      f.usdc.address,
      f.feed.address,
      200n,
    ]);
    await f.mined(
      await f.deployer.sendTransaction({
        to: highFee.address,
        value: 10n * ONE_ETH,
      }),
    );
    const trigger = await f.deployTrigger({ swapVenue: highFee.address });
    await f.approve(f.owner, 1_000n * ONE_USDC, trigger.address);
    const { orderId } = await f.place({}, f.owner, trigger);

    const c = classify(await simulateFill(f, orderId, trigger));

    assert.deepEqual(c, {
      verdict: Verdict.Skip,
      cause: Cause.NamedError,
      errorName: "InsufficientOutput",
    });
    assert.match(
      logLine(orderId, c),
      / action=skip reason=InsufficientOutput /,
    );
  });

  it("names Solidity's built-in Error(string) and Panic(uint256)", () => {
    const builtIn = parseAbi([
      "error Error(string message)",
      "error Panic(uint256 code)",
    ]);
    const error = encodeErrorResult({
      abi: builtIn,
      errorName: "Error",
      args: ["refused"],
    });
    const panic = encodeErrorResult({
      abi: builtIn,
      errorName: "Panic",
      args: [0x11n],
    });

    assert.deepEqual(classify(revertWith(error)), {
      verdict: Verdict.Skip,
      cause: Cause.NamedError,
      errorName: "Error",
    });
    assert.deepEqual(classify(revertWith(panic)), {
      verdict: Verdict.Skip,
      cause: Cause.NamedError,
      errorName: "Panic",
    });
  });
});

describe("keeper failure table: a mined transaction that failed is a skip, logged by hash", () => {
  it("logs the hash of a fill transaction that was mined and reverted", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place({ targetPrice: usd(1_900n) });
    await caught(f.sendFill(orderId));
    const block = await f.publicClient.getBlock();
    const hash: Hash | undefined = block.transactions[0];
    assert.ok(hash !== undefined, "the failed fill was mined");
    const receipt = await f.publicClient.getTransactionReceipt({ hash });
    assert.equal(receipt.status, "reverted");

    const c = classifyFailure(
      { kind: FailureKind.RevertedReceipt, transactionHash: hash },
      abis.errors,
    );

    assert.deepEqual(c, {
      verdict: Verdict.Skip,
      cause: Cause.RevertedTransaction,
      transactionHash: hash,
    });
    assert.ok(
      logLine(orderId, c).endsWith(
        ` action=skip reason=transaction-reverted step=simulate tx=${hash}`,
      ),
    );
  });
});

describe("keeper failure table: revert data that no ABI here names is a skip, logged by its first 4 bytes", () => {
  it("logs the selector of an error only an unknown swap venue declares", async () => {
    const f = await setUpFills();
    const cheat = await f.viem.deployContract("ShortChangingSwapVenue", [
      f.usdc.address,
    ]);
    await f.mined(await cheat.write.setMode([0, ONE_ETH]));
    const trigger = await f.deployTrigger({ swapVenue: cheat.address });
    await f.approve(f.owner, 1_000n * ONE_USDC, trigger.address);
    const { orderId } = await f.place({}, f.owner, trigger);
    const selector = toFunctionSelector("EthPaymentFailed()");

    const c = classify(await simulateFill(f, orderId, trigger));

    assert.deepEqual(c, {
      verdict: Verdict.Skip,
      cause: Cause.UnnamedError,
      selector,
    });
    assert.ok(
      logLine(orderId, c).endsWith(
        ` action=skip reason=unknown-contract-error step=simulate selector=${selector}`,
      ),
    );
  });

  it("keeps only the first 4 bytes of longer revert data", () => {
    const data = `0xdeadbeef${"00".repeat(32)}` as const;
    assert.deepEqual(classify(revertWith(data)), {
      verdict: Verdict.Skip,
      cause: Cause.UnnamedError,
      selector: "0xdeadbeef",
    });
  });
});

describe("keeper failure table: a node error that is not a revert is an error", () => {
  it("an executor with no ETH for gas: the send fails with a node error", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.networkHelpers.setBalance(f.executor.account.address, 0n);

    const c = classify(await caught(f.sendFill(orderId)));

    assert.equal(c.verdict, Verdict.Error);
    assert.equal(c.cause, Cause.NodeError);
    const line = logLine(orderId, c);
    assert.match(
      line,
      / action=error reason=node-error step=simulate message="The node reported an error that is not a contract revert\." types=\w/,
    );
  });

  it("a nonce that was already used: the send fails with a node error", async () => {
    const f = await setUpFills();
    const { orderId } = await f.place();
    await f.mined(
      await f.executor.sendTransaction({
        to: f.stranger.account.address,
        value: 1n,
      }),
    );

    const c = classify(
      await caught(
        f.trigger.write.fillOrder([orderId], {
          account: f.executor.account,
          gas: 1_000_000n,
          nonce: 0,
        }),
      ),
    );

    assert.equal(c.verdict, Verdict.Error);
    assert.equal(c.cause, Cause.NodeError);
  });

  it("a revert error that carries no revert data at all", () => {
    assert.equal(classify(revertWith(undefined)).cause, Cause.NodeError);
    assert.equal(classify(revertWith("0x")).cause, Cause.NodeError);
  });

  it("an error that is not from the client library at all", () => {
    const c = classify(new TypeError("something else"));
    assert.deepEqual(c, {
      verdict: Verdict.Error,
      cause: Cause.NodeError,
      errorTypes: ["TypeError"],
    });
  });
});

describe("keeper failure table: a node that cannot be reached is an error", () => {
  it("a node URL on a local port nobody listens on; the log has neither the URL nor its key", async () => {
    const fakeKey = randomBytes(16).toString("hex");
    const url = `http://127.0.0.1:${await unusedPort()}/v3/${fakeKey}`;
    const client = createPublicClient({
      transport: http(url, { retryCount: 0 }),
    });

    const c = classify(await caught(client.getChainId()));

    assert.equal(c.verdict, Verdict.Error);
    assert.equal(c.cause, Cause.NodeUnreachable);
    const line = logLine(undefined, c);
    assert.match(
      line,
      / order=- action=error reason=node-unreachable step=simulate message="Could not reach the node\." types=HttpRequestError/,
    );
    assert.ok(!line.includes(fakeKey));
    assert.ok(!line.includes("127.0.0.1"));
  });

  it("a request that timed out", () => {
    const c = classify(
      new TimeoutError({ body: {}, url: "http://127.0.0.1:1/" }),
    );
    assert.deepEqual(c, {
      verdict: Verdict.Error,
      cause: Cause.NodeUnreachable,
      errorTypes: ["TimeoutError"],
    });
  });
});
