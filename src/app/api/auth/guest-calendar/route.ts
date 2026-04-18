import { NextRequest, NextResponse } from "next/server";

// GET /api/auth/guest-calendar?sessionId=xxx&returnUrl=/meet/slug/code
// Initiates a read-only Google Calendar OAuth flow for guests
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  const returnUrl = req.nextUrl.searchParams.get("returnUrl") || "/";

  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const redirectUri = `${baseUrl}/api/auth/guest-calendar/callback`;

  const state = Buffer.from(JSON.stringify({ sessionId, returnUrl })).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope:
      "openid email profile https://www.googleapis.com/auth/calendar.readonly",
    access_type: "online", // no refresh token needed — one-time read
    state,
    prompt: "consent",
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
}
