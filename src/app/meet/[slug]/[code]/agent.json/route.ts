/**
 * GET /meet/<slug>/<code>/agent.json — single-fetch JSON snapshot.
 *
 * Companion to the embedded `<script type="application/agent+json">` block
 * on the contextual meet page. Same data via the same `buildAgentSnapshot`
 * assembler. Cache-Control sends edge caching cross-instance — module-level
 * in-memory caches don't work on Vercel serverless (per the 2026-04-30
 * single-fetch-agent-surface proposal §B1).
 *
 * Query params (all optional, all forwarded to buildAgentSnapshot):
 *   ?limit=N             — max slots returned (1..200, default 20)
 *   ?start=YYYY-MM-DD    — clip slots to date >= start (host TZ)
 *   ?end=YYYY-MM-DD      — clip slots to date <= end (host TZ)
 *
 * Added 2026-05-01 after a friend's Claude noticed the default snapshot
 * only surfaced slots ~5 days out (top-20-best-first clusters in time on
 * a dense calendar). Backward-compatible — callers omitting params get
 * the existing defaults.
 *
 * For bare-vanity primary links (no code), see `[slug]/agent.json/route.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAgentSnapshot, type AgentSnapshotOpts } from "@/lib/agent-snapshot";

export const runtime = "nodejs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseSnapshotOpts(req: NextRequest): AgentSnapshotOpts {
  const opts: AgentSnapshotOpts = {};
  const limitParam = req.nextUrl.searchParams.get("limit");
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 200) {
      opts.limit = n;
    }
  }
  const start = req.nextUrl.searchParams.get("start");
  const end = req.nextUrl.searchParams.get("end");
  if (start && end && ISO_DATE_RE.test(start) && ISO_DATE_RE.test(end)) {
    opts.dateRange = { start, end };
  }
  return opts;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; code: string }> },
): Promise<Response> {
  const { slug, code } = await params;

  const link = await prisma.negotiationLink.findFirst({
    where: { slug, code },
  });
  if (!link) {
    return NextResponse.json(
      { ok: false, error: "link_not_found" },
      { status: 404 },
    );
  }
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { ok: false, error: "link_expired" },
      { status: 410 },
    );
  }

  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { name: true, preferences: true },
  });
  if (!host) {
    return NextResponse.json(
      { ok: false, error: "host_not_found" },
      { status: 404 },
    );
  }

  const snapshot = await buildAgentSnapshot(link, host, parseSnapshotOpts(req));
  return NextResponse.json(snapshot, {
    headers: {
      "content-type": "application/agent+json",
      // Edge-cached cross-instance — works on Vercel where in-memory state
      // doesn't. 15s is short enough that slot staleness stays bounded.
      "cache-control": "public, max-age=15",
    },
  });
}
