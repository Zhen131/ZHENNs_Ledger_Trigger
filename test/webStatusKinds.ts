import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ActivationBlocker,
  FillBlocker,
  OrderStatus,
} from "../keeper/names.ts";
import {
  Tone,
  actionsFor,
  statusView,
  type FillCheck,
} from "../web/src/lib/status.ts";

// The words and look of the second version's statuses: a dormant order, with
// the reason canActivate gives, and a partly filled one, with the reason
// canFill gives; and which buttons each status gets.

const READY: FillCheck = { fillable: true, reason: FillBlocker.None };
const DORMANT_FILL: FillCheck = {
  fillable: false,
  reason: FillBlocker.Dormant,
};

describe("web status words for dormant and partly filled orders", () => {
  it("a dormant order that can be activated now says so, without a pulsing dot", () => {
    assert.deepEqual(
      statusView(OrderStatus.Dormant, DORMANT_FILL, {
        activatable: true,
        reason: ActivationBlocker.None,
      }),
      {
        text: "Dormant · can be activated now",
        tone: Tone.Ready,
        pulse: false,
      },
    );
  });

  it("a dormant order that cannot be activated names the reason, with a pulsing dot, for every ActivationBlocker", () => {
    for (const [name, value] of Object.entries(ActivationBlocker)) {
      if (value === ActivationBlocker.None) continue;
      assert.deepEqual(
        statusView(OrderStatus.Dormant, DORMANT_FILL, {
          activatable: false,
          reason: value,
        }),
        {
          text: `Dormant · waiting: ${name}`,
          tone: Tone.Dormant,
          pulse: true,
        },
        name,
      );
    }
  });

  it("a dormant order whose activation check was not read just says Dormant", () => {
    assert.deepEqual(statusView(OrderStatus.Dormant, DORMANT_FILL), {
      text: "Dormant",
      tone: Tone.Dormant,
      pulse: false,
    });
  });

  it("a partly filled order that can be filled now says so, without a pulsing dot", () => {
    assert.deepEqual(statusView(OrderStatus.PartiallyFilled, READY), {
      text: "PartiallyFilled · can be filled now",
      tone: Tone.Ready,
      pulse: false,
    });
  });

  it("a partly filled order that cannot be filled names the reason, with a pulsing dot, for every FillBlocker", () => {
    for (const [name, value] of Object.entries(FillBlocker)) {
      if (value === FillBlocker.None) continue;
      assert.deepEqual(
        statusView(OrderStatus.PartiallyFilled, {
          fillable: false,
          reason: value,
        }),
        {
          text: `PartiallyFilled · waiting: ${name}`,
          tone: Tone.Waiting,
          pulse: true,
        },
        name,
      );
    }
  });

  it("an activation check given with any other status changes nothing", () => {
    const activation = { activatable: true, reason: ActivationBlocker.None };
    assert.deepEqual(
      statusView(OrderStatus.Open, READY, activation),
      statusView(OrderStatus.Open, READY),
    );
    assert.deepEqual(statusView(OrderStatus.Filled, READY, activation), {
      text: "Filled",
      tone: Tone.Filled,
      pulse: false,
    });
  });
});

describe("web buttons for every status", () => {
  it("Dormant: Activate, Fill now and Cancel", () => {
    assert.deepEqual(actionsFor(OrderStatus.Dormant), {
      activate: true,
      fill: true,
      cancel: true,
    });
  });

  it("Open and PartiallyFilled: Fill now and Cancel", () => {
    for (const status of [OrderStatus.Open, OrderStatus.PartiallyFilled]) {
      assert.deepEqual(
        actionsFor(status),
        { activate: false, fill: true, cancel: true },
        String(status),
      );
    }
  });

  it("Expired: only Cancel, since an expired order still takes a slot", () => {
    assert.deepEqual(actionsFor(OrderStatus.Expired), {
      activate: false,
      fill: false,
      cancel: true,
    });
  });

  it("Filled, Cancelled, None and an unknown value: no buttons", () => {
    for (const status of [
      OrderStatus.Filled,
      OrderStatus.Cancelled,
      OrderStatus.None,
      9,
    ]) {
      assert.deepEqual(
        actionsFor(status),
        { activate: false, fill: false, cancel: false },
        String(status),
      );
    }
  });

  it("every status has a row in this table", () => {
    const covered = new Set<number>([
      OrderStatus.Dormant,
      OrderStatus.Open,
      OrderStatus.PartiallyFilled,
      OrderStatus.Expired,
      OrderStatus.Filled,
      OrderStatus.Cancelled,
      OrderStatus.None,
    ]);
    assert.deepEqual(
      [...covered].sort((a, b) => a - b),
      Object.values(OrderStatus).sort((a, b) => a - b),
    );
  });
});
