/**
 * POST /api/negotiate/message — send a message in a deal-room session.
 *
 * 2026-05-13 retirement: this route previously had a 440-line legacy
 * classifier+composer path gated behind `DEALROOM_UNIFIED_ENABLED`. The
 * flag was the kill switch for the 2026-05-11 unified-agent migration
 * (Phase A.6). With the unified-agent runner deployed for 2+ days, the
 * host-channel sibling running on it for longer, and the legacy composer
 * path actively producing prose-vs-action mismatch bugs (see 2026-05-13
 * LOG entries on the retime_proposed shape, retime/cancel UI drift), the
 * legacy path is retired and the flag deleted.
 *
 * If a kill switch is ever needed again, restore the legacy code from
 * commit history (the last commit before this retirement, on the
 * feat/hardcode-dealroom-unified branch) — but the cleaner play is to
 * fix bugs in `dealroom-runner.ts` + `dealroom-unified.md`, not to fall
 * back to a retired prompt architecture.
 *
 * Adjacent Phase D retirement (separate PR): `app/src/agent/composer.ts`,
 * `app/src/agent/modules/**`, and the retired .md files in
 * `runtime-prompts/composers/` (kept as institutional memory but no
 * production caller — verified at HEAD via this file's deletion).
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, content } = body;

    if (!sessionId || !content) {
      return new Response(
        JSON.stringify({ error: "Missing sessionId or content" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: { id: true, hostId: true },
    });

    if (!session) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Detect if sender is the host.
    const authSession = await getServerSession(authOptions);
    const isHost = authSession?.user?.id === session.hostId;
    const messageRole = isHost ? "host" : "guest";

    // Persist the incoming message before the agent runs (so the agent's
    // recent-history loader picks it up). The deal-room runner reads from
    // the same Message table.
    await prisma.message.create({
      data: { sessionId, role: messageRole, content },
    });

    // Unified-agent deal-room turn (single Sonnet call with tools).
    const { runDealroomTurn } = await import("@/agent/unified/dealroom-runner");
    const stream = runDealroomTurn({
      sessionId,
      speakerRole: messageRole,
      currentMessage: content,
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[negotiate/message] Unhandled error: ${err.message}`, err.stack);
    return new Response(
      JSON.stringify({ error: "Something went wrong", detail: err.message, retryable: true }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
