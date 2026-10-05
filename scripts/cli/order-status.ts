// Entry point of `npm run order-status`: prints order TRIGGER_ORDER_ID, its
// status now and whether it can be filled now. Sends nothing.

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
