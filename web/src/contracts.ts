// The contract interfaces (ABIs) the page uses. LedgerTrigger's and the price
// feed's come from Hardhat's build output, so they always match the compiled
// contracts: run `npx hardhat build` (or `npm run check`) before building or
// serving the page. USDC needs only four ERC-20 functions, written out here.

import { parseAbi, type Abi } from "viem";

import triggerArtifact from "../../artifacts/contracts/LedgerTrigger.sol/LedgerTrigger.json" with { type: "json" };
import priceFeedArtifact from "../../artifacts/contracts/interfaces/IPriceFeed.sol/IPriceFeed.json" with { type: "json" };

/** LedgerTrigger: its functions, events and errors. */
export const TRIGGER_ABI = triggerArtifact.abi as unknown as Abi;

/** The price feed: `decimals` and `latestRoundData`. */
export const PRICE_FEED_ABI = priceFeedArtifact.abi as unknown as Abi;

/** The four ERC-20 functions the page calls on USDC. */
export const USDC_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);
