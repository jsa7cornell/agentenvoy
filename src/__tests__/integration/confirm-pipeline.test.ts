/**
 * confirmBooking end-to-end against real pg — proposal §"Verification plan"
 * item 3. Complements the raw-SQL CAS test in
 * `confirm-pipeline.concurrency.test.ts` by driving the full pipeline
 * function (not just the `updateMany`).
 *
 * Side-effect env: no `EFFECT_MODE_CALENDAR=live` / `EFFECT_MODE_EMAIL=live`
 * in test, so `dispatch()` runs in dryrun/log mode. Calendar events return
 * synthetic `dryrun-*` ids; the pipeline's `isSynthetic` branch only logs
 * when `NODE_ENV === "production"` so tests stay quiet.
 *
 * `extractLearnings` runs inside `waitUntil()` — fire-and-forget, wrapped
 * in try/catch; doesn't affect the synchronous assertion path.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { prisma, resetDb } from "./helpers/db";
import { createActiveSession } from "./helpers/fixtures";
import { confirmBooking } from "@/lib/confirm-pipeline";

beforeEach(async () => {
  await resetDb();
});

describe("confirmBooking — integration", () => {
  test("single call on an active session → ok:true success + session.status='agreed'", async () => {
    const session = await createActiveSession();
    const slotStart = new Date("2026-05-01T15:00:00Z");

    const result = await confirmBooking({
      sessionId: session.id,
      dateTime: slotStart.toISOString(),
      duration: 30,
      format: "video",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("success");
    expect(result.status).toBe("confirmed");
    expect(new Date(result.dateTime).getTime()).toBe(slotStart.getTime());
    expect(result.attempt.sessionId).toBe(session.id);

    const after = await prisma.negotiationSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.status).toBe("agreed");
    expect(after.agreedTime?.getTime()).toBe(slotStart.getTime());
    expect(after.agreedFormat).toBe("video");
  });

  test("two parallel confirms on same session → exactly one success, one already_agreed", async () => {
    const session = await createActiveSession();
    const slotStart = new Date("2026-05-01T15:00:00Z");

    const [a, b] = await Promise.all([
      confirmBooking({
        sessionId: session.id,
        dateTime: slotStart.toISOString(),
        duration: 30,
        format: "video",
      }),
      confirmBooking({
        sessionId: session.id,
        dateTime: slotStart.toISOString(),
        duration: 30,
        format: "video",
      }),
    ]);

    // Exactly one ok:true success, one ok:true already_agreed — the CAS loser
    // falls through to the winner-reload branch when the slot matches.
    const outcomes = [a, b].map((r) => (r.ok ? r.outcome : `refused:${r.reason}`)).sort();
    expect(outcomes).toEqual(["already_agreed", "success"]);

    // Idempotent flag is set on the loser only.
    const loser = [a, b].find((r) => r.ok && r.outcome === "already_agreed");
    expect(loser?.ok).toBe(true);
    if (loser?.ok) expect(loser.idempotent).toBe(true);

    const after = await prisma.negotiationSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.status).toBe("agreed");
  });

  test("second call at a DIFFERENT slot on an agreed session → ok:false slot_mismatch", async () => {
    const session = await createActiveSession();
    const slotA = new Date("2026-05-01T15:00:00Z");
    const slotB = new Date("2026-05-01T17:00:00Z");

    const first = await confirmBooking({
      sessionId: session.id,
      dateTime: slotA.toISOString(),
      duration: 30,
    });
    expect(first.ok).toBe(true);

    const second = await confirmBooking({
      sessionId: session.id,
      dateTime: slotB.toISOString(),
      duration: 30,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("slot_mismatch");
  });

  test("missing sessionId → ok:false validation_failed (no DB read)", async () => {
    const result = await confirmBooking({
      sessionId: "",
      dateTime: "2026-05-01T15:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation_failed");
    expect(result.attempt.outcome).toBe("validation_failed");
  });

  test("unknown session → ok:false session_not_found", async () => {
    const result = await confirmBooking({
      sessionId: "does-not-exist",
      dateTime: "2026-05-01T15:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session_not_found");
  });
});
