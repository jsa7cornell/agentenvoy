/**
 * POST /api/feedback/prefill — Haiku-generated first-person bug-report draft
 * for the Send Feedback modal (deal-room symmetry proposal, 2026-04-21).
 *
 * Two auth branches, shared prompt:
 *   - Session path: NextAuth-authenticated host. Reads recent messages from
 *     the host's Channel + recent RouteErrors.
 *   - Guest path: linkCode only. Reads messages from the link's shared
 *     session, scoped through the bundle builder's same allowlist pattern.
 *
 * Rate-limited per (userId or linkCode) with a 30-second window for hosts
 * and 60-second window for guests. Cache key is
 * `(identity, sessionId, lastMessageId)` so re-opening the modal without
 * new activity replays the cached draft synchronously on the next render.
 *
 * Empty-string return is a valid "no signal" — clients render nothing.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { generateText } from "ai";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { envoyModel } from "@/lib/model";

export const dynamic = "force-dynamic";

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    const appUrl = process.env.NEXTAUTH_URL;
    if (appUrl) {
      const appHost = new URL(appUrl).hostname;
      if (url.hostname === appHost) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const GUEST_VISIBLE_ROLES = new Set([
  "host",
  "guest",
  "administrator",
  "guest_envoy",
  "external_agent",
]);

const MAX_MESSAGES = 20;
const MAX_ROUTE_ERRORS = 10;

// Process-local rate-limit + draft cache. Intentionally tiny — per-lambda
// state; a bad-faith attacker crossing lambdas can bypass. That's fine for
// a prefill endpoint: the worst-case outcome is an extra Haiku call, not
// lost data or privilege escalation.
const HOST_RATE_MS = 30 * 1000;
const GUEST_RATE_MS = 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const rateBucket = new Map<string, number>();
const draftCache = new Map<string, { draft: string; at: number }>();

function rateLimitHit(key: string, windowMs: number): boolean {
  const now = Date.now();
  const last = rateBucket.get(key) ?? 0;
  if (now - last < windowMs) return true;
  rateBucket.set(key, now);
  return false;
}

function cacheGet(key: string): string | null {
  const hit = draftCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    draftCache.delete(key);
    return null;
  }
  return hit.draft;
}

function cacheSet(key: string, draft: string) {
  if (draftCache.size >= CACHE_MAX) {
    const firstKey = draftCache.keys().next().value;
    if (firstKey) draftCache.delete(firstKey);
  }
  draftCache.set(key, { draft, at: Date.now() });
}

function stripActionPayloads(content: string): string {
  return content.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g, "").trim();
}

async function runHaikuPrefill(input: {
  messages: Array<{ role: string; content: string; createdAt: string }>;
  routeErrors: Array<{ route: string; message: string; createdAt: string }>;
  url: string | undefined;
}): Promise<string> {
  if (input.messages.length === 0 && input.routeErrors.length === 0) {
    return "";
  }
  try {
    const system = `You are reading a user's recent interactions in a scheduling product.
Their task: if something recently went wrong or they seemed confused, write a short
(1-2 sentences) first-person draft of what they would say if reporting a bug.

If there is no clear signal of something going wrong, return an empty string.

Never mention specific people's names. Never invent details not in the input.
Return ONLY JSON matching: { "draft": string }`;

    const prompt = [
      `URL: ${input.url ?? "(not provided)"}`,
      "",
      "Recent messages (most recent last):",
      input.messages
        .map((m) => `- [${m.role}] ${m.content.slice(0, 400)}`)
        .join("\n"),
      input.routeErrors.length > 0
        ? `\nRecent errors:\n${input.routeErrors
            .map((e) => `- ${e.route}: ${e.message.slice(0, 200)}`)
            .join("\n")}`
        : "",
    ].join("\n");

    const { text } = await generateText({
      model: envoyModel("claude-haiku-4-5-20251001"),
      maxOutputTokens: 150,
      system,
      prompt,
    });

    try {
      const parsed = JSON.parse(text.trim());
      if (typeof parsed?.draft === "string") {
        return parsed.draft.slice(0, 600);
      }
    } catch {
      // Fall through — LLM returned non-JSON, treat as no signal.
    }
    return "";
  } catch (err) {
    console.warn("[feedback.prefill] haiku call failed", err);
    return "";
  }
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ ok: false, error: "Invalid origin" }, { status: 403 });
  }

  let body: { linkCode?: string; sessionId?: string; url?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const session = await getServerSession(authOptions);

  // Host branch: session present, ignore body.linkCode
  if (session?.user?.id) {
    const userId = session.user.id;
    if (rateLimitHit(`host:${userId}`, HOST_RATE_MS)) {
      return NextResponse.json({ ok: true, draft: "" });
    }

    const messages = await prisma.channelMessage.findMany({
      where: { channel: { userId } },
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
      select: { id: true, role: true, content: true, createdAt: true },
    });
    const lastId = messages[0]?.id ?? "none";
    const cacheKey = `host:${userId}:${body.sessionId ?? "none"}:${lastId}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null) {
      return NextResponse.json({ ok: true, draft: cached, cached: true });
    }

    const routeErrors = await prisma.routeError.findMany({
      where: {
        userId,
        createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ROUTE_ERRORS,
      select: { route: true, message: true, createdAt: true },
    });

    const draft = await runHaikuPrefill({
      messages: messages
        .reverse()
        .map((m) => ({
          role: m.role,
          content: stripActionPayloads(m.content ?? ""),
          createdAt: m.createdAt.toISOString(),
        })),
      routeErrors: routeErrors.map((e) => ({
        route: e.route,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      })),
      url: body.url,
    });
    cacheSet(cacheKey, draft);
    return NextResponse.json({ ok: true, draft });
  }

  // Guest branch: linkCode only
  if (!body.linkCode) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const link = await prisma.negotiationLink.findUnique({
    where: { code: body.linkCode },
    select: { id: true, userId: true },
  });
  if (!link) {
    return NextResponse.json({ ok: false, error: "Link not found" }, { status: 404 });
  }
  if (rateLimitHit(`guest:${body.linkCode}`, GUEST_RATE_MS)) {
    return NextResponse.json({ ok: true, draft: "" });
  }

  // Guest messages: channel-only, role-allowlisted, scoped to session if known.
  const where = body.sessionId
    ? { channel: { userId: link.userId }, threadId: body.sessionId }
    : { channel: { userId: link.userId }, threadId: null };
  const messages = await prisma.channelMessage.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
    select: { id: true, role: true, content: true, createdAt: true },
  });
  const filtered = messages.filter((m) => GUEST_VISIBLE_ROLES.has(m.role));
  const lastId = filtered[0]?.id ?? "none";
  const cacheKey = `guest:${body.linkCode}:${body.sessionId ?? "none"}:${lastId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    return NextResponse.json({ ok: true, draft: cached, cached: true });
  }

  const draft = await runHaikuPrefill({
    messages: filtered
      .reverse()
      .map((m) => ({
        role: m.role,
        content: stripActionPayloads(m.content ?? ""),
        createdAt: m.createdAt.toISOString(),
      })),
    routeErrors: [],
    url: body.url,
  });
  cacheSet(cacheKey, draft);
  return NextResponse.json({ ok: true, draft });
}
