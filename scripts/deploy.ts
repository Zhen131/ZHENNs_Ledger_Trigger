// Deploys LedgerTrigger with the parts it needs, in one of two modes:
//
// - mock parts (Hardhat's local chain only; the send gate refuses every other
//   chain, whatever the confirmation variable holds): deploys MockUSDC, MockPriceFeed,
//   MockSwapVenue and LedgerTrigger, stocks the swap venue with some ETH and
//   mints some mock USDC to the deploying account, so that it can place and
//   fill orders straight away;
// - external parts (for a test network): takes the addresses of a USDC token
//   and a price feed that already exist, checks that both hold contract code
//   and answer like a token and a price feed, then deploys MockSwapVenue and
//   LedgerTrigger only. The swap venue is not stocked with ETH here; the
//   fund-venue script does that, right before it is needed.
//
// Both modes pass the send gate first. Afterwards they read LedgerTrigger's
// seven parameters back from the chain and report them, together with every
// address and the block LedgerTrigger was deployed in (the keeper's first
// block to read).
//
// The functions take Hardhat's viem helpers of a network connection; they
// never read the environment. `deploySettingsFrom` turns the environment into
// settings, with the defaults below.

import type { NetworkConnection } from "hardhat/types/network";
import { erc20Abi, type Address } from "viem";

import { formatDecimal, parseDecimal, parseWhole } from "./amounts.ts";
import { scriptClients } from "./clients.ts";
import { ScriptError } from "./scriptError.ts";
import { GatedScript, passSendGate } from "./sendGate.ts";
import {
  VARIABLES,
  readText,
  requireAddress,
  type Environment,
} from "./settings.ts";

type Viem = NetworkConnection["viem"];

/** Decimals of the mock price feed, the same as Chainlink's ETH / USD feed. */
export const MOCK_FEED_DECIMALS = 8;

/** ETH has 18 decimals. */
const ETH_DECIMALS = 18;

/** Settings both modes take. Amounts are written as people write them. */
export type DeploySettings = {
  /** Largest order, in USDC, for example "500". */
  readonly maxOrderUsdc: string;
  /** Largest number of open orders per owner. */
  readonly maxOpenOrders: bigint;
  /** Oldest price age that still counts as current, in seconds. */
  readonly maxPriceAgeSeconds: bigint;
  /** Allowed slippage, in basis points (100 is 1 %). */
  readonly maxSlippageBps: bigint;
  /** Fee of the swap venue, in basis points. */
  readonly venueFeeBps: bigint;
};

/** Settings only the mock-parts mode takes. */
export type MockSettings = {
  /** First price of the mock feed, in USD, for example "2000". */
  readonly mockPriceUsd: string;
  /** ETH stocked in the mock swap venue, for example "10". */
  readonly mockVenueEth: string;
  /** Mock USDC minted to the deploying account, for example "1000". */
  readonly mockDeployerUsdc: string;
};

/** Defaults of every setting that has one. */
export const DEPLOY_DEFAULTS = {
  maxOrderUsdc: "500",
  maxOpenOrders: 5n,
  maxPriceAgeSeconds: 4_500n,
  maxSlippageBps: 100n,
  venueFeeBps: 0n,
  mockPriceUsd: "2000",
  mockVenueEth: "10",
  mockDeployerUsdc: "1000",
} as const;

