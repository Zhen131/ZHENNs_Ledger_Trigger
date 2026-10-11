// The event list at the bottom of the page. It is redrawn only when an event
// came in.

import { byId, formatClock, make, setText } from "./dom.ts";
import type { FeedEntry } from "./lib/feed.ts";

let shownKeys = "";

/** Shows `entries`, newest first. */
export function renderFeed(entries: readonly FeedEntry[]): void {
  const keys = entries.map((entry) => entry.key).join(",");
  setText(byId("feed-empty"), entries.length === 0 ? "No events yet." : "");
  if (keys === shownKeys) return;
  shownKeys = keys;
  const rows = entries.map((entry) => {
    const row = make("tr");
    row.append(
      make("td", "mono", formatClock(entry.time)),
      make("td", "num", String(entry.blockNumber)),
      make("td", `event-name event-${entry.eventName}`, entry.eventName),
      make("td", "num", `#${entry.orderId}`),
      make("td", "", entry.detail),
    );
    return row;
  });
  byId("feed").replaceChildren(...rows);
}
