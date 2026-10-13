// The details under an order's row, opened with its Schedule or Tiers
// button: a Dca order's schedule, or a Ladder order's tiers and where each
// stands. They are redrawn on every refresh while open, and stay open.

import { formatDateTime, make } from "./dom.ts";
import { scheduleView, tiersView } from "./lib/details.ts";
import { OrderKind } from "./lib/kinds.ts";
import type { Decimals, OrderSnapshot } from "./lib/orders.ts";

/** The name of the button that opens the details, or undefined for none. */
export function detailsLabel(kind: number): string | undefined {
  if (kind === OrderKind.Dca) return "Schedule";
  if (kind === OrderKind.Ladder) return "Tiers";
  return undefined;
}

function pair(label: string, value: string): HTMLElement[] {
  return [make("dt", "", label), make("dd", "", value)];
}

function scheduleElement(
  snapshot: OrderSnapshot,
  now: bigint,
  decimals: Decimals,
): HTMLElement | undefined {
  const schedule = snapshot.schedule;
  if (schedule === undefined) return undefined;
  const view = scheduleView(
    schedule,
    snapshot.order,
    snapshot.status,
    now,
    decimals,
  );
  const list = make("dl", "details-grid");
  list.append(
    ...pair("Starts", formatDateTime(view.startAt)),
    ...pair("Every", view.every),
    ...pair("Periods", view.periods),
    ...pair("Per period", view.perPeriod),
    ...pair("Price cap", view.cap),
    ...pair("Next period", view.nextPeriod),
    ...pair("Current period", view.currentPeriod),
  );
  const note = make(
    "p",
    "details-note",
    "Periods are counted from 0. The next period is the earliest one that may still be bought; a period missed is skipped. The current period follows the latest block's time.",
  );
  const box = make("div", "details");
  box.append(list, note);
  return box;
}

function tiersElement(
  snapshot: OrderSnapshot,
  decimals: Decimals,
): HTMLElement | undefined {
  const tiers = snapshot.tiers;
  if (tiers === undefined) return undefined;
  const grid = make("div", "tier-list");
  grid.append(
    make("span", "tier-head", "Tier"),
    make("span", "tier-head num", "Price (USD)"),
    make("span", "tier-head num", "Amount (USDC)"),
    make("span", "tier-head", "State"),
  );
  for (const tier of tiersView(
    tiers,
    snapshot.order.fillsDone,
    snapshot.status,
    decimals,
  )) {
    grid.append(
      make("span", "mono", String(tier.index)),
      make("span", "num", tier.price),
      make("span", "num", tier.amount),
      make("span", `tier-state tier-${tier.state}`, tier.stateText),
    );
  }
  const box = make("div", "details");
  box.append(grid);
  return box;
}

/**
 * The details of `snapshot`'s order, read at `now` (the latest block's time),
 * or undefined when it has none to show.
 */
export function detailsElement(
  snapshot: OrderSnapshot,
  now: bigint,
  decimals: Decimals,
): HTMLElement | undefined {
  if (snapshot.order.kind === OrderKind.Dca) {
    return scheduleElement(snapshot, now, decimals);
  }
  if (snapshot.order.kind === OrderKind.Ladder) {
    return tiersElement(snapshot, decimals);
  }
  return undefined;
}
