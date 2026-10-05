// The keeper's keep-running mode: a round, a pause, another round, and so on.
//
// An error in one round is logged by the round itself and does not stop the
// keeper: the next round runs after the pause, as usual.

import { internalErrorEntry, type Logger } from "./log.ts";
import type { RoundReport } from "./runOnce.ts";

export type KeepRunningInput = {
  /** Runs one round, for example `runOnce` with its input bound. */
  readonly runRound: () => Promise<RoundReport>;
  /** Pause between the end of one round and the start of the next. */
  readonly intervalMs: number;
  /** Waits `ms` milliseconds. */
  readonly wait: (ms: number) => Promise<void>;
  readonly log: Logger;
  /**
   * For tests only: stop after this many rounds. When it is not given, the
   * keeper runs until the process is stopped.
   */
  readonly maxRounds?: number;
};

/** Runs rounds until stopped (or `maxRounds` have run). Never throws. */
export async function keepRunning(input: KeepRunningInput): Promise<void> {
  for (
    let round = 1;
    input.maxRounds === undefined || round <= input.maxRounds;
    round += 1
  ) {
    if (round > 1) await input.wait(input.intervalMs);
    try {
      await input.runRound();
    } catch (error) {
      // A round logs and returns every failure it expects; this is a last
      // guard so that nothing unexpected ends the keeper.
      input.log(internalErrorEntry("round", error));
    }
  }
}
