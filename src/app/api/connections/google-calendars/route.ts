import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getGoogleCalendarClient } from "@/lib/calendar";

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
  } catch {
    return NextResponse.json({ error: "Failed to fetch calendars" }, { status: 500 });
  }
}
