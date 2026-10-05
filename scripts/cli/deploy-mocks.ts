// Entry point of `npm run deploy:mocks`: deploys MockUSDC, MockPriceFeed,
// MockSwapVenue (stocked with ETH) and LedgerTrigger, for a local chain.
// Settings come from environment variables (see the README); the ones not set
// take their defaults. Prints every address, the parameters with their units
// and the block LedgerTrigger was deployed in.

import {
  deploySettingsFrom,
  deployWithMocks,
  formatDeployment,
  mockSettingsFrom,
} from "../deploy.ts";
import { ScriptError } from "../scriptError.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { VARIABLES, readText } from "../settings.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  for (const name of [VARIABLES.usdcAddress, VARIABLES.priceFeedAddress]) {
    if (readText(process.env, name) !== undefined) {
      throw new ScriptError(
        `${name} is set, but deploy:mocks deploys its own mock USDC and price feed. Use deploy:external, or unset ${name}.`,
      );
    }
  }
  const report = await deployWithMocks({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: deploySettingsFrom(process.env),
    mocks: mockSettingsFrom(process.env),
  });
  return { lines: formatDeployment(report), ok: true };
});
