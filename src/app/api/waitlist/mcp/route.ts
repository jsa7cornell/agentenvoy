import { NextResponse } from "next/server";

/**
 * POST /api/waitlist/mcp
 *
 * MCP / developer waitlist signup. Stub implementation — logs to console for now.
 * When a Waitlist table is added to the schema (or we wire Resend for notifications),
 * swap the console.log for a real write.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    // Minimal email validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });
    }

    // TODO: persist to DB or forward to CRM once schema is added.
    console.log(`[waitlist:mcp] signup email=${email} at=${new Date().toISOString()}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[waitlist:mcp] error", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
