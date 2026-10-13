// What the page says about an order's status, and how it looks.
//
// The status comes from `statusOf`, the reason it cannot be filled from
// `canFill` and, for a dormant order, the reason it cannot be activated from
// `canActivate`; all are numbers in the contract's interface, named with the
// keeper's lists (keeper/names.ts).

import {
  ActivationBlocker,
  FillBlocker,
  OrderStatus,
  activationBlockerName,
  fillBlockerName,
  orderStatusName,
} from "../../../keeper/names.ts";

/** The colour family of a status. Each value is also a CSS class suffix. */
export const Tone = {
  /** Open or partly filled, but something stops a fill now. */
  Waiting: "waiting",
  /** A fill, or for a dormant order an activation, would pass now. */
  Ready: "ready",
  /** Dormant: asleep until the price rises to the activation price. */
  Dormant: "dormant",
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

/** What `canActivate` returned for a dormant order. */
export type ActivationCheck = {
  readonly activatable: boolean;
  /** An ActivationBlocker value. */
  readonly reason: number;
};

export type StatusView = {
  readonly text: string;
  readonly tone: ToneName;
  /** True when a quiet pulsing dot goes with the text. */
  readonly pulse: boolean;
};

/** "<status> · can be filled now", or "<status> · waiting: <reason>". */
function fillView(name: string, check: FillCheck): StatusView {
  if (check.fillable && check.reason === FillBlocker.None) {
    return {
      text: `${name} · can be filled now`,
      tone: Tone.Ready,
      pulse: false,
    };
  }
  return {
    text: `${name} · waiting: ${fillBlockerName(check.reason)}`,
    tone: Tone.Waiting,
    pulse: true,
  };
}

/** A dormant order: plain "Dormant" until `canActivate` has been read. */
function dormantView(activation: ActivationCheck | undefined): StatusView {
  if (activation === undefined) {
    return { text: "Dormant", tone: Tone.Dormant, pulse: false };
  }
  if (activation.activatable && activation.reason === ActivationBlocker.None) {
    return {
      text: "Dormant · can be activated now",
      tone: Tone.Ready,
      pulse: false,
    };
  }
  return {
    text: `Dormant · waiting: ${activationBlockerName(activation.reason)}`,
    tone: Tone.Dormant,
    pulse: true,
  };
}

/**
 * The text and look of an order with status `status` (an OrderStatus value),
 * fill check `check` and, for a dormant order, activation check `activation`:
 * "Dormant · waiting: PriceBelowActivation" with a pulsing dot, "Dormant ·
 * can be activated now", "Open · waiting: PriceAboveTarget", "Open · can be
 * filled now", "PartiallyFilled · waiting: PeriodAlreadyFilled", "Filled",
 * "Cancelled" or "Expired".
 */
export function statusView(
  status: number,
  check: FillCheck,
  activation?: ActivationCheck,
): StatusView {
  switch (status) {
    case OrderStatus.Dormant:
      return dormantView(activation);
    case OrderStatus.Open:
      return fillView("Open", check);
    case OrderStatus.PartiallyFilled:
      return fillView("PartiallyFilled", check);
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
  /** Activate: only a `Dormant` order. */
  readonly activate: boolean;
  /**
   * Fill now: a `Dormant`, `Open` or `PartiallyFilled` order. The contract
   * refuses a fill of a dormant order (`OrderNotOpen`), and the page shows
   * that refusal.
   */
  readonly fill: boolean;
  /**
   * Cancel: a `Dormant`, `Open` or `PartiallyFilled` order, and an `Expired`
   * one, which still takes a slot.
   */
  readonly cancel: boolean;
};

/** Which buttons an order with status `status` gets, whoever is connected. */
export function actionsFor(status: number): OrderActions {
  const unfinished =
    status === OrderStatus.Dormant ||
    status === OrderStatus.Open ||
    status === OrderStatus.PartiallyFilled;
  return {
    activate: status === OrderStatus.Dormant,
    fill: unfinished,
    cancel: unfinished || status === OrderStatus.Expired,
  };
}
