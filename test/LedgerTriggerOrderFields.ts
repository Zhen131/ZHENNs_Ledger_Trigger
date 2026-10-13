import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { ONE_USDC } from "./deployLedgerTrigger.ts";
import { Kind, Status, setUpFills } from "./setUpFills.ts";

// The fields an order of the kind `createOrder` places carries besides the
// first eight: its kind, its activation price, what it has left to spend and
// how many fills it takes and has had. Each is checked when the order is
// placed, after it is filled and after it is cancelled.

describe("LedgerTrigger order fields: an order placed with createOrder", () => {
  it("is a Limit order with no activation price, filled once for all of its amount, and OrderCreated says so", async () => {
    const { publicClient, trigger, place } = await setUpFills();

    const { orderId, input } = await place({ usdcAmount: 42n * ONE_USDC });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.kind, Kind.Limit);
    assert.equal(order.status, Status.Open);
    assert.equal(order.activationPrice, 0n);
    assert.equal(order.usdcAmount, input.usdcAmount);
    assert.equal(order.usdcRemaining, input.usdcAmount);
    assert.equal(order.fillsTotal, 1n);
    assert.equal(order.fillsDone, 0n);
    const created = await publicClient.getContractEvents({
      address: trigger.address,
      abi: trigger.abi,
      eventName: "OrderCreated",
      args: { orderId },
      fromBlock: 0n,
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.args.kind, Kind.Limit);
    assert.equal(created[0]?.args.activationPrice, 0n);
  });

  it("after its fill has had one fill of one, nothing left to spend and status Filled; OrderFilled numbers the fill from the order", async () => {
    const { trigger, owner, place, fill, bookOf } = await setUpFills();
    const { orderId, input } = await place({ usdcAmount: 64n * ONE_USDC });
    await place({ usdcAmount: 10n * ONE_USDC });

    const { event } = await fill(orderId);

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Filled);
    assert.equal(order.fillsDone, 1n);
    assert.equal(order.fillsTotal, 1n);
    assert.equal(order.usdcRemaining, 0n);
    assert.equal(order.usdcAmount, input.usdcAmount);
    assert.equal(event.args.fillNumber, 1n);
    assert.equal(event.args.fillsTotal, 1n);
    assert.equal(event.args.fillNumber, order.fillsDone);
    assert.equal(event.args.fillsTotal, order.fillsTotal);
    assert.equal(event.args.usdcAmount, input.usdcAmount);
    assert.deepEqual(await bookOf(owner), {
      count: 1n,
      total: 10n * ONE_USDC,
    });
  });

  it("after it is cancelled is Cancelled with what it had left to spend kept, and leaves the owner's open count and total", async () => {
    const { trigger, owner, place, bookOf } = await setUpFills();
    await place({ usdcAmount: 15n * ONE_USDC });
    const { orderId, input } = await place({ usdcAmount: 33n * ONE_USDC });
    assert.deepEqual(await bookOf(owner), {
      count: 2n,
      total: 48n * ONE_USDC,
    });

    await trigger.write.cancelOrder([orderId], { account: owner.account });

    const order = await trigger.read.getOrder([orderId]);
    assert.equal(order.status, Status.Cancelled);
    assert.equal(order.usdcRemaining, input.usdcAmount);
    assert.equal(order.usdcAmount, input.usdcAmount);
    assert.equal(order.fillsDone, 0n);
    assert.equal(order.kind, Kind.Limit);
    assert.equal(order.activationPrice, 0n);
    assert.equal(order.owner, getAddress(owner.account.address));
    assert.deepEqual(await bookOf(owner), {
      count: 1n,
      total: 15n * ONE_USDC,
    });
  });
});
