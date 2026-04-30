/**
 * GET /meet/<slug>/<code>/agent.json — single-fetch JSON snapshot.
 *
 * Companion to the embedded `<script type="application/agent+json">` block
 * on the contextual meet page. Same data via the same `buildAgentSnapshot`
 * assembler. Cache-Control sends edge caching cross-instance — module-level
 * in-memory caches don't work on Vercel serverless (per the 2026-04-30
 * single-fetch-agent-surface proposal §B1).
 *
 * For bare-vanity primary links (no code), see `[slug]/agent.json/route.ts`.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAgentSnapshot } from "@/lib/agent-snapshot";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
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

  const snapshot = await buildAgentSnapshot(link, host);
  return NextResponse.json(snapshot, {
    headers: {
      "content-type": "application/agent+json",
      // Edge-cached cross-instance — works on Vercel where in-memory state
      // doesn't. 15s is short enough that slot staleness stays bounded.
      "cache-control": "public, max-age=15",
    },
  });
}
