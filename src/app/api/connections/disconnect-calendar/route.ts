import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/connections/disconnect-calendar
// Removes calendar scopes and refresh token from the Google Account.
// User stays logged in — only calendar access is revoked.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: "google" },
  });

  if (!account) {
    return NextResponse.json({ error: "No Google account found" }, { status: 404 });
  }

  // Remove calendar scopes from the scope string
  const currentScopes = account.scope?.split(" ") ?? [];
  const calendarScopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];
  const remainingScopes = currentScopes.filter((s) => !calendarScopes.includes(s));

  await prisma.account.update({
    where: { id: account.id },
    data: {
      scope: remainingScopes.join(" "),
      refresh_token: null,
    },
  });

  return NextResponse.json({ ok: true });
}
