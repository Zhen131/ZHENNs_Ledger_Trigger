// Entry point of `npm run deploy:external`: for a test network. Takes the
// addresses of an existing USDC token and price feed from
// TRIGGER_USDC_ADDRESS and TRIGGER_PRICE_FEED_ADDRESS, checks both before
// sending anything and prints what it found, then deploys MockSwapVenue and
// LedgerTrigger. Prints every address, the parameters with their units and the
// block LedgerTrigger was deployed in.

import {
  deploySettingsFrom,
  deployWithExternalParts,
  externalAddressesFrom,
  formatDeployment,
  formatPartsCheck,
} from "../deploy.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const { usdc, priceFeed } = externalAddressesFrom(process.env);
  const { report } = await deployWithExternalParts({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: deploySettingsFrom(process.env),
    usdc,
    priceFeed,
    onChecked: (check) => {
      for (const line of formatPartsCheck(usdc, priceFeed, check)) {
        console.log(line);
      }
    },
  });
  return { lines: formatDeployment(report), ok: true };
});