/** The settings both modes take, from `env`, with the defaults filled in. */
export function deploySettingsFrom(env: Environment): DeploySettings {
  const whole = (name: string, fallback: bigint, min: bigint) => {
    const text = readText(env, name);
    return text === undefined ? fallback : parseWhole(text, min, name);
  };
  const maxOrderUsdc =
    readText(env, VARIABLES.maxOrderUsdc) ?? DEPLOY_DEFAULTS.maxOrderUsdc;
  // The token's decimals are only known later; this checks the form early.
  parseDecimal(maxOrderUsdc, ETH_DECIMALS, VARIABLES.maxOrderUsdc);
  return {
    maxOrderUsdc,
    maxOpenOrders: whole(
      VARIABLES.maxOpenOrders,
      DEPLOY_DEFAULTS.maxOpenOrders,
      1n,
    ),
    maxPriceAgeSeconds: whole(
      VARIABLES.maxPriceAgeSeconds,
      DEPLOY_DEFAULTS.maxPriceAgeSeconds,
      1n,
    ),
    maxSlippageBps: whole(
      VARIABLES.maxSlippageBps,
      DEPLOY_DEFAULTS.maxSlippageBps,
      0n,
    ),
    venueFeeBps: whole(VARIABLES.venueFeeBps, DEPLOY_DEFAULTS.venueFeeBps, 0n),
  };
}

/** The settings only the mock-parts mode takes, from `env`, with defaults. */
export function mockSettingsFrom(env: Environment): MockSettings {
  const mockPriceUsd =
    readText(env, VARIABLES.mockPriceUsd) ?? DEPLOY_DEFAULTS.mockPriceUsd;
  const mockVenueEth =
    readText(env, VARIABLES.mockVenueEth) ?? DEPLOY_DEFAULTS.mockVenueEth;
  parseDecimal(mockPriceUsd, MOCK_FEED_DECIMALS, VARIABLES.mockPriceUsd);
  const mockDeployerUsdc =
    readText(env, VARIABLES.mockDeployerUsdc) ??
    DEPLOY_DEFAULTS.mockDeployerUsdc;
  parseDecimal(mockVenueEth, ETH_DECIMALS, VARIABLES.mockVenueEth);
  parseDecimal(mockDeployerUsdc, ETH_DECIMALS, VARIABLES.mockDeployerUsdc);
  return { mockPriceUsd, mockVenueEth, mockDeployerUsdc };
}

/** The two external addresses, from `env`. Both are required. */
export function externalAddressesFrom(env: Environment) {
  return {
    usdc: requireAddress(env, VARIABLES.usdcAddress),
    priceFeed: requireAddress(env, VARIABLES.priceFeedAddress),
  };
}

/** What a USDC token and a price feed reported when checked. */
export type PartsCheck = {
  readonly usdcDecimals: number;
  readonly feedDecimals: number;
  readonly latestPrice: bigint;
  readonly updatedAt: bigint;
};

/** The seven LedgerTrigger parameters, as read back from the chain. */
export type TriggerParameters = {
  readonly usdc: Address;
  readonly priceFeed: Address;
  readonly swapVenue: Address;
  readonly maxOrderAmount: bigint;
  readonly maxOpenOrdersPerOwner: bigint;
  readonly maxPriceAge: bigint;
  readonly maxSlippageBps: bigint;
};

export type DeploymentReport = {
  readonly chainId: number;
  readonly deployer: Address;
  /** Which parts this run deployed: all four, or the venue and LedgerTrigger. */
  readonly deployedNow: readonly string[];
  readonly trigger: Address;
  /** Block that holds LedgerTrigger's deployment. */
  readonly triggerBlock: bigint;
  /** LedgerTrigger's parameters, read back from the chain. */
  readonly parameters: TriggerParameters;
  readonly usdcDecimals: number;
  readonly feedDecimals: number;
  readonly latestPrice: bigint;
  /** The swap venue's fee, read back from the chain, in basis points. */
  readonly venueFeeBps: bigint;
  /** ETH the swap venue holds, in wei. */
  readonly venueEth: bigint;
  /** The deploying account's USDC balance, in the token's smallest unit. */
  readonly deployerUsdc: bigint;
};

/**
 * Checks that `usdc` and `priceFeed` hold contract code and answer like a
 * token and a price feed, sending nothing. Throws a `ScriptError` that names
 * the variable and the address that is wrong.
 */
