import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/connections/status
// Returns the connection status of all integrations for the current user
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
    scopes.includes("https://www.googleapis.com/auth/calendar.events");

  return NextResponse.json({
    google: {
      connected: hasRefreshToken,
      calendar: hasRefreshToken && hasCalendarScope,
      scopes,
    },
  });
}
