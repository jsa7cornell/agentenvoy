/**
 * deal-room — confirmedData invalidation on server-status transitions.
 *
 * Locks in the directional rule from cmp4ss1ip (2026-05-14): a previously-
 * confirmed session that the server resets back to `active` (via
 * `session_request_reschedule`) must drop the local confirmData; the
 * picker-optimistic race window (`active → agreed`) must NOT drop it.
 *
 * The reducer's case-arms cover `cancelled` and `retime_proposed` directly;
 * `agreed → active` is the case the case-arms can't own (because `active`
 * also represents "fresh session" + "in-flight optimistic confirm"). The
 * helper isolates that one directional check so it stays testable.
 *
 * Variant axis: {prev: agreed, active, proposed, retime_proposed, cancelled, null}
 *               × {next: agreed, active, proposed, retime_proposed, cancelled, undefined}
 *
 * Only `agreed → active` returns true. All other transitions return false
 * (they're either handled by the case-arms above or are no-op / mid-flow).
 */

import { describe, it, expect } from "vitest";
import {
  shouldInvalidateConfirmedOnStatusTransition,
  type SessionStatus,
} from "@/components/deal-room";

describe("shouldInvalidateConfirmedOnStatusTransition", () => {
  it("returns true ONLY on the agreed → active transition (cmp4ss1ip)", () => {
    expect(shouldInvalidateConfirmedOnStatusTransition("agreed", "active")).toBe(true);
  });

  it("returns false on the picker-optimistic race direction (active → agreed)", () => {
    // The opposite direction: this is the race the default-branch comment
    // protects. Local confirmData was set optimistically by the picker; the
    // first server poll back may show status=active (still merging). Then
    // a subsequent tick returns status=agreed and the case-arm sets
    // confirmData from server. Invalidating on active → agreed would break
    // the optimistic flicker-prevention.
    expect(shouldInvalidateConfirmedOnStatusTransition("active", "agreed")).toBe(false);
  });

  it("returns false on agreed → agreed (idempotent re-confirm)", () => {
    expect(shouldInvalidateConfirmedOnStatusTransition("agreed", "agreed")).toBe(false);
  });

  it("returns false on agreed → cancelled (owned by the cancelled case-arm)", () => {
    // The case-arm at deal-room.tsx ~824 handles this — sets confirmed=false
    // + confirmData=null inline. This helper must NOT also fire or we'd
    // double-invalidate (harmless but wasteful) and create ambiguity about
    // which path owns the reset.
    expect(shouldInvalidateConfirmedOnStatusTransition("agreed", "cancelled")).toBe(false);
  });

  it("returns false on agreed → retime_proposed (owned by retime_proposed case-arm)", () => {
    expect(shouldInvalidateConfirmedOnStatusTransition("agreed", "retime_proposed")).toBe(false);
  });

  it("returns false on null → active (fresh session, first server response)", () => {
    // On initial mount, prev is null. Local confirmData starts as null too,
    // so there's nothing to invalidate; helper returning false is correct.
    expect(shouldInvalidateConfirmedOnStatusTransition(null, "active")).toBe(false);
  });

  it("returns false on null → agreed (cold-load of an already-confirmed session)", () => {
    // The agreed case-arm will populate confirmData from server. No prior
    // state to invalidate.
    expect(shouldInvalidateConfirmedOnStatusTransition(null, "agreed")).toBe(false);
  });

  it("returns false on active → active (idle polling tick, no change)", () => {
    expect(shouldInvalidateConfirmedOnStatusTransition("active", "active")).toBe(false);
  });

  it("returns false on proposed → active (picker dismissed, returning to base)", () => {
    expect(shouldInvalidateConfirmedOnStatusTransition("proposed", "active")).toBe(false);
  });

  it("returns false on retime_proposed → active (retime path; retime_proposed case-arm already cleared)", () => {
    // When a session went agreed → retime_proposed → active, the
    // retime_proposed case-arm at deal-room.tsx ~824 already cleared
    // confirmData on the prior tick. By the time we see retime_proposed →
    // active, confirmData is already null; the helper need not fire.
    expect(shouldInvalidateConfirmedOnStatusTransition("retime_proposed", "active")).toBe(false);
  });

  it("returns false on agreed → undefined (server omitted status, no signal)", () => {
    // Defensive: if the server payload lacks a status field, treat it as a
    // no-op rather than blasting confirmData.
    expect(shouldInvalidateConfirmedOnStatusTransition("agreed", undefined)).toBe(false);
  });

  it("exhaustive: no other (prev, next) pair returns true", () => {
    // Defense against a future refactor expanding the rule. Encode the
    // current contract: only ONE pair returns true.
    const allStatuses: (SessionStatus | null | undefined)[] = [
      "active",
      "proposed",
      "agreed",
      "cancelled",
      "retime_proposed",
      null,
      undefined,
    ];
    let trueCount = 0;
    let truePair: [unknown, unknown] | null = null;
    for (const prev of allStatuses) {
      for (const next of allStatuses) {
        if (
          shouldInvalidateConfirmedOnStatusTransition(
            prev as SessionStatus | null,
            next as SessionStatus | undefined,
          )
        ) {
          trueCount++;
          truePair = [prev, next];
        }
      }
    }
    expect(trueCount).toBe(1);
    expect(truePair).toEqual(["agreed", "active"]);
  });
});
