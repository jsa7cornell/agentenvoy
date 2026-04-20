import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  HOST_READ_SCOPE,
  HOST_WRITE_SCOPE,
  HOST_REQUIRED,
  auditScopes,
} from "@/lib/oauth/required-scopes";

// GET /api/connections/status
// Returns the connection status of all integrations for the current user.
//
// `calendar` stays a coarse "do we have any calendar scope at all?" boolean
// for backwards compat with the existing dashboard-header gate. The new
// `calendarWrite`/`calendarRead`/`missingRequired` fields drive the T3b
// partial-permission UI without requiring the client to know scope strings.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: "google" },
    select: {
      refresh_token: true,
      scope: true,
      expires_at: true,
    },
  });

  const hasRefreshToken = !!account?.refresh_token;
  const scopes = account?.scope?.split(" ") ?? [];
  const hasCalendarScope =
    scopes.includes("https://www.googleapis.com/auth/calendar") ||
    scopes.includes(HOST_WRITE_SCOPE) ||
    scopes.includes(HOST_READ_SCOPE);

  const audit = auditScopes(account?.scope, HOST_REQUIRED);

  return NextResponse.json({
    google: {
      connected: hasRefreshToken,
      calendar: hasRefreshToken && hasCalendarScope,
      calendarWrite: hasRefreshToken && scopes.includes(HOST_WRITE_SCOPE),
      calendarRead: hasRefreshToken && scopes.includes(HOST_READ_SCOPE),
      scopes,
      missingRequired: hasRefreshToken ? audit.missingRequired : [],
    },
  });
}
