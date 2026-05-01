/**
 * GET /meet/<slug>/agent.json — bare-vanity snapshot.
 *
 * Mirrors the bare-slug resolution semantics from the 2026-04-19
 * mcp-bare-slug-resolution proposal: when a vanity slug has no
 * `NegotiationLink` row yet, route through `ensureDefaultLinkForUser`
 * to mint-or-fetch the host's primary link.
 *
 * This route file exists as a literal segment so it BEATS the dynamic
 * `[code]` segment in Next.js precedence — without it, `/meet/<slug>/agent.json`
 * would match `/meet/[slug]/[code]/page.tsx` with `code = "agent.json"`
 * and never reach this handler. (Per the proposal §B4 fold.)
 *
 * Note: even though the bare-vanity primary link's HTML page does NOT
 * embed the snapshot (per §B3 — privacy posture), the JSON endpoint IS
 * available for agents that explicitly fetch it. The endpoint is a
 * machine-only surface; passive HTML crawls of `/meet/<slug>` see only
 * the existing meta-tag discovery hints.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureDefaultLinkForUser } from "@/lib/negotiation/default-link";
import { buildAgentSnapshot, type AgentSnapshotOpts } from "@/lib/agent-snapshot";

export const runtime = "nodejs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse optional ?limit=N&start=YYYY-MM-DD&end=YYYY-MM-DD query params.
 * Same shape as the contextual route — kept inline to avoid coupling
 * the two route files; if a third caller appears, lift to a helper.
 */
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
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  const user = await prisma.user.findUnique({
    where: { meetSlug: slug },
    select: { id: true, name: true, preferences: true },
  });
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "link_not_found" },
      { status: 404 },
    );
  }

  // Idempotent — find-or-create the user's default primary link.
  const link = await ensureDefaultLinkForUser(user.id);

  const snapshot = await buildAgentSnapshot(
    link,
    { name: user.name, preferences: user.preferences },
    parseSnapshotOpts(req),
  );
  return NextResponse.json(snapshot, {
    headers: {
      "content-type": "application/agent+json",
      "cache-control": "public, max-age=15",
    },
  });
}
