/**
 * POST /api/onboarding/calibrate-opener — handler-shape tests.
 *
 * Hotfix-2 (2026-05-05) contract: writes TWO Envoy ChannelMessages on first
 * invocation (seed-info bullets + warm anchor opener), idempotent on either
 * subkind, returns the persisted pair. The seed-info content is built from
 * the host's `preferences.explicit.*` so the bullets render the actual
 * Google-seed values they saw flash in `<PostureBubble>`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    channel: { findUnique: vi.fn(), create: vi.fn() },
    channelMessage: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { POST } from "@/app/api/onboarding/calibrate-opener/route";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { CALIBRATE_FIRST_TIME_OPENER_TEXT } from "@/lib/onboarding/calibrate-opener-text";

const USER_ID = "user_abc";
const USER_EMAIL = "host@example.com";
const CHANNEL_ID = "ch_xyz";

const FIXTURE_PREFS = {
  explicit: {
    businessHoursStartMinutes: 540, // 9:00am
    businessHoursEndMinutes: 1020, // 5:00pm
    defaultDuration: 30,
    videoProvider: "google_meet",
    timezone: "America/Los_Angeles",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: USER_EMAIL },
  });
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: USER_ID,
    preferences: FIXTURE_PREFS,
  });
  (prisma.channel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: CHANNEL_ID,
    userId: USER_ID,
  });
});

describe("POST /api/onboarding/calibrate-opener", () => {
  it("returns 401 when unauthenticated", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("writes BOTH messages atomically on first invocation", async () => {
    // No existing messages.
    (prisma.channelMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const seedInfoRow = {
      id: "msg_seed",
      role: "envoy",
      content: "(seed)",
      metadata: { kind: "onboarding", subkind: "calibrate-seed-info" },
    };
    const openerRow = {
      id: "msg_opener",
      role: "envoy",
      content: CALIBRATE_FIRST_TIME_OPENER_TEXT,
      metadata: { kind: "onboarding", subkind: "calibrate-opener" },
    };
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([
      seedInfoRow,
      openerRow,
    ]);

    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seedInfo: { id: string; content: string; metadata: { subkind: string } };
      opener: { id: string; content: string; metadata: { subkind: string } };
      message: { id: string };
    };

    expect(body.seedInfo.id).toBe("msg_seed");
    expect(body.opener.id).toBe("msg_opener");
    expect(body.message.id).toBe("msg_opener"); // back-compat alias
    expect(body.seedInfo.metadata.subkind).toBe("calibrate-seed-info");
    expect(body.opener.metadata.subkind).toBe("calibrate-opener");
    expect(body.opener.content).toBe(CALIBRATE_FIRST_TIME_OPENER_TEXT);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("writes seed-info with an EARLIER createdAt than opener (HOTFIX-3 ordering contract)", async () => {
    // Postgres `now()` inside a $transaction returns the same timestamp for
    // every row (transaction-start time). Hotfix-3 fixes that by passing
    // explicit JS Dates: seed-info gets the earlier timestamp.
    (prisma.channelMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const captured: Array<{ subkind: string; createdAt: Date }> = [];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (ops: unknown[]) => {
        const results = await Promise.all(
          (ops as Promise<unknown>[]).map((p) => p),
        );
        return results;
      },
    );
    (prisma.channelMessage.create as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: {
        data: { content: string; metadata: { subkind: string }; createdAt: Date };
      }) => {
        captured.push({
          subkind: args.data.metadata.subkind,
          createdAt: args.data.createdAt,
        });
        return { id: `msg_${args.data.metadata.subkind}`, ...args.data };
      },
    );

    const res = await POST();
    expect(res.status).toBe(200);

    expect(captured.length).toBe(2);
    const seed = captured.find((c) => c.subkind === "calibrate-seed-info");
    const opener = captured.find((c) => c.subkind === "calibrate-opener");
    expect(seed).toBeDefined();
    expect(opener).toBeDefined();
    expect(seed!.createdAt).toBeInstanceOf(Date);
    expect(opener!.createdAt).toBeInstanceOf(Date);
    // Strictly less-than: seed-info must sort BEFORE opener.
    expect(seed!.createdAt.getTime()).toBeLessThan(opener!.createdAt.getTime());
  });

  it("seed-info content includes all four bullet fields built from fixture preferences", async () => {
    (prisma.channelMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    let capturedSeedContent = "";
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (ops: unknown[]) => {
        // The route passes `prisma.channelMessage.create({...})` calls into
        // $transaction; these are unresolved promises in the real client.
        // Our mock for `channelMessage.create` returns the call args verbatim
        // when invoked, so we can read the seed content from the first op.
        const results = await Promise.all(
          (ops as Promise<unknown>[]).map((p) => p),
        );
        return results;
      },
    );
    (prisma.channelMessage.create as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { data: { content: string; metadata: { subkind: string } } }) => {
        if (args.data.metadata.subkind === "calibrate-seed-info") {
          capturedSeedContent = args.data.content;
        }
        return {
          id: `msg_${args.data.metadata.subkind}`,
          ...args.data,
        };
      },
    );

    const res = await POST();
    expect(res.status).toBe(200);

    // All four bullet fields present, with values from FIXTURE_PREFS.
    expect(capturedSeedContent).toContain("Business hours:");
    expect(capturedSeedContent).toContain("9am");
    expect(capturedSeedContent).toContain("5pm");
    expect(capturedSeedContent).toContain("Timezone:");
    expect(capturedSeedContent).toContain("Default meetings:");
    expect(capturedSeedContent).toContain("30-minute Google Meet");
    expect(capturedSeedContent).toContain("Reading from:");
    expect(capturedSeedContent).toContain("primary calendar");
    // Bold markdown so feed.tsx's renderMarkdown picks it up.
    expect(capturedSeedContent).toContain("**Business hours:**");
  });

  it("is idempotent — second invocation returns existing pair without creating duplicates", async () => {
    const existingSeedInfo = {
      id: "msg_seed_existing",
      metadata: { kind: "onboarding", subkind: "calibrate-seed-info" },
    };
    const existingOpener = {
      id: "msg_opener_existing",
      metadata: { kind: "onboarding", subkind: "calibrate-opener" },
    };
    (prisma.channelMessage.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(existingSeedInfo) // seed-info lookup
      .mockResolvedValueOnce(existingOpener); // opener lookup

    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seedInfo: { id: string };
      opener: { id: string };
      message: { id: string };
    };
    expect(body.seedInfo.id).toBe("msg_seed_existing");
    expect(body.opener.id).toBe("msg_opener_existing");
    expect(body.message.id).toBe("msg_opener_existing");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.channelMessage.create).not.toHaveBeenCalled();
  });

  it("is idempotent even when only ONE of the pair exists (slow-network edge)", async () => {
    // Only the seed-info row exists (the transaction was interrupted between
    // creates, or a partial-deploy state). We still skip creation and return
    // what we have — the user can still proceed with the existing seed-info,
    // and the dispatch override gracefully handles a missing opener (it's a
    // no-op when the latest envoy turn doesn't have the calibrate-opener
    // subkind).
    const existingSeedInfo = {
      id: "msg_seed_existing",
      metadata: { kind: "onboarding", subkind: "calibrate-seed-info" },
    };
    (prisma.channelMessage.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(existingSeedInfo)
      .mockResolvedValueOnce(null);

    const res = await POST();
    expect(res.status).toBe(200);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.channelMessage.create).not.toHaveBeenCalled();
  });
});
