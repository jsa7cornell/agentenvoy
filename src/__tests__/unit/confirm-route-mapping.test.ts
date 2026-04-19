/**
 * Route-handler mapping test — the B3 middle-path from the confirm-pipeline
 * extraction proposal. Imports POST in-process and hand-calls it with a
 * stubbed NextRequest per ConfirmResult variant; asserts HTTP status +
 * response-body shape. No Next dev server, no port, no flake.
 *
 * `confirmBooking` is mocked at the test boundary so each variant exercises
 * the switch without touching pg. The ConfirmAttempt write is mocked too
 * because the route's `finally` block is non-awaited and would otherwise
 * throw "prisma is undefined" in unit context.
 *
 * Covers exactly the 6 `ConfirmResult` branches:
 *   1. ok: true, outcome: "success"              → 200 (happy path)
 *   2. ok: true, outcome: "success" + gcal_failed warning → 200 (degraded)
 *   3. ok: true, outcome: "already_agreed"       → 200 (idempotent)
 *   4. ok: false, reason: "validation_failed"    → 400
 *   5. ok: false, reason: "in_person_disallowed" → 409
 *   6. ok: false, reason: "slot_mismatch"        → 409
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConfirmResult } from "@/lib/confirm-pipeline";

// Mock the pipeline before importing the route.
const mockConfirmBooking = vi.fn<(...args: unknown[]) => Promise<ConfirmResult>>();
vi.mock("@/lib/confirm-pipeline", () => ({
  confirmBooking: (...args: unknown[]) => mockConfirmBooking(...args),
}));

// Mock prisma so the `finally` ConfirmAttempt write doesn't explode.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    confirmAttempt: {
      create: vi.fn().mockReturnValue({
        catch: () => {
          /* fire-and-forget no-op */
        },
      }),
    },
  },
}));

// Mock logRouteError (only fires on top-level throw).
vi.mock("@/lib/route-error", () => ({ logRouteError: vi.fn() }));

import { POST } from "@/app/api/negotiate/confirm/route";

function makeReq(body: unknown): Parameters<typeof POST>[0] {
  return {
    headers: { get: () => "test-ua" },
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

const baseAttempt = {
  outcome: "success" as const,
  error: null,
  sessionId: "sess_1",
  slotStart: new Date("2026-05-01T15:00:00Z"),
  slotEnd: new Date("2026-05-01T15:30:00Z"),
};

describe("POST /api/negotiate/confirm — ConfirmResult → HTTP mapping", () => {
  beforeEach(() => mockConfirmBooking.mockReset());

  it("ok:true success → 200 with confirmation body", async () => {
    mockConfirmBooking.mockResolvedValueOnce({
      ok: true,
      outcome: "success",
      status: "confirmed",
      dateTime: "2026-05-01T15:00:00.000Z",
      duration: 30,
      format: "video",
      location: null,
      meetLink: "https://meet.example/abc",
      eventLink: "https://cal.example/e1",
      emailSent: true,
      attempt: baseAttempt,
    });

    const res = await POST(makeReq({ sessionId: "sess_1", dateTime: "2026-05-01T15:00:00Z" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("confirmed");
    expect(body.emailSent).toBe(true);
    expect(body.idempotent).toBeUndefined();
  });

  it("ok:true success with gcal_failed warning → still 200", async () => {
    // B1 behavior-preserving guarantee: degraded GCal does NOT flip 200→502.
    mockConfirmBooking.mockResolvedValueOnce({
      ok: true,
      outcome: "success",
      status: "confirmed",
      dateTime: "2026-05-01T15:00:00.000Z",
      duration: 30,
      format: "video",
      location: null,
      emailSent: true,
      warnings: ["gcal_failed"],
      attempt: { ...baseAttempt, outcome: "gcal_failed", error: "gcal down" },
    });

    const res = await POST(makeReq({ sessionId: "sess_1", dateTime: "2026-05-01T15:00:00Z" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("confirmed");
  });

  it("ok:true already_agreed → 200 with idempotent:true", async () => {
    mockConfirmBooking.mockResolvedValueOnce({
      ok: true,
      outcome: "already_agreed",
      status: "confirmed",
      dateTime: "2026-05-01T15:00:00.000Z",
      duration: 30,
      format: "video",
      location: null,
      emailSent: false,
      idempotent: true,
      attempt: { ...baseAttempt, outcome: "already_agreed" },
    });

    const res = await POST(makeReq({ sessionId: "sess_1", dateTime: "2026-05-01T15:00:00Z" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
  });

  it("ok:false validation_failed → 400", async () => {
    mockConfirmBooking.mockResolvedValueOnce({
      ok: false,
      reason: "validation_failed",
      message: "Missing sessionId or dateTime",
      attempt: { ...baseAttempt, outcome: "validation_failed", error: "Missing sessionId or dateTime", sessionId: null },
    });

    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing");
  });

  it("ok:false session_not_found → 404", async () => {
    mockConfirmBooking.mockResolvedValueOnce({
      ok: false,
      reason: "session_not_found",
      message: "Session not found",
      attempt: { ...baseAttempt, outcome: "validation_failed", error: "Session not found" },
    });

    const res = await POST(makeReq({ sessionId: "nope", dateTime: "2026-05-01T15:00:00Z" }));
    expect(res.status).toBe(404);
  });

  it("ok:false in_person_disallowed → 409", async () => {
    mockConfirmBooking.mockResolvedValueOnce({
      ok: false,
      reason: "in_person_disallowed",
      message:
        "In-person meetings are not available at that time per the host's schedule rules. Try video or phone, or pick a different slot.",
      attempt: { ...baseAttempt, outcome: "validation_failed", error: "In-person blocked" },
    });

    const res = await POST(makeReq({ sessionId: "sess_1", dateTime: "2026-05-01T15:00:00Z" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/in-person/i);
  });

  it("ok:false slot_mismatch → 409", async () => {
    mockConfirmBooking.mockResolvedValueOnce({
      ok: false,
      reason: "slot_mismatch",
      message: "Session already confirmed for a different slot",
      attempt: { ...baseAttempt, outcome: "slot_mismatch", error: "different slot" },
    });

    const res = await POST(makeReq({ sessionId: "sess_1", dateTime: "2026-05-01T15:00:00Z" }));
    expect(res.status).toBe(409);
  });

  it("top-level throw → 500 (e.g. malformed body)", async () => {
    const bad = {
      headers: { get: () => "test-ua" },
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];
    const res = await POST(bad);
    expect(res.status).toBe(500);
    expect(mockConfirmBooking).not.toHaveBeenCalled();
  });
});
