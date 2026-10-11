// What the page says about an order's status, and how it looks.
//
// The status comes from `statusOf` and the reason it cannot be filled from
// `canFill`; both are numbers in the contract's interface, named with the
// keeper's lists (keeper/names.ts).

import {
  FillBlocker,
  OrderStatus,
  fillBlockerName,
  orderStatusName,
} from "../../../keeper/names.ts";

/** The colour family of a status. Each value is also a CSS class suffix. */
export const Tone = {
  /** Open, but something stops a fill now. */
  Waiting: "waiting",
  /** Open, and a fill would get past the contract's checks now. */
  Ready: "ready",
  Filled: "filled",
  Cancelled: "cancelled",
  Expired: "expired",
  Unknown: "unknown",
} as const;

export type ToneName = (typeof Tone)[keyof typeof Tone];

export type FillCheck = {
  readonly fillable: boolean;
  /** A FillBlocker value. */
  readonly reason: number;
};

export type StatusView = {
  readonly text: string;
  readonly tone: ToneName;
  /** True when a quiet pulsing dot goes with the text. */
  readonly pulse: boolean;
};

/**
 * The text and look of an order with status `status` (an OrderStatus value)
 * and fill check `check`: "Open · waiting: PriceAboveTarget" with a pulsing
 * dot, "Open · can be filled now", "Filled", "Cancelled" or "Expired".
 */
export function statusView(status: number, check: FillCheck): StatusView {
  switch (status) {
    case OrderStatus.Open:
      if (check.fillable && check.reason === FillBlocker.None) {
        return {
          text: "Open · can be filled now",
          tone: Tone.Ready,
          pulse: false,
        };
      }
      return {
        text: `Open · waiting: ${fillBlockerName(check.reason)}`,
        tone: Tone.Waiting,
        pulse: true,
      };
    case OrderStatus.Filled:
      return { text: "Filled", tone: Tone.Filled, pulse: false };
    case OrderStatus.Cancelled:
      return { text: "Cancelled", tone: Tone.Cancelled, pulse: false };
    case OrderStatus.Expired:
      return { text: "Expired", tone: Tone.Expired, pulse: false };
    default:
      return {
        text: orderStatusName(status),
        tone: Tone.Unknown,
        pulse: false,
      };
  }
}

export type OrderActions = {
  /** Fill now: only an `Open` order. */
  readonly fill: boolean;
  /** Cancel: an `Open` order, and an `Expired` one, which still takes a slot. */
  readonly cancel: boolean;
};

/** Which buttons an order with status `status` gets. */
export function actionsFor(status: number): OrderActions {
  return {
    fill: status === OrderStatus.Open,
    cancel: status === OrderStatus.Open || status === OrderStatus.Expired,
  };
}
