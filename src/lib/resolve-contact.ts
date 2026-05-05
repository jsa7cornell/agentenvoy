/**
 * resolveContact — identity resolution for the bookings module.
 *
 * Pure query helper. No schema changes. No side effects beyond DB reads.
 *
 * Per proposal `2026-05-02_book-time-with-bilateral-availability.md` §3.3.
 *
 * Q2 decision (REFUSAL-with-LIST): when 2+ candidates match by name, return
 * `{ ok: false, reason: "ambiguous", candidates }`. The LLM asks the host to
 * disambiguate. Booking the wrong person is high-cost; one extra round-trip is cheap.
 */

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContactHint =
  | { email: string; name?: string }
  | { name: string };

export interface ResolutionResult {
  email: string;
  hasAgentEnvoyAccount: boolean;
  meetSlug?: string;
  userId?: string;
  priorMeetingsCount: number;
  resolvedFrom: "explicit-email" | "name-history-match" | "name-account-match";
}

export type ResolveContactResult =
  | { ok: true; result: ResolutionResult }
  | {
      ok: false;
      reason: "not_found" | "ambiguous";
      candidates?: Array<{ email: string; name: string | null; lastSeenAt: string }>;
    };

// ---------------------------------------------------------------------------
// Levenshtein distance helper
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array<number>(n + 1).fill(0);
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

const LEVENSHTEIN_THRESHOLD = 2;

function nameMatches(hint: string, candidate: string): boolean {
  const hintN = normalizeName(hint);
  const candidateN = normalizeName(candidate);

  if (hintN === candidateN) return true;
  if (levenshtein(hintN, candidateN) <= LEVENSHTEIN_THRESHOLD) return true;

  const hintTokens = hintN.split(" ");
  if (hintTokens.length === 1) {
    const candidateFirst = candidateN.split(" ")[0];
    if (levenshtein(hintN, candidateFirst) <= LEVENSHTEIN_THRESHOLD) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function resolveContact(
  callerUserId: string,
  hint: ContactHint,
): Promise<ResolveContactResult> {
  // ── Path 1: Explicit email ───────────────────────────────────────────────
  if ("email" in hint && hint.email) {
    const emailNorm = normalizeEmail(hint.email);

    const aeUser = await prisma.user.findFirst({
      where: { email: { equals: emailNorm, mode: "insensitive" } },
      select: { id: true, email: true, meetSlug: true },
    });

    const priorMeetingsCount = await prisma.negotiationSession.count({
      where: {
        hostId: callerUserId,
        guestEmail: { equals: emailNorm, mode: "insensitive" },
      },
    });

    return {
      ok: true,
      result: {
        email: aeUser?.email ?? emailNorm,
        hasAgentEnvoyAccount: aeUser !== null,
        ...(aeUser?.meetSlug ? { meetSlug: aeUser.meetSlug } : {}),
        ...(aeUser?.id ? { userId: aeUser.id } : {}),
        priorMeetingsCount,
        resolvedFrom: "explicit-email",
      },
    };
  }

  // ── Path 2: Name-only fuzzy match ────────────────────────────────────────
  if (!("name" in hint) || !hint.name) {
    return { ok: false, reason: "not_found" };
  }

  const nameHint = hint.name;

  // Pass 2a: Caller's NegotiationSession history.
  const historySessions = await prisma.negotiationSession.findMany({
    where: {
      hostId: callerUserId,
      guestName: { not: null },
      guestEmail: { not: null },
    },
    select: {
      guestName: true,
      guestEmail: true,
      agreedTime: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const historyMatchMap = new Map<
    string,
    { email: string; name: string | null; lastSeenAt: Date }
  >();
  for (const s of historySessions) {
    if (!s.guestName || !s.guestEmail) continue;
    if (!nameMatches(nameHint, s.guestName)) continue;
    const emailKey = normalizeEmail(s.guestEmail);
    const existingEntry = historyMatchMap.get(emailKey);
    const lastSeen = s.agreedTime ?? s.createdAt;
    if (!existingEntry || lastSeen > existingEntry.lastSeenAt) {
      historyMatchMap.set(emailKey, {
        email: s.guestEmail,
        name: s.guestName,
        lastSeenAt: lastSeen,
      });
    }
  }

  if (historyMatchMap.size === 1) {
    const [emailKey, entry] = [...historyMatchMap.entries()][0];
    const aeUser = await prisma.user.findFirst({
      where: { email: { equals: emailKey, mode: "insensitive" } },
      select: { id: true, email: true, meetSlug: true },
    });
    const priorMeetingsCount = await prisma.negotiationSession.count({
      where: {
        hostId: callerUserId,
        guestEmail: { equals: emailKey, mode: "insensitive" },
      },
    });
    return {
      ok: true,
      result: {
        email: entry.email,
        hasAgentEnvoyAccount: aeUser !== null,
        ...(aeUser?.meetSlug ? { meetSlug: aeUser.meetSlug } : {}),
        ...(aeUser?.id ? { userId: aeUser.id } : {}),
        priorMeetingsCount,
        resolvedFrom: "name-history-match",
      },
    };
  }

  if (historyMatchMap.size >= 2) {
    const candidates = [...historyMatchMap.values()]
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((e) => ({
        email: e.email,
        name: e.name,
        lastSeenAt: e.lastSeenAt.toISOString(),
      }));
    return { ok: false, reason: "ambiguous", candidates };
  }

  // Pass 2b: AE account directory by User.name.
  const accountMatches = await prisma.user.findMany({
    where: {
      name: { not: null },
    },
    select: { id: true, email: true, name: true, meetSlug: true },
    take: 1000,
  });

  const accountMatchMap = new Map<
    string,
    { id: string; email: string; name: string; meetSlug: string | null }
  >();
  for (const u of accountMatches) {
    if (!u.email || !u.name) continue;
    if (!nameMatches(nameHint, u.name)) continue;
    accountMatchMap.set(normalizeEmail(u.email), {
      id: u.id,
      email: u.email,
      name: u.name,
      meetSlug: u.meetSlug,
    });
  }

  if (accountMatchMap.size === 1) {
    const entry = [...accountMatchMap.values()][0];
    const priorMeetingsCount = await prisma.negotiationSession.count({
      where: {
        hostId: callerUserId,
        guestEmail: { equals: normalizeEmail(entry.email), mode: "insensitive" },
      },
    });
    return {
      ok: true,
      result: {
        email: entry.email,
        hasAgentEnvoyAccount: true,
        ...(entry.meetSlug ? { meetSlug: entry.meetSlug } : {}),
        userId: entry.id,
        priorMeetingsCount,
        resolvedFrom: "name-account-match",
      },
    };
  }

  if (accountMatchMap.size >= 2) {
    const candidates = [...accountMatchMap.values()].map((e) => ({
      email: e.email,
      name: e.name,
      lastSeenAt: new Date(0).toISOString(),
    }));
    return { ok: false, reason: "ambiguous", candidates };
  }

  return { ok: false, reason: "not_found" };
}