export async function checkExternalParts(
  viem: Viem,
  usdc: Address,
  priceFeed: Address,
): Promise<PartsCheck> {
  const { publicClient, client } = await scriptClients(viem);
  const chainId = await publicClient.getChainId();
  const wrong = (variable: string, address: Address, what: string) =>
    new ScriptError(
      `${variable} (${address}) ${what} on chain ${chainId}. Check that you copied the address for this network. Nothing was sent.`,
    );
  for (const [variable, address] of [
    [VARIABLES.usdcAddress, usdc],
    [VARIABLES.priceFeedAddress, priceFeed],
  ] as const) {
    const code = await publicClient.getCode({ address });
    if (code === undefined || code === "0x") {
      throw wrong(variable, address, "holds no contract code");
    }
  }
  let usdcDecimals: number;
  try {
    usdcDecimals = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "decimals",
    });
  } catch {
    throw wrong(
      VARIABLES.usdcAddress,
      usdc,
      "did not answer decimals() like a token",
    );
  }
  const feed = await viem.getContractAt("IPriceFeed", priceFeed, { client });
  let feedDecimals: number;
  let latestPrice: bigint;
  let updatedAt: bigint;
  try {
    feedDecimals = await feed.read.decimals();
    const [, answer, , updated] = await feed.read.latestRoundData();
    latestPrice = answer;
    updatedAt = updated;
  } catch {
    throw wrong(
      VARIABLES.priceFeedAddress,
      priceFeed,
      "did not answer decimals() and latestRoundData() like a price feed",
    );
  }
  return { usdcDecimals, feedDecimals, latestPrice, updatedAt };
}

/** Deploys the swap venue and LedgerTrigger on top of a USDC and a feed. */
async function deployVenueAndTrigger(
  viem: Viem,
  usdc: Address,
  priceFeed: Address,
  usdcDecimals: number,
  settings: DeploySettings,
) {
  const { publicClient, client } = await scriptClients(viem);
  const maxOrderAmount = parseDecimal(
    settings.maxOrderUsdc,
    usdcDecimals,
    VARIABLES.maxOrderUsdc,
  );
  const venue = await viem.deployContract(
    "MockSwapVenue",
    [usdc, priceFeed, settings.venueFeeBps],
    { client },
  );
  const { contract: trigger, deploymentTransaction } =
    await viem.sendDeploymentTransaction(
      "LedgerTrigger",
      [
        usdc,
        priceFeed,
        venue.address,
        maxOrderAmount,
        settings.maxOpenOrders,
        settings.maxPriceAgeSeconds,
        settings.maxSlippageBps,
      ],
      { client },
    );
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deploymentTransaction.hash,
  });
  if (receipt.status !== "success") {
    throw new ScriptError("The LedgerTrigger deployment failed on chain.");
  }
  const parameters: TriggerParameters = {
    usdc: await trigger.read.usdc(),
    priceFeed: await trigger.read.priceFeed(),
    swapVenue: await trigger.read.swapVenue(),
    maxOrderAmount: await trigger.read.maxOrderAmount(),
    maxOpenOrdersPerOwner: await trigger.read.maxOpenOrdersPerOwner(),
    maxPriceAge: await trigger.read.maxPriceAge(),
    maxSlippageBps: await trigger.read.maxSlippageBps(),
  };
  const requested: TriggerParameters = {
    usdc,
    priceFeed,
    swapVenue: venue.address,
    maxOrderAmount,
    maxOpenOrdersPerOwner: settings.maxOpenOrders,
    maxPriceAge: settings.maxPriceAgeSeconds,
    maxSlippageBps: settings.maxSlippageBps,
  };
  for (const key of Object.keys(requested) as (keyof TriggerParameters)[]) {
    const asked = requested[key];
    const read = parameters[key];
    const same =
      typeof asked === "string" && typeof read === "string"
        ? asked.toLowerCase() === read.toLowerCase()
        : asked === read;
    if (!same) {
      throw new ScriptError(
        `LedgerTrigger's ${key} read back from the chain is not the value it was deployed with.`,
      );
    }
  }
  return {
    venue,
    trigger: trigger.address,
    triggerBlock: receipt.blockNumber,
    parameters,
    venueFeeBps: await venue.read.feeBps(),
  };
}

