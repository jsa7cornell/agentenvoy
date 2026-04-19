import { beforeEach, describe, expect, test } from "vitest";
import { prisma, resetDb } from "./helpers/db";
import { createActiveSession } from "./helpers/fixtures";

/**
 * Flagship integration test: proves that the confirm-pipeline's CAS
 * (`updateMany where status != 'agreed'`) admits exactly one winner
 * under concurrent load.
 *
 * This is the kernel of confirm-pipeline correctness. If two guests
 * click "Confirm" on the same slot within the same millisecond (or a
 * retry-happy client double-fires the request), exactly one must flip
 * `status: "active" → "agreed"`. The other must see `count === 0` and
 * fall through to the idempotent / 409 branches the route handles.
 *
 * To verify this test is LOAD-BEARING (catches the bug class, not just
 * runs green on good code), see the §Mutation-test procedure in
 * `app/src/__tests__/integration/README.md` — proposal-decided, checked-in
 * runbook per harness proposal reviewer B3.
 */

beforeEach(async () => {
  await resetDb();
});

describe("confirm-pipeline CAS concurrency", () => {
  test("two parallel confirms on the same active session: exactly one winner", async () => {
    const session = await createActiveSession();

    // Fire both updateMany calls in parallel. The CAS clause matches
    // the live route at src/app/api/negotiate/confirm/route.ts :276.
    const doConfirm = () =>
      prisma.negotiationSession.updateMany({
        where: { id: session.id, status: { not: "agreed" } },
        data: {
          status: "agreed",
          agreedTime: new Date(),
          agreedFormat: "video",
          summary: "concurrency test",
        },
      });

    const [a, b] = await Promise.all([doConfirm(), doConfirm()]);

    // Exactly one winner: the sum of update counts is exactly 1.
    expect(a.count + b.count).toBe(1);

    // Final state: the session is agreed.
    const after = await prisma.negotiationSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.status).toBe("agreed");
  });

  test("sequential second confirm is a no-op (already_agreed branch)", async () => {
    const session = await createActiveSession();

    const first = await prisma.negotiationSession.updateMany({
      where: { id: session.id, status: { not: "agreed" } },
      data: {
        status: "agreed",
        agreedTime: new Date(),
        agreedFormat: "video",
        summary: "first",
      },
    });
    const second = await prisma.negotiationSession.updateMany({
      where: { id: session.id, status: { not: "agreed" } },
      data: {
        status: "agreed",
        agreedTime: new Date(),
        agreedFormat: "phone",
        summary: "second",
      },
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);

    const after = await prisma.negotiationSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    // First writer's values survive; second writer's didn't land.
    expect(after.agreedFormat).toBe("video");
    expect(after.summary).toBe("first");
  });
});
