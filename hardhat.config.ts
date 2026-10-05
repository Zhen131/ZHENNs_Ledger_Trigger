import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig, overrideTask } from "hardhat/config";

import { guardTestRun } from "./scripts/testNetworkGuard.ts";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
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
    // The tests send transactions on the selected network. This runs them on
    // Hardhat's local chain only: on any other chain the whole run stops
    // before anything is built, run or sent (see scripts/testNetworkGuard.ts).
    overrideTask(["test", "nodejs"]).setInlineAction(guardTestRun).build(),
  ],
});
