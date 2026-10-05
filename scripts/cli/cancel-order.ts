// Entry point of `npm run cancel-order`: cancels the order TRIGGER_ORDER_ID
// from the network's first account, which must be the order's owner.

import { cancelOrder, cancelOrderSettingsFrom } from "../cancelOrder.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await cancelOrder({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: cancelOrderSettingsFrom(process.env),
  });
  return {
    lines: [
      `Order ${result.orderId}: ${result.statusBefore} -> ${result.statusAfter}.`,
    ],
    ok: true,
  };
});
