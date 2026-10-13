// Entry point of `npm run order-status`: prints order TRIGGER_ORDER_ID: its
// kind, its fields, how much is left and how many fills are done, its status
// now and whether it can be filled now; for a dormant order whether it can be
// activated now, for a Dca order its schedule, for a Ladder order its tiers.
// Sends nothing.

import {
  formatOrderReport,
  orderStatus,
  orderStatusSettingsFrom,
} from "../orderStatus.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const report = await orderStatus({
    viem,
    settings: orderStatusSettingsFrom(process.env),
  });
  return { lines: formatOrderReport(report), ok: true };
});
