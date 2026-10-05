// Entry point of `npm run place-order`: sets the allowance and places one
// order from the network's first account. Settings come from environment
// variables (see the README).

import { formatDecimal } from "../amounts.ts";
import { placeOrder, placeOrderSettingsFrom } from "../placeOrder.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await placeOrder({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: placeOrderSettingsFrom(process.env),
  });
  const usdc = (value: bigint) =>
    `${formatDecimal(value, result.usdcDecimals)} USDC (${value})`;
  const usd = (value: bigint) =>
    `${formatDecimal(value, result.priceDecimals)} USD (${value})`;
  return {
    lines: [
      `Placed order ${result.orderId} from account ${result.owner}.`,
      `  amount         ${usdc(result.usdcAmount)}`,
      `  target price   ${usd(result.targetPrice)}`,
      `  expires after  ${new Date(Number(result.expiry) * 1000).toISOString()} (Unix ${result.expiry})`,
      `  allowance      ${usdc(result.allowance)}, equal to the open-order total ${usdc(result.openOrderTotal)}`,
      `  USDC balance   ${usdc(result.balance)}`,
    ],
    ok: true,
  };
});
