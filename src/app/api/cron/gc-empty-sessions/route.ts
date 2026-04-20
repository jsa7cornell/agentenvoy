/**
 * GET /api/cron/gc-empty-sessions
 *
 * Garbage-collects skeleton rows that were minted by the generic-link
 * server-side redirect but never hydrated. An empty skeleton = a
 * `NegotiationSession` with 0 `Message` rows AND a parent
 * `NegotiationLink` that has no other non-empty sessions, older than
 * the TTL. A user who clicked `/meet/<host>` but never arrived at the
 * code URL (closed tab, network drop, bot we didn't catch) leaves one
 * of these behind; this cron sweeps them on a rolling basis.
 *
 * Safety rules:
 *   - Only touches rows older than `TTL_MS` (24h). Anything fresher
 *     could still be mid-hydration; do not delete.
 *   - Only touches sessions with 0 messages. Any message at all means a
 *     human reached the deal room and the row is real — leave alone.
 *   - Only touches links whose sessions are ALL empty + old. A link
 *     with even one real session is kept intact.
 *   - Delete is cascade-safe: schema has `onDelete: Cascade` from
 *     `NegotiationSession` → `NegotiationLink` via referential action,
 *     so we can just delete the link and the session row follows, but
 *     we do them separately here for observability in the response.
 *
 * Auth: same pattern as other cron routes — CRON_SECRET via
 * `Authorization: Bearer ...` (Vercel Cron) or `?secret=...` (manual).
 *
 * Scheduled every 6h via `vercel.json`. See proposals/2026-04-20
 * _generic-link-server-redirect_*.md for the design rationale.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logRouteError } from "@/lib/route-error";

// PLAYBOOK Rule 11: cron routes must never be prerendered.
export const dynamic = "force-dynamic";

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const fromHeader = auth?.replace(/^Bearer\s+/i, "");
    const fromQuery = new URL(req.url).searchParams.get("secret");
    if (fromHeader !== secret && fromQuery !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const cutoff = new Date(Date.now() - TTL_MS);

  try {
    // Candidate links: contextual type, older than TTL, with zero
    // non-empty sessions. We look for links where EVERY session has no
    // messages — the Prisma filter below expresses that as "no session
    // with at least one message".
    //
    // We additionally require the link itself to be older than TTL
    // (`createdAt < cutoff`) so we never race the skeleton-mint +
    // code-URL hydration window.
    const staleLinks = await prisma.negotiationLink.findMany({
      where: {
        type: "contextual",
        createdAt: { lt: cutoff },
        // No session on this link has any message
        sessions: { none: { messages: { some: {} } } },
      },
      select: { id: true },
      take: 500, // cap per tick so a bad backlog can't blow out the cron
    });

    if (staleLinks.length === 0) {
      return NextResponse.json({ ok: true, swept: 0 });
    }

    const ids = staleLinks.map((l) => l.id);

    // Delete dependent session rows first, then the links themselves.
    // Keeping it explicit (not relying on cascade) makes the count we
    // return accurate even if schema ever flips cascade semantics.
    const sessionsDeleted = await prisma.negotiationSession.deleteMany({
      where: { linkId: { in: ids } },
    });
    const linksDeleted = await prisma.negotiationLink.deleteMany({
      where: { id: { in: ids } },
    });

    return NextResponse.json({
      ok: true,
      swept: linksDeleted.count,
      sessionsDeleted: sessionsDeleted.count,
      cutoff: cutoff.toISOString(),
    });
  } catch (err) {
    logRouteError({
      route: "/api/cron/gc-empty-sessions",
      method: "GET",
      statusCode: 500,
      error: err,
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
