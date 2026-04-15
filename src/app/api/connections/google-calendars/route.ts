import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getGoogleCalendarClient,
  isDeadGoogleAuthError,
  clearGoogleRefreshToken,
} from "@/lib/calendar";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const client = await getGoogleCalendarClient(session.user.id);
    const { data } = await client.calendarList.list();

    const calendars = (data.items ?? []).map((c) => ({
      id: c.id || "primary",
      name: c.summary || c.id || "primary",
      primary: !!c.primary,
      backgroundColor: c.backgroundColor || null,
    }));

    return NextResponse.json({ calendars });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[google-calendars] fetch failed", {
      userId: session.user.id,
      email: session.user.email,
      message,
    });

    // Dead refresh token / revoked consent / missing account: clear the dead
    // token so /api/connections/status flips to "disconnected" on the next
    // read, then signal the frontend to prompt the user to reconnect.
    if (isDeadGoogleAuthError(err)) {
      await clearGoogleRefreshToken(session.user.id);
      return NextResponse.json(
        { error: "reconnect_required", detail: message },
        { status: 401 },
      );
    }

    return NextResponse.json(
      { error: "Failed to fetch calendars", detail: message },
      { status: 500 },
    );
  }
}
