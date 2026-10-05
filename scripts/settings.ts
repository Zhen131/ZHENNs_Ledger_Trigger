// The environment variables the deployment and operation scripts read, and
// the functions that read them.
//
// Scripts take their settings from environment variables only, so nothing in
// the repository has to be edited to use them. The functions here are given
// the variables as an object (the entry points pass `process.env`) and never
// read the environment themselves. An error names the variable and says what
// is wrong; it never repeats the value.
//
// Hardhat's own configuration variables, the node URL and the private key of
// the `sepolia` network, are read by Hardhat (see hardhat.config.ts), not here.

import { getAddress, isAddress, type Address } from "viem";

import { ScriptError } from "./scriptError.ts";

/** Every variable the scripts read, by meaning. */
export const VARIABLES = {
  // Deployment, external-parts mode: the parts that already exist.
  usdcAddress: "TRIGGER_USDC_ADDRESS",
  priceFeedAddress: "TRIGGER_PRICE_FEED_ADDRESS",
  // Deployment, both modes: LedgerTrigger's limits and the swap venue's fee.
  maxOrderUsdc: "TRIGGER_MAX_ORDER_USDC",
  maxOpenOrders: "TRIGGER_MAX_OPEN_ORDERS",
  maxPriceAgeSeconds: "TRIGGER_MAX_PRICE_AGE_SECONDS",
  maxSlippageBps: "TRIGGER_MAX_SLIPPAGE_BPS",
  venueFeeBps: "TRIGGER_VENUE_FEE_BPS",
  // Deployment, mock-parts mode: the mock feed's first price and the ETH
  // stocked in the mock swap venue.
  mockPriceUsd: "TRIGGER_MOCK_PRICE_USD",
  mockVenueEth: "TRIGGER_MOCK_VENUE_ETH",
  // Operations: the deployed LedgerTrigger, and what each operation needs.
  contractAddress: "TRIGGER_CONTRACT_ADDRESS",
  orderUsdc: "TRIGGER_ORDER_USDC",
  targetPriceUsd: "TRIGGER_TARGET_PRICE_USD",
  expiryMinutes: "TRIGGER_EXPIRY_MINUTES",
  recipientAddress: "TRIGGER_RECIPIENT_ADDRESS",
  executorAddress: "TRIGGER_EXECUTOR_ADDRESS",
  orderId: "TRIGGER_ORDER_ID",
  fundEth: "TRIGGER_FUND_ETH",
  priceUsd: "TRIGGER_PRICE_USD",
} as const;

/** The environment, usually `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The trimmed value of `name`, or undefined when it is not set or empty. */
export function readText(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** The trimmed value of `name`; throws when it is not set. */
export function requireText(env: Environment, name: string): string {
  const value = readText(env, name);
  if (value === undefined) {
    throw new ScriptError(`${name} is required and not set.`);
  }
  return value;
}

/** An address given in `name`; throws when it is not set or not an address. */
export function requireAddress(env: Environment, name: string): Address {
  const value = requireText(env, name);
  if (!isAddress(value)) {
    throw new ScriptError(
      `${name} must be an address: 0x followed by 40 hex digits, with a valid checksum if it mixes upper and lower case.`,
    );
  }
  return getAddress(value);
}
