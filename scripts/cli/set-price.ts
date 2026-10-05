// Entry point of `npm run set-price`: sets the mock price feed behind
// TRIGGER_CONTRACT_ADDRESS to TRIGGER_PRICE_USD. Hardhat's local chain only.

import { CONFIRM_VARIABLE } from "../sendGate.ts";
import {
  formatPriceSet,
  setMockPrice,
  setPriceSettingsFrom,
} from "../setMockPrice.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await setMockPrice({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: setPriceSettingsFrom(process.env),
  });
  return { lines: formatPriceSet(result), ok: true };
});
