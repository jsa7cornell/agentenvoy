/**
 * Notification emitter tests — proposal 2026-04-22 recurring-series R2
 * "always notify". See src/lib/notifications.ts.
 *
 * Asserts:
 *   - happy path writes a row with the expected shape
 *   - headline longer than 280 chars is truncated with an ellipsis
 *   - optional fields (sessionId / linkId / detail / cta) are passed through
 *     only when provided
 *   - CTA kind maps correctly from axis ("time" → "ack_time" etc.)
 *   - Prisma create failures are swallowed (returns false, logs — never throws)
 *   - emitAckPair writes two rows, proposer + recipient, with the right
 *     kinds, actor labels, and CTA presence
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  emitNotification,
  emitAckPair,
} from "@/lib/notifications";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitNotification", () => {
  it("writes a row on the happy path", async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
    const ok = await emitNotification({
      userId: "u_host",
      kind: "series_started",
      actorKind: "system",
      actorLabel: "Envoy",
      headline: "Your weekly with Sam is set up.",
      linkId: "lnk_abc",
    });
    expect(ok).toBe(true);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.notification.create).mock.calls[0][0];
    expect(call.data).toMatchObject({
      userId: "u_host",
      kind: "series_started",
      actorKind: "system",
      actorLabel: "Envoy",
      headline: "Your weekly with Sam is set up.",
      linkId: "lnk_abc",
    });
    // Unspecified fields default to null, not undefined, so the DB stores a
    // deterministic shape.
    expect(call.data.sessionId).toBeNull();
    expect(call.data.linkOccurrenceId).toBeNull();
    expect(call.data.detail).toBeNull();
    expect(call.data.ctaKind).toBeNull();
  });

  it("truncates headline over 280 chars with an ellipsis", async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
    const long = "a".repeat(400);
    await emitNotification({
      userId: "u_host",
      kind: "schedule_changed",
      actorKind: "host",
      headline: long,
    });
    const call = vi.mocked(prisma.notification.create).mock.calls[0][0];
    expect(call.data.headline).toHaveLength(280);
    expect(call.data.headline.endsWith("…")).toBe(true);
    // Ensure the pre-ellipsis content is the original prefix.
    expect(call.data.headline.slice(0, -1)).toBe("a".repeat(279));
  });

  it("passes the CTA payload through when provided", async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
    await emitNotification({
      userId: "u_guest",
      kind: "awaiting_ack_self",
      actorKind: "host",
      actorLabel: "John",
      headline: "John wants to move Friday to Thursday",
      cta: {
        kind: "ack_time",
        payload: {
          occurrenceId: "occ_1",
          proposedStartAt: "2026-05-08T22:00:00Z",
        },
      },
    });
    const call = vi.mocked(prisma.notification.create).mock.calls[0][0];
    expect(call.data.ctaKind).toBe("ack_time");
    expect(call.data.ctaPayload).toMatchObject({
      occurrenceId: "occ_1",
      proposedStartAt: "2026-05-08T22:00:00Z",
    });
  });

  it("returns false and does not throw when prisma rejects", async () => {
    // Silence console.error for this test — we're asserting the fail-soft
    // path intentionally logs.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.notification.create).mockRejectedValueOnce(
      new Error("db unavailable"),
    );
    const ok = await emitNotification({
      userId: "u_host",
      kind: "schedule_changed",
      actorKind: "system",
      headline: "x",
    });
    expect(ok).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("emitAckPair", () => {
  it("writes proposer + recipient rows with correct kinds and labels", async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
    await emitAckPair({
      proposerUserId: "u_host",
      recipientUserId: "u_guest",
      proposerLabelForRecipient: "John",
      recipientLabelForProposer: "Sam",
      axis: "time",
      headlineForProposer: "Sam hasn't confirmed the move yet",
      headlineForRecipient: "John wants to move Friday to Thursday",
      linkId: "lnk_abc",
      linkOccurrenceId: "occ_1",
      ackPayload: { occurrenceId: "occ_1", proposedStartAt: "2026-05-08" },
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(prisma.notification.create).mock.calls.map(
      (c) => c[0].data,
    );
    const proposerRow = calls.find(
      (d) => d.userId === "u_host",
    )!;
    const recipientRow = calls.find(
      (d) => d.userId === "u_guest",
    )!;
    expect(proposerRow.kind).toBe("awaiting_ack_counterparty");
    expect(proposerRow.actorLabel).toBe("Sam");
    expect(proposerRow.ctaKind).toBeNull(); // proposer has nothing to click
    expect(recipientRow.kind).toBe("awaiting_ack_self");
    expect(recipientRow.actorLabel).toBe("John");
    expect(recipientRow.ctaKind).toBe("ack_time");
  });

  it("maps format axis to ack_format CTA", async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
    await emitAckPair({
      proposerUserId: "u_host",
      recipientUserId: "u_guest",
      proposerLabelForRecipient: "John",
      recipientLabelForProposer: "Sam",
      axis: "format",
      headlineForProposer: "waiting",
      headlineForRecipient: "proposed",
      ackPayload: {},
    });
    const recipientRow = vi
      .mocked(prisma.notification.create)
      .mock.calls.map((c) => c[0].data)
      .find((d) => d.userId === "u_guest")!;
    expect(recipientRow.ctaKind).toBe("ack_format");
  });

  it("maps location axis to ack_location CTA", async () => {
    vi.mocked(prisma.notification.create).mockResolvedValue({} as never);
    await emitAckPair({
      proposerUserId: "u_host",
      recipientUserId: "u_guest",
      proposerLabelForRecipient: "John",
      recipientLabelForProposer: "Sam",
      axis: "location",
      headlineForProposer: "waiting",
      headlineForRecipient: "proposed",
      ackPayload: {},
    });
    const recipientRow = vi
      .mocked(prisma.notification.create)
      .mock.calls.map((c) => c[0].data)
      .find((d) => d.userId === "u_guest")!;
    expect(recipientRow.ctaKind).toBe("ack_location");
  });
});
