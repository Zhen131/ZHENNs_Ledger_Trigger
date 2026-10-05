// Sets up a brand-new in-process chain for the tests of the deployment,
// operation and demo scripts. With `chainId`, the chain reports that chain ID
// instead of Hardhat's 31337: it is still the in-process chain on this
// machine, with no network behind it, so the send gate can be tested on a
// chain it must treat as not local.
//
// The chain is always Hardhat's in-process one (the network named "default"),
// whatever network was selected with --network or HARDHAT_NETWORK. Tests that
// use it pass the send gate with the confirmation sentence, and that must
// never open a connection to another node.
//
// `withParts` also deploys the full set directly, without the scripts:
// MockUSDC, MockPriceFeed (8 decimals, 2000 USD), MockSwapVenue (no fee,
// stocked with 10 ETH) and LedgerTrigger with the default limits, and mints
// 1000 USDC to the owner.
//
// This file holds no tests; test files import `setUpScripts` from it.

import { network } from "hardhat";

const ONE_USDC = 1_000_000n;
const ONE_ETH = 10n ** 18n;
/** Hardhat's built-in in-process network; this configuration does not change it. */
const IN_PROCESS_NETWORK = "default";

export async function setUpScripts(
  options: { readonly chainId?: number } = {},
) {
  const connection = await network.create(
    options.chainId === undefined
      ? { network: IN_PROCESS_NETWORK }
      : {
          network: IN_PROCESS_NETWORK,
          override: { chainId: options.chainId },
        },
  );
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const account = (index: number) => {
    const wallet = wallets[index];
    if (wallet === undefined) {
      throw new Error(
        "the local chain must provide at least four test accounts",
      );
    }
    return wallet;
  };
  const owner = account(0);
  const executor = account(1);
  const recipient = account(2);
  const stranger = account(3);

  /** The latest block number, read fresh: one block per transaction here. */
  function blockNumber(): Promise<bigint> {
    return publicClient.getBlockNumber({ cacheTime: 0 });
  }

  async function withParts() {
    const usdc = await viem.deployContract("MockUSDC");
    const feed = await viem.deployContract("MockPriceFeed", [
      8,
      2_000n * 10n ** 8n,
    ]);
    const venue = await viem.deployContract("MockSwapVenue", [
      usdc.address,
      feed.address,
      0n,
    ]);
    const trigger = await viem.deployContract("LedgerTrigger", [
      usdc.address,
      feed.address,
      venue.address,
      500n * ONE_USDC,
      5n,
      4_500n,
      100n,
    ]);
    await publicClient.waitForTransactionReceipt({
      hash: await owner.sendTransaction({
        to: venue.address,
        value: 10n * ONE_ETH,
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await usdc.write.mint([1_000n * ONE_USDC], {
        account: owner.account,
      }),
    });
    return { usdc, feed, venue, trigger };
  }

  return {
    connection,
    viem,
    publicClient,
    owner,
    executor,
    recipient,
    stranger,
    blockNumber,
    withParts,
  };
}
