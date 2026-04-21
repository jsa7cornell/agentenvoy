/**
 * PUT /api/account/privacy — user toggles their own debugConsent (F4).
 *
 * Auth: NextAuth session. CSRF: same-origin only. Only the authenticated
 * user can change their own flag — no admin override via this route.
 * Admins have their own path (not shipped here); this endpoint is the
 * user's self-service control surface.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { setDebugConsent, getDebugConsent } from "@/lib/debug-consent";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  debugConsent: z.boolean(),
});

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

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const state = await getDebugConsent(session.user.id);
  return NextResponse.json({
    ok: true,
    debugConsent: state.granted,
    debugConsentAt: state.grantedAt?.toISOString() ?? null,
    debugConsentRevokedAt: state.revokedAt?.toISOString() ?? null,
  });
}

export async function PUT(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ ok: false, error: "Invalid origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid submission", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const next = await setDebugConsent({
      userId: session.user.id,
      granted: parsed.data.debugConsent,
    });
    return NextResponse.json({
      ok: true,
      debugConsent: next.granted,
      debugConsentAt: next.grantedAt?.toISOString() ?? null,
      debugConsentRevokedAt: next.revokedAt?.toISOString() ?? null,
    });
  } catch (err) {
    console.error("[account.privacy] update failed", { userId: session.user.id, err });
    return NextResponse.json(
      { ok: false, error: "Could not update privacy setting" },
      { status: 500 },
    );
  }
}
