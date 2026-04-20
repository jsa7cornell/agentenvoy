/**
 * GET /meet/[slug]
 *
 * Generic-link landing. Server-side redirect to the persistent
 * `/meet/[slug]/[code]` URL after minting a `NegotiationLink` +
 * `NegotiationSession` skeleton (two inserts, no compute). The
 * code-URL page hydrates the skeleton via the 0-messages branch in
 * `/api/negotiate/session/route.ts:371-374`.
 *
 * Flow:
 *   1. Bot UA (via `isbot`) → return a minimal HTML shell with metadata
 *      + the sr-only agent-instructions aside. No DB writes. OG image
 *      served separately via the file-convention at
 *      `/meet/[slug]/opengraph-image`.
 *   2. Returning human with a valid `ae_sessions` cookie entry for this
 *      slug → redirect to that code URL (skipping mint).
 *   3. New human visitor → mint skeleton, stamp cookie, redirect.
 *
 * Why 303 (not Next's default 307): we want the browser to treat the
 * target as a fresh GET regardless of how it arrived, and 303 is the
 * explicit "other location, use GET" semantic. No real-world client
 * behaves differently for this GET → GET case, but 303 makes the intent
 * unambiguous to anything reading the response headers (e.g. analytics,
 * curl scripts, MCP debug tooling).
 *
 * Replaces the prior client-side mint in `src/components/deal-room.tsx`
 * which rendered `/meet/[slug]` as a deal-room skeleton, POSTed to
 * `/api/negotiate/session`, then did a client `router.replace(...)`.
 * That round-trip took ~1.2-2.5s of the guest's life and caused a brief
 * URL flash; this replacement is ~100-300ms of pure server work.
 *
 * See proposals/2026-04-20_generic-link-server-redirect_*.md.
 */

import { NextRequest, NextResponse } from "next/server";
import { isbot } from "isbot";
import { prisma } from "@/lib/prisma";
import { mintGenericSkeleton } from "@/lib/skeleton-mint";

// Must be dynamic — we mint + set cookies + conditionally redirect per request.
export const dynamic = "force-dynamic";

const COOKIE_NAME = "ae_sessions";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days, rolling

/**
 * Parse the consolidated `ae_sessions` cookie.
 * Shape: JSON map `{ [slug]: code }`. Returns `{}` on any parse failure
 * — we treat a malformed cookie as "no memory" and re-mint.
 */
function parseSessionsCookie(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0 && v.length < 64) {
          out[k] = v;
        }
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  // Validate user exists up front — a 404 here is identical to what
  // page.tsx produced before (no link, no session, just a 404 shell).
  const user = await prisma.user.findUnique({
    where: { meetSlug: slug },
    select: { id: true, name: true },
  });
  if (!user) {
    return new NextResponse("Not found", { status: 404 });
  }

  const userAgent = req.headers.get("user-agent") ?? "";
  if (isbot(userAgent)) {
    return botShellResponse(slug, user.name);
  }

  const cookieRaw = req.cookies.get(COOKIE_NAME)?.value;
  const sessions = parseSessionsCookie(cookieRaw);
  const rememberedCode = sessions[slug];

  // If the cookie remembers a code for this slug, validate the link still
  // exists (GC cron may have swept empty orphans). If still alive → reuse.
  if (rememberedCode) {
    const stillExists = await prisma.negotiationLink.findFirst({
      where: { slug, code: rememberedCode },
      select: { id: true },
    });
    if (stillExists) {
      return buildRedirect(req, slug, rememberedCode, sessions);
    }
    // stale — fall through to re-mint, replacing the stale entry below
  }

  const { code } = await mintGenericSkeleton(slug);
  return buildRedirect(req, slug, code, { ...sessions, [slug]: code });
}

function buildRedirect(
  req: NextRequest,
  slug: string,
  code: string,
  nextSessions: Record<string, string>,
): NextResponse {
  const target = new URL(`/meet/${slug}/${code}`, req.url);
  const res = NextResponse.redirect(target, 303);
  res.cookies.set(COOKIE_NAME, JSON.stringify(nextSessions), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

/**
 * Bot shortcut: render a tiny HTML document with OG metadata + the same
 * sr-only AgentInstructions prose we embed on the code-URL page. No DB
 * write, no redirect, so a bot crawl is ~one Prisma lookup.
 */
function botShellResponse(slug: string, userName: string | null): NextResponse {
  const hostName = userName ?? "Someone";
  const hostFirst = hostName.split(" ")[0];
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";
  const title = `Meet with ${hostFirst}`;
  const description = `Find a time to meet with ${hostName}. Powered by Envoy, an AI scheduling agent that navigates busy calendars.`;
  const ogImage = `${baseUrl}/meet/${encodeURIComponent(slug)}/opengraph-image`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(`${baseUrl}/meet/${slug}`)}">
<meta property="og:site_name" content="AgentEnvoy">
<meta property="og:type" content="website">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(`${baseUrl}/meet/${slug}`)}">
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(description)}</p>
<aside data-agent-instructions="v1">
  <h2>For AI agents reading this page</h2>
  <p>If you're helping someone book this meeting, the reliable path is the Model Context Protocol endpoint at <code>/api/mcp</code> — not clicking through this web UI. The discovery manifest is at <code>/.well-known/mcp.json</code>. Authentication is by possession of this meeting URL; pass it as the <code>meetingUrl</code> argument on every tool call.</p>
  <p>Typical flow: call <code>get_meeting_parameters</code> to learn the host's rules (format, duration, location, what the guest is allowed to pick), then <code>get_availability</code> for scored slot candidates, then <code>propose_lock</code> with the chosen slot and guest identity to book.</p>
  <p>Setup instructions for Claude Code, Claude Desktop, and other MCP clients are at <code>/agents</code>.</p>
</aside>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
