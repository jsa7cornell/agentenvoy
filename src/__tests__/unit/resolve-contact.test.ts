/**
 * Unit tests for resolve-contact helpers.
 *
 * These tests cover the pure name-matching logic directly (levenshtein,
 * normalizeName, nameMatches) by importing the module and exercising it
 * through resolveContact with mock prisma. The levenshtein + fuzzy-name
 * helpers are internal but their behavior is observable through the public
 * resolveContact API.
 *
 * Since resolveContact hits prisma, these tests use vitest's mock facilities
 * to stub prisma. We test the decision logic, not the DB layer.
 *
 * Per PR4 proposal §4 — verify Levenshtein ≤2, first-name fallback,
 * ambiguous dedup, not_found path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Vitest automock for prisma ───────────────────────────────────────────────
vi.mock("@/lib/prisma", () => {
  const mockPrisma = {
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    negotiationSession: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  return { prisma: mockPrisma };
});

import { resolveContact } from "@/lib/resolve-contact";
import { prisma } from "@/lib/prisma";

const mockUser = prisma.user as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
};
const mockSession = prisma.negotiationSession as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
  // Default: no AE user, no history, count=0
  mockUser.findFirst.mockResolvedValue(null);
  mockUser.findMany.mockResolvedValue([]);
  mockSession.findMany.mockResolvedValue([]);
  mockSession.count.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------

describe("resolveContact — explicit email path", () => {
  it("returns ok:true for a known email with no AE account", async () => {
    const result = await resolveContact("caller-1", { email: "alice@example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.email).toBe("alice@example.com");
    expect(result.result.hasAgentEnvoyAccount).toBe(false);
    expect(result.result.resolvedFrom).toBe("explicit-email");
    expect(result.result.priorMeetingsCount).toBe(0);
  });

  it("returns ok:true with AE fields when the user has an AE account", async () => {
    mockUser.findFirst.mockResolvedValue({
      id: "user-ae-1",
      email: "alice@example.com",
      meetSlug: "alice",
    });
    mockSession.count.mockResolvedValue(3);

    const result = await resolveContact("caller-1", { email: "alice@example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.hasAgentEnvoyAccount).toBe(true);
    expect(result.result.meetSlug).toBe("alice");
    expect(result.result.userId).toBe("user-ae-1");
    expect(result.result.priorMeetingsCount).toBe(3);
    expect(result.result.resolvedFrom).toBe("explicit-email");
  });

  it("normalizes email to lowercase before lookup", async () => {
    await resolveContact("caller-1", { email: "ALICE@EXAMPLE.COM" });
    expect(mockUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: "alice@example.com", mode: "insensitive" } },
      }),
    );
  });
});

// ---------------------------------------------------------------------------

describe("resolveContact — name fuzzy match (history)", () => {
  it("returns not_found when history is empty and no AE accounts match", async () => {
    const result = await resolveContact("caller-1", { name: "Bryan" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_found");
  });

  it("returns ok:true for exact name match in history", async () => {
    const now = new Date();
    mockSession.findMany.mockResolvedValue([
      {
        guestName: "Bryan Smith",
        guestEmail: "bryan@acme.com",
        agreedTime: now,
        createdAt: now,
      },
    ]);

    const result = await resolveContact("caller-1", { name: "Bryan Smith" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.email).toBe("bryan@acme.com");
    expect(result.result.resolvedFrom).toBe("name-history-match");
  });

  it("matches by first name only (single token hint vs multi-token candidate)", async () => {
    const now = new Date();
    mockSession.findMany.mockResolvedValue([
      {
        guestName: "Bryan Smith",
        guestEmail: "bryan@acme.com",
        agreedTime: now,
        createdAt: now,
      },
    ]);

    // "Bryan" alone should match "Bryan Smith" via first-name fallback
    const result = await resolveContact("caller-1", { name: "Bryan" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.email).toBe("bryan@acme.com");
  });

  it("returns ambiguous when 2 different emails match by name", async () => {
    const d1 = new Date("2026-01-01T00:00:00Z");
    const d2 = new Date("2026-02-01T00:00:00Z");
    mockSession.findMany.mockResolvedValue([
      {
        guestName: "Bryan Smith",
        guestEmail: "bryan@acme.com",
        agreedTime: d1,
        createdAt: d1,
      },
      {
        guestName: "Brian Smith",
        guestEmail: "brian@corp.com",
        agreedTime: d2,
        createdAt: d2,
      },
    ]);

    const result = await resolveContact("caller-1", { name: "Bryan" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    // More recent should be first
    expect(result.candidates![0].email).toBe("brian@corp.com");
  });

  it("deduplicates multiple sessions for the same email (uses most recent)", async () => {
    const d1 = new Date("2026-01-01T00:00:00Z");
    const d2 = new Date("2026-03-01T00:00:00Z");
    mockSession.findMany.mockResolvedValue([
      {
        guestName: "Bryan Smith",
        guestEmail: "bryan@acme.com",
        agreedTime: d1,
        createdAt: d1,
      },
      {
        guestName: "Bryan Smith",
        guestEmail: "bryan@acme.com",
        agreedTime: d2,
        createdAt: d2,
      },
    ]);

    const result = await resolveContact("caller-1", { name: "Bryan" });
    expect(result.ok).toBe(true); // single unique email → not ambiguous
  });

  it("matches typo within Levenshtein ≤2 (Bran vs Bryan)", async () => {
    const now = new Date();
    mockSession.findMany.mockResolvedValue([
      {
        guestName: "Bryan Smith",
        guestEmail: "bryan@acme.com",
        agreedTime: now,
        createdAt: now,
      },
    ]);

    // "Bran Smith" has Levenshtein distance 2 from "Bryan Smith" (delete 'y', add 'a'... let's use a known close match)
    // "Bryn Smith" → 1 edit from "Bryan Smith" (delete 'a')
    const result = await resolveContact("caller-1", { name: "Bryn Smith" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.email).toBe("bryan@acme.com");
  });
});

// ---------------------------------------------------------------------------

describe("resolveContact — name fallback to AE directory", () => {
  it("returns ok:true when name matches a unique AE account but no history", async () => {
    // No history sessions
    mockSession.findMany.mockResolvedValue([]);
    // AE account directory has exactly one match
    mockUser.findMany.mockResolvedValue([
      { id: "user-ae-2", email: "carol@example.com", name: "Carol Jones", meetSlug: "carol" },
    ]);
    mockSession.count.mockResolvedValue(0);

    const result = await resolveContact("caller-1", { name: "Carol Jones" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.email).toBe("carol@example.com");
    expect(result.result.hasAgentEnvoyAccount).toBe(true);
    expect(result.result.userId).toBe("user-ae-2");
    expect(result.result.resolvedFrom).toBe("name-account-match");
  });

  it("returns ambiguous when 2 AE accounts match", async () => {
    mockSession.findMany.mockResolvedValue([]);
    mockUser.findMany.mockResolvedValue([
      { id: "user-1", email: "david@example.com", name: "David Lee", meetSlug: "david1" },
      { id: "user-2", email: "david@corp.com", name: "David Lee", meetSlug: "david2" },
    ]);

    const result = await resolveContact("caller-1", { name: "David Lee" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });
});
