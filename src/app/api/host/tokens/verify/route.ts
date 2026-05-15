/**
 * Token verification probe.
 *
 * POST /api/host/tokens/verify
 *   Header: Authorization: Bearer agentenvoy_pat_live_…
 *
 * Returns { ok: true, scopes, displayId } if the token authenticates,
 * { ok: false, reason } otherwise. Used by the Connectors UI right after
 * mint so the user can confirm the token works before pasting it into Claude.
 *
 * Reuses `authorizeHostMcpCall` so the verify result is byte-identical to
 * what the real MCP endpoint will say. No rate-limit decrement here — this
 * is a UI helper, not a call into the MCP surface.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeHostMcpCall } from "@/app/api/mcp/host/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const ctx = await authorizeHostMcpCall(req.headers.get("authorization"));
  if (!ctx.ok) {
    return NextResponse.json({ ok: false, reason: ctx.reason }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    displayId: ctx.displayId,
    scopes: ctx.scopes,
  });
}
