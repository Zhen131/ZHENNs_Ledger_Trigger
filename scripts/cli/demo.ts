// Entry point of `npm run demo`: plays the six demo scenarios on Hardhat's
// in-process local chain, which is new on every run, and prints the results.
// Exits with 0 when every scenario passes and 1 otherwise. Refuses to run on
// any chain other than Hardhat's local chain.

import { runDemo } from "../demo.ts";
import { allPassed, formatDemo } from "../demoReport.ts";
import { CONFIRM_VARIABLE } from "../sendGate.ts";
import { runScript } from "./runScript.ts";

await runScript(async (viem) => {
  const result = await runDemo({
    viem,
    confirmation: process.env[CONFIRM_VARIABLE],
  });
  return { lines: formatDemo(result), ok: allPassed(result) };
});
