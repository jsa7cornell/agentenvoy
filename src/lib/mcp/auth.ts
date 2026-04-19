/**
 * MCP bearer-URL auth + rate-limit gate.
 *
 * The MCP "bearer" is the full meeting URL (`/meet/<slug>` or
 * `/meet/<slug>?c=<code>`). URL-as-capability-token, per SPEC §1 and the
 * parent proposal §2.1. This module is the single choke-point that:
 *
 *   1. Parses the meeting URL into `{slug, code}`.
 *   2. Resolves it to a `NegotiationLink` row (404 / 410 shapes).
 *   3. Applies the per-tool rate limit with the tool's fail-open vs
 *      fail-closed policy (§1.3).
 *
 * No other code path should read `slug`/`code` from an MCP request — route
 * handlers take the resolved `{link, rateLimit}` bundle.
 */
import type { NegotiationLink } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { incrementRateCounter, type RateLimitResult } from "@/lib/mcp/rate-limit";

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export type ParsedMeetingUrl = {
  slug: string;
  code: string | null;
};

export type MeetingUrlParseError =
  | { ok: false; error: "invalid_url" }
  | { ok: false; error: "not_meeting_path" };

/**
 * Parse a meeting URL. Accepts absolute URL or root-relative path.
 * Accepted shapes:
 *   - `/meet/<slug>`
 *   - `/meet/<slug>?c=<code>`
 *   - `https://host/meet/<slug>[?c=<code>]`
 */
export function parseMeetingUrl(
  input: string,
): ({ ok: true } & ParsedMeetingUrl) | MeetingUrlParseError {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "invalid_url" };
  }
  let pathname: string;
  let code: string | null = null;
  try {
    // URL() requires a base for relative paths.
    const u = new URL(input, "https://placeholder.local");
    pathname = u.pathname;
    code = u.searchParams.get("c");
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  const m = pathname.match(/^\/meet\/([A-Za-z0-9_-]+)\/?$/);
  if (!m) return { ok: false, error: "not_meeting_path" };
  return { ok: true, slug: m[1], code };
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

export type ResolveLinkResult =
  | { ok: true; link: NegotiationLink }
  | { ok: false; error: "link_not_found" | "link_expired" };

/** Resolve a parsed meeting URL to a NegotiationLink. */
export async function resolveLink(
  parsed: ParsedMeetingUrl,
): Promise<ResolveLinkResult> {
  const { slug, code } = parsed;
  const link = code
    ? await prisma.negotiationLink.findFirst({ where: { slug, code } })
    : await prisma.negotiationLink.findFirst({ where: { slug, code: null } });
  if (!link) return { ok: false, error: "link_not_found" };
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "link_expired" };
  }
  return { ok: true, link };
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Per-tool rate-limit ceiling + fail policy. SPEC §1.3.
 *
 * The 60-second window matches the SPEC example. Numbers are conservative
 * starting points — tune after observing real traffic. Fail-closed tools
 * return `rate_limit_store_unavailable` with `retryAfterSeconds` when the
 * counter store is down (callers can back off); fail-open tools proceed.
 */
export const MCP_RATE_LIMITS: Record<
  string,
  { limit: number; windowSec: number; failMode: "open" | "closed" }
> = {
  // Read-only — fail-open
  get_meeting_parameters: { limit: 60, windowSec: 60, failMode: "open" },
  get_availability:       { limit: 30, windowSec: 60, failMode: "open" },
  get_session_status:     { limit: 60, windowSec: 60, failMode: "open" },
  // Bounded-write — fail-open (flood bounded by Host Envoy reply loop)
  post_message:           { limit: 20, windowSec: 60, failMode: "open" },
  // Side-effecting writes — fail-closed
  propose_parameters:     { limit: 20, windowSec: 60, failMode: "closed" },
  propose_lock:           { limit: 10, windowSec: 60, failMode: "closed" },
  cancel_meeting:         { limit: 5,  windowSec: 60, failMode: "closed" },
  reschedule_meeting:     { limit: 5,  windowSec: 60, failMode: "closed" },
};

export type RateLimitGateResult =
  | { ok: true; result: RateLimitResult }
  | { ok: false; error: "rate_limit_exceeded"; retryAfterSeconds: number }
  | { ok: false; error: "rate_limit_store_unavailable"; retryAfterSeconds: number }
  | { ok: true; bypassed: true; reason: "store_unavailable_fail_open" };

/**
 * Apply the rate-limit gate for a tool call. The `token` is the meeting URL's
 * capability fragment (slug+code concatenated); it's hashed before DB write.
 */
export async function checkRateLimit(
  tool: string,
  token: string,
): Promise<RateLimitGateResult> {
  const cfg = MCP_RATE_LIMITS[tool];
  if (!cfg) {
    // Unknown tool — fail-closed is the safe default. Caller should have
    // rejected before reaching here.
    return { ok: false, error: "rate_limit_store_unavailable", retryAfterSeconds: 30 };
  }
  try {
    const result = await incrementRateCounter({
      tool,
      token,
      limit: cfg.limit,
      windowSec: cfg.windowSec,
    });
    if (result.exceeded) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.expiresAt.getTime() - Date.now()) / 1000),
      );
      return { ok: false, error: "rate_limit_exceeded", retryAfterSeconds };
    }
    return { ok: true, result };
  } catch {
    // Counter store is down. Fail-open tools proceed; fail-closed refuse.
    // Surfaced to Sentry at the HTTP route boundary (SPEC §1.4) with the
    // fingerprint `["rate_limit_store_down", env]` for global dedup — this
    // module stays pure so it can be unit-tested without Sentry mocks.
    if (cfg.failMode === "open") {
      return { ok: true, bypassed: true, reason: "store_unavailable_fail_open" };
    }
    return { ok: false, error: "rate_limit_store_unavailable", retryAfterSeconds: 30 };
  }
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

export type AuthorizeResult =
  | {
      ok: true;
      link: NegotiationLink;
      parsed: ParsedMeetingUrl;
      rateLimit: Extract<RateLimitGateResult, { ok: true }>;
    }
  | { ok: false; error: string; retryAfterSeconds?: number };

/**
 * One-shot: parse URL → resolve link → rate-limit. Route handlers call this
 * first; everything downstream takes the resolved `link`.
 *
 * The rate-limit token is `slug + (code ?? "")` — scoping to the URL matches
 * SPEC §1's "URL-as-capability-token" framing. Two different links (same
 * slug, different codes) hash to different counters.
 */
export async function authorizeMcpCall(args: {
  meetingUrl: string;
  tool: string;
}): Promise<AuthorizeResult> {
  const parsed = parseMeetingUrl(args.meetingUrl);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const resolved = await resolveLink(parsed);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const token = `${parsed.slug}${parsed.code ?? ""}`;
  const rate = await checkRateLimit(args.tool, token);
  if (!rate.ok) {
    return {
      ok: false,
      error: rate.error,
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }
  return { ok: true, link: resolved.link, parsed, rateLimit: rate };
}
