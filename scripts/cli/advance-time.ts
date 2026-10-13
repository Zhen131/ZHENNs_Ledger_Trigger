// Entry point of `npm run advance-time`: moves the clock of Hardhat's local
// chain forward by TRIGGER_ADVANCE_SECONDS and mines one block. Hardhat's
// local chain only.

import {
  advanceTime,
  advanceTimeSettingsFrom,
  formatTimeAdvanced,
} from "../advanceTime.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await advanceTime({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
    settings: advanceTimeSettingsFrom(process.env),
  });
  return { lines: formatTimeAdvanced(result), ok: true };
});
