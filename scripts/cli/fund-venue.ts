// Entry point of `npm run fund-venue`: sends TRIGGER_FUND_ETH ETH from the
// network's first account to the swap venue of TRIGGER_CONTRACT_ADDRESS.

import { formatDecimal } from "../amounts.ts";
import {
  ETH_DECIMALS,
  fundVenue,
  fundVenueSettingsFrom,
} from "../fundVenue.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await fundVenue({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: fundVenueSettingsFrom(process.env),
  });
  const eth = (wei: bigint) => `${formatDecimal(wei, ETH_DECIMALS)} ETH`;
  return {
    lines: [
      `Sent ${eth(result.sent)} to the swap venue ${result.venue}.`,
      `The venue held ${eth(result.before)} and now holds ${eth(result.after)}.`,
    ],
    ok: true,
  };
});
