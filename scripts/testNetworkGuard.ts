// Keeps the tests on Hardhat's local chain.
//
// The tests deploy contracts, mint tokens and send transactions on the network
// Hardhat was asked for: the in-process local chain by default, but whichever
// network `--network` or the HARDHAT_NETWORK environment variable names. Run
// against the `sepolia` network in a terminal that holds its key, they would
// send all of that to Sepolia from that wallet, past the send gate.
//
// So hardhat.config.ts replaces the action of the `test nodejs` task, the task
// behind `npx hardhat test`, `npx hardhat test nodejs` and the test step of
// `npm run check`, with `guardTestRun`: before it builds or runs anything, it
// works out the chain ID of the selected network and lets the tests run only
// on Hardhat's local chain, by the same rule as the send gate (`isLocalChain`).
// Otherwise it stops the whole run, says why, and no test runs.
//
// The chain ID comes from the network's configuration when the configuration
// sets one; `sepolia` does, so its node is not contacted at all. Otherwise the
// node is asked once for its chain ID, which sends no transaction.

import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { LOCAL_CHAIN_ID, isLocalChain } from "./sendGate.ts";

/** The name Hardhat gives the in-process network when none is selected. */
export const DEFAULT_NETWORK = "default";

/** Shown as the source of the error when the guard stops a test run. */
export const GUARD_ID = "local-tests-only";

export type TestNetwork = {
  /** The selected network's name. */
  readonly name: string;
  /** The chain ID its configuration sets, if it sets one. */
  readonly configuredChainId: number | undefined;
  /** Asks the network's node for its chain ID. */
  readonly askChainId: () => Promise<number>;
};

export type TestNetworkDecision =
  | { readonly allowed: true; readonly chainId: number }
  | { readonly allowed: false; readonly reason: string };

/** Decides whether the tests may run on `network`. */
export async function checkTestNetwork(
  network: TestNetwork,
): Promise<TestNetworkDecision> {
  const chainId = network.configuredChainId ?? (await network.askChainId());
  if (isLocalChain(chainId)) return { allowed: true, chainId };
  return {
    allowed: false,
    reason: `The tests run on Hardhat's local chain only (chain ID ${LOCAL_CHAIN_ID}). The selected network "${network.name}" is chain ${chainId}, so no test was run and nothing was sent. Run the tests without --network and without the HARDHAT_NETWORK environment variable.`,
  };
}

/** The network the tests would run on, as `hre` selects it. */
export function selectedTestNetwork(
  hre: HardhatRuntimeEnvironment,
): TestNetwork {
  const selected: string | undefined = hre.globalOptions.network;
  const name = selected ?? DEFAULT_NETWORK;
  return {
    name,
    configuredChainId: hre.config.networks[name]?.chainId,
    askChainId: async () => {
      const connection = await hre.network.create(name);
      try {
        return Number(
          await connection.provider.request({ method: "eth_chainId" }),
        );
      } finally {
        await connection.close();
      }
    },
  };
}

/**
 * The action that replaces `test nodejs`: runs the original task only when
 * the selected network is Hardhat's local chain, and otherwise throws an error
 * that Hardhat prints as the reason the run stopped.
 */
export async function guardTestRun<ArgumentsT>(
  taskArguments: ArgumentsT,
  hre: HardhatRuntimeEnvironment,
  runSuper: (taskArguments: ArgumentsT) => Promise<unknown>,
): Promise<unknown> {
  const decision = await checkTestNetwork(selectedTestNetwork(hre));
  if (!decision.allowed) {
    throw new HardhatPluginError(GUARD_ID, decision.reason);
  }
  return runSuper(taskArguments);
}
