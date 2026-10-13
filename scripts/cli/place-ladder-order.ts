// Entry point of `npm run place-ladder-order`: sets the allowance and places
// one Ladder order from the network's first account. Settings come from
// environment variables (see the top of scripts/placeLadderOrder.ts).

import {
  formatPlacedLadderOrder,
  placeLadderOrder,
  placeLadderOrderSettingsFrom,
} from "../placeLadderOrder.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await placeLadderOrder({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: placeLadderOrderSettingsFrom(process.env),
  });
  return { lines: formatPlacedLadderOrder(result), ok: true };
});
