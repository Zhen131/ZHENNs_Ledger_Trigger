import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig, overrideTask } from "hardhat/config";

import { guardTestRun } from "./scripts/testNetworkGuard.ts";

export default defineConfig({
  plugins: [
    hardhatToolboxViemPlugin,
    // On every network connection, refuses any request that is not a plain
    // read when the chain is not Hardhat's local one, unless the send gate of
    // a deployment or operation script has let it through. This covers every
    // way of running the tests or any other code here (see
    // scripts/networkGuard.ts).
    {
      id: "local-only-transactions",
      hookHandlers: { network: () => import("./scripts/networkGuard.ts") },
    },
  ],
  solidity: {
    version: "0.8.34",
  },
  networks: {
    // The Sepolia test network, selected only with `--network sepolia`. The
    // node URL and the private key are configuration variables: when this
    // network is used, Hardhat reads them from environment variables of the
    // same names or from its encrypted keystore. No value is written here.
    // With the chain ID set, Hardhat refuses a node that serves another chain.
    // Hardhat's own `localhost` network (http://localhost:8545, the node
    // started by `npx hardhat node`) needs no entry here.
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("TRIGGER_SEPOLIA_RPC_URL"),
      accounts: [configVariable("TRIGGER_SEPOLIA_PRIVATE_KEY")],
    },
  },
  tasks: [
    // A second guard, for `npx hardhat test` and `npm run check`: on any chain
    // but Hardhat's local one the whole test run stops before anything is
    // built or run, with one message (see scripts/testNetworkGuard.ts).
    overrideTask(["test", "nodejs"]).setInlineAction(guardTestRun).build(),
  ],
});
