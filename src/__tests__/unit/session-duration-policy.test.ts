/**
 * Locks in the role × shrink × opt-in matrix for `session_lock_duration`.
 *
 * cmp51ltr5 policy (2026-05-14, John): guests should be allowed to shrink
 * a meeting length. Extending requires the host's `guestPicks.duration`
 * opt-in. Hosts can always change duration.
 *
 * The matrix:
 *
 *   triggeringRole × (proposed vs. current) × guestPicks.duration
 *   {host, guest, undefined} × {shrink, same, extend} × {unset, false, true, [allowList]}
 *
 *   = 3 × 3 × 4 = 36 cells (most degenerate). Below covers the
 *   load-bearing ones.
 */

import { describe, it, expect } from "vitest";
import { shouldAllowSessionDurationChange } from "@/agent/actions";

describe("shouldAllowSessionDurationChange — host caller", () => {
  it("host can shrink without opt-in", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "host",
      proposedDuration: 30,
      currentDuration: 45,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("host");
  });

  it("host can extend without opt-in", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "host",
      proposedDuration: 90,
      currentDuration: 30,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("host");
  });

  it("host can change duration when no current is set", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "host",
      proposedDuration: 30,
      currentDuration: null,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("host");
  });
});

describe("shouldAllowSessionDurationChange — guest caller, the cmp51ltr5 policy", () => {
  it("guest can SHRINK without opt-in (the cmp51ltr5 fix)", () => {
    // Exact scenario from the report: guest said "change to 30 mins" on a
    // 45-min meeting. Pre-cmp51ltr5 the handler refused with the opt-in
    // gate; now it accepts as a shrink.
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 30,
      currentDuration: 45,
      // guestPicks.duration explicitly unset (the Mark Beavor link)
      guestPicksDuration: undefined,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("guest-shrink");
  });

  it("guest CANNOT extend without opt-in", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 60,
      currentDuration: 45,
      guestPicksDuration: undefined,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("no-opt-in");
  });

  it("guest CAN extend when host opted in (boolean true)", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 60,
      currentDuration: 45,
      guestPicksDuration: true,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("opt-in");
  });

  it("guest CAN extend when proposed duration is in the host's allow-list", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 60,
      currentDuration: 30,
      guestPicksDuration: [30, 45, 60],
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("opt-in");
  });

  it("guest's same-value request hits the opt-in gate (no shrink, no extend)", () => {
    // Idempotent same-value: the handler upstream handles this as a no-op,
    // but the policy decision still gates on opt-in for this branch.
    // The handler's pre-helper code returned a graceful no-op for this;
    // the helper is conservative here. Documents the contract.
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 45,
      currentDuration: 45,
      guestPicksDuration: undefined,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("no-opt-in");
  });

  it("guest with guestPicksDuration: false is identical to undefined (no opt-in)", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 60,
      currentDuration: 45,
      guestPicksDuration: false,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("no-opt-in");
  });

  it("guest CAN still shrink when opt-in is set (shrink-bypass wins, but reason reports shrink)", () => {
    // Defensive: when both bypasses apply, the function reports shrink
    // (the more permissive reason). Documents the OR semantics.
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 30,
      currentDuration: 45,
      guestPicksDuration: true,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("guest-shrink");
  });
});

describe("shouldAllowSessionDurationChange — current duration unknown", () => {
  it("falls through to opt-in gate when currentDuration is null (can't detect shrink)", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 30,
      currentDuration: null,
      guestPicksDuration: true,
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("opt-in");
  });

  it("refuses guest with null currentDuration AND no opt-in (can't determine policy)", () => {
    const r = shouldAllowSessionDurationChange({
      triggeringRole: "guest",
      proposedDuration: 30,
      currentDuration: null,
      guestPicksDuration: undefined,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("no-current-duration");
  });
});

describe("shouldAllowSessionDurationChange — triggeringRole undefined (conservative)", () => {
  it("treats undefined role as guest (the conservative default)", () => {
    // When the caller doesn't pass triggeringRole (legacy host-channel
    // path, missing-context migrations, etc.), apply the guest policy.
    // Shrink succeeds; extend without opt-in fails. Same as guest.
    const shrink = shouldAllowSessionDurationChange({
      proposedDuration: 30,
      currentDuration: 45,
    });
    expect(shrink.allow).toBe(true);
    expect(shrink.reason).toBe("guest-shrink");

    const extend = shouldAllowSessionDurationChange({
      proposedDuration: 60,
      currentDuration: 45,
    });
    expect(extend.allow).toBe(false);
    expect(extend.reason).toBe("no-opt-in");
  });
});
