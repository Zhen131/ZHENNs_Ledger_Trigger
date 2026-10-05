// The viem clients the deployment, operation and demo scripts use, built from
// Hardhat's viem helpers of the selected network.
//
// Every one of them is built with CCIP-read turned off (`ccipRead: false`),
// as the keeper's are: otherwise a contract could revert with an
// OffchainLookup error that names a web address, and viem would fetch it. The
// scripts talk to the selected network's node only. Contracts are opened and
// deployed with these clients too (`client`), never with Hardhat's defaults.

import type { NetworkConnection } from "hardhat/types/network";

type Viem = NetworkConnection["viem"];

/** The clients of the selected network, all with CCIP-read turned off. */
export async function scriptClients(viem: Viem) {
  const publicClient = await viem.getPublicClient({ ccipRead: false });
  const walletClients = await viem.getWalletClients({ ccipRead: false });
  const [first] = walletClients;
  return {
    publicClient,
    walletClients,
    /**
     * What `getContractAt`, `deployContract` and `sendDeploymentTransaction`
     * take as `client`: the public client and the first account's wallet.
     */
    client:
      first === undefined
        ? { public: publicClient }
        : { public: publicClient, wallet: first },
  };
}
