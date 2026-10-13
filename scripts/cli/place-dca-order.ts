// Entry point of `npm run place-dca-order`: sets the allowance and places one
// time-scheduled order from the network's first account. Settings come from
// environment variables (see the top of scripts/placeDcaOrder.ts).

import {
  formatPlacedDcaOrder,
  placeDcaOrder,
  placeDcaOrderSettingsFrom,
} from "../placeDcaOrder.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await placeDcaOrder({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: placeDcaOrderSettingsFrom(process.env),
  });
  return { lines: formatPlacedDcaOrder(result), ok: true };
});
