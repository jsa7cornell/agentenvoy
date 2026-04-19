import { beforeEach, describe, expect, test } from "vitest";
import { resetDb } from "./helpers/db";
import { createLink } from "./helpers/fixtures";
import {
  createConsentRequest,
  acceptConsentRequest,
  retractConsentRequest,
  guardConsentForProposeLock,
} from "@/lib/mcp/consent-request";

/**
 * SPEC §2. propose_lock refuses with `consent_not_accepted` if any
 * ConsentRequest for (linkId, field) is in {pending, retracted, expired}.
 * Only `accepted` clears the way.
 */

beforeEach(async () => {
  await resetDb();
});

describe("guardConsentForProposeLock", () => {
  test("ok when no consent rows exist", async () => {
    const link = await createLink();
    const r = await guardConsentForProposeLock(link.id, "format");
    expect(r).toEqual({ ok: true });
  });

  test("blocks on pending", async () => {
    const link = await createLink();
    await createConsentRequest({
      linkId: link.id,
      field: "format",
      appliedValue: { format: "video" },
    });
    const r = await guardConsentForProposeLock(link.id, "format");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("consent_not_accepted");
    expect(r.blockingStatuses).toEqual(["pending"]);
  });

  test("blocks on retracted", async () => {
    const link = await createLink();
    const req = await createConsentRequest({
      linkId: link.id,
      field: "format",
      appliedValue: { format: "video" },
    });
    await retractConsentRequest(req.id, "guest");

    const r = await guardConsentForProposeLock(link.id, "format");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockingStatuses).toEqual(["retracted"]);
  });

  test("ok when the only row is accepted", async () => {
    const link = await createLink();
    const req = await createConsentRequest({
      linkId: link.id,
      field: "format",
      appliedValue: { format: "video" },
    });
    await acceptConsentRequest(req.id, "guest");

    const r = await guardConsentForProposeLock(link.id, "format");
    expect(r).toEqual({ ok: true });
  });

  test("blocks when any row is non-accepted (mix of accepted + pending)", async () => {
    const link = await createLink();
    const r1 = await createConsentRequest({
      linkId: link.id,
      field: "format",
      appliedValue: { format: "video" },
    });
    await acceptConsentRequest(r1.id, "guest");
    await createConsentRequest({
      linkId: link.id,
      field: "format",
      appliedValue: { format: "phone" },
    });

    const r = await guardConsentForProposeLock(link.id, "format");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockingStatuses).toContain("pending");
  });

  test("scoped by (linkId, field) — other field is unaffected", async () => {
    const link = await createLink();
    await createConsentRequest({
      linkId: link.id,
      field: "format",
      appliedValue: { format: "video" },
    });
    const r = await guardConsentForProposeLock(link.id, "duration");
    expect(r).toEqual({ ok: true });
  });
});