/** Mock-parts mode: deploys all four contracts and stocks the venue. */
export async function deployWithMocks(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: DeploySettings;
  readonly mocks: MockSettings;
}): Promise<DeploymentReport> {
  const { viem, settings, mocks } = input;
  const { publicClient, walletClients, client } = await scriptClients(viem);
  const chainId = await passSendGate(
    publicClient,
    GatedScript.DeployMocks,
    input.confirmation,
  );
  const [deployer] = walletClients;
  if (deployer === undefined) {
    throw new ScriptError("The network has no account to deploy from.");
  }
  const firstPrice = parseDecimal(
    mocks.mockPriceUsd,
    MOCK_FEED_DECIMALS,
    VARIABLES.mockPriceUsd,
  );
  const venueEth = parseDecimal(
    mocks.mockVenueEth,
    ETH_DECIMALS,
    VARIABLES.mockVenueEth,
  );

  const usdc = await viem.deployContract("MockUSDC", [], { client });
  const feed = await viem.deployContract(
    "MockPriceFeed",
    [MOCK_FEED_DECIMALS, firstPrice],
    { client },
  );
  const usdcDecimals = await usdc.read.decimals();
  const deployed = await deployVenueAndTrigger(
    viem,
    usdc.address,
    feed.address,
    usdcDecimals,
    settings,
  );
  if (venueEth > 0n) {
    const hash = await deployer.sendTransaction({
      to: deployed.venue.address,
      value: venueEth,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const deployerUsdc = parseDecimal(
    mocks.mockDeployerUsdc,
    usdcDecimals,
    VARIABLES.mockDeployerUsdc,
  );
  if (deployerUsdc > 0n) {
    await publicClient.waitForTransactionReceipt({
      hash: await usdc.write.mint([deployerUsdc], {
        account: deployer.account,
      }),
    });
  }
  const [, latestPrice] = await feed.read.latestRoundData();
  return {
    chainId,
    deployer: deployer.account.address,
    deployedNow: [
      "MockUSDC",
      "MockPriceFeed",
      "MockSwapVenue",
      "LedgerTrigger",
    ],
    trigger: deployed.trigger,
    triggerBlock: deployed.triggerBlock,
    parameters: deployed.parameters,
    usdcDecimals,
    feedDecimals: await feed.read.decimals(),
    latestPrice,
    venueFeeBps: deployed.venueFeeBps,
    venueEth: await publicClient.getBalance({
      address: deployed.venue.address,
    }),
    deployerUsdc: await usdc.read.balanceOf([deployer.account.address]),
  };
}

/**
 * External-parts mode: checks the given USDC and price feed, then deploys the
 * swap venue and LedgerTrigger. Sends nothing when the check fails.
 */
export async function deployWithExternalParts(input: {
  readonly viem: Viem;
  readonly confirmation: string | undefined;
  readonly settings: DeploySettings;
  readonly usdc: Address;
  readonly priceFeed: Address;
  /** Told what the check found, before anything is sent. */
  readonly onChecked?: (check: PartsCheck) => void;
}): Promise<{ readonly check: PartsCheck; readonly report: DeploymentReport }> {
  const { viem, settings } = input;
  const { publicClient, walletClients } = await scriptClients(viem);
  const chainId = await passSendGate(
    publicClient,
    GatedScript.Deploy,
    input.confirmation,
  );
  const [deployer] = walletClients;
  if (deployer === undefined) {
    throw new ScriptError("The network has no account to deploy from.");
  }
  const check = await checkExternalParts(viem, input.usdc, input.priceFeed);
  input.onChecked?.(check);
  // Converting the limit first means a bad amount stops the run before any
  // transaction is sent.
  parseDecimal(
    settings.maxOrderUsdc,
    check.usdcDecimals,
    VARIABLES.maxOrderUsdc,
  );
  const deployed = await deployVenueAndTrigger(
    viem,
    input.usdc,
    input.priceFeed,
    check.usdcDecimals,
    settings,
  );
  return {
    check,
    report: {
      chainId,
      deployer: deployer.account.address,
      deployedNow: ["MockSwapVenue", "LedgerTrigger"],
      trigger: deployed.trigger,
      triggerBlock: deployed.triggerBlock,
      parameters: deployed.parameters,
      usdcDecimals: check.usdcDecimals,
      feedDecimals: check.feedDecimals,
      latestPrice: check.latestPrice,
      venueFeeBps: deployed.venueFeeBps,
      venueEth: await publicClient.getBalance({
        address: deployed.venue.address,
      }),
      deployerUsdc: await publicClient.readContract({
        address: input.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [deployer.account.address],
      }),
    },
  };
}

/** A number of basis points as a percentage, for example "1 %" for 100. */
function percent(bps: bigint): string {
  return `${formatDecimal(bps, 2)} %`;
}

/** What the external-parts check found, as lines to print. */
export function formatPartsCheck(
  usdc: Address,
  priceFeed: Address,
  check: PartsCheck,
): string[] {
  return [
    "Checked the existing parts (nothing sent yet):",
    `  USDC token   ${usdc}: ${check.usdcDecimals} decimals`,
    `  Price feed   ${priceFeed}: ${check.feedDecimals} decimals, latest price ${formatDecimal(check.latestPrice, check.feedDecimals)} USD, updated at Unix time ${check.updatedAt}`,
  ];
}

/** The deployment report as lines to print. Holds no node URL and no key. */
export function formatDeployment(report: DeploymentReport): string[] {
  const p = report.parameters;
  const now = (name: string) =>
    report.deployedNow.includes(name) ? "deployed now" : "already existed";
  return [
    `Deployed on chain ${report.chainId} from account ${report.deployer}.`,
    "Contracts:",
    `  USDC token      ${p.usdc}  (${now("MockUSDC")})`,
    `  Price feed      ${p.priceFeed}  (${now("MockPriceFeed")})`,
    `  Swap venue      ${p.swapVenue}  (deployed now; fee ${report.venueFeeBps} basis points; holds ${formatDecimal(report.venueEth, ETH_DECIMALS)} ETH)`,
    `  LedgerTrigger   ${report.trigger}  (deployed now, in block ${report.triggerBlock})`,
    "LedgerTrigger parameters, read back from the chain:",
    `  usdc                    ${p.usdc}`,
    `  priceFeed               ${p.priceFeed}`,
    `  swapVenue               ${p.swapVenue}`,
    `  maxOrderAmount          ${p.maxOrderAmount} (smallest USDC units; ${formatDecimal(p.maxOrderAmount, report.usdcDecimals)} USDC, as USDC has ${report.usdcDecimals} decimals)`,
    `  maxOpenOrdersPerOwner   ${p.maxOpenOrdersPerOwner} (orders)`,
    `  maxPriceAge             ${p.maxPriceAge} (seconds; ${formatDecimal((p.maxPriceAge * 100n) / 60n, 2)} minutes)`,
    `  maxSlippageBps          ${p.maxSlippageBps} (basis points; ${percent(p.maxSlippageBps)})`,
    `Price feed: ${report.feedDecimals} decimals, latest price ${formatDecimal(report.latestPrice, report.feedDecimals)} USD.`,
    `The deploying account holds ${formatDecimal(report.deployerUsdc, report.usdcDecimals)} USDC.`,
    `LedgerTrigger was deployed in block ${report.triggerBlock}: use it as KEEPER_FROM_BLOCK.`,
  ];
}
