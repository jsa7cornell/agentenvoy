import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";

// GET /api/auth/guest-calendar/callback?code=xxx&state=xxx
// Handles the OAuth callback, reads guest availability, injects into session
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const stateParam = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error || !code || !stateParam) {
    // User denied or something went wrong — redirect back
    const returnUrl = stateParam
      ? JSON.parse(Buffer.from(stateParam, "base64url").toString()).returnUrl
      : "/";
    return NextResponse.redirect(new URL(returnUrl, req.url));
  }

  let state: { sessionId: string; returnUrl: string };
  try {
    state = JSON.parse(Buffer.from(stateParam, "base64url").toString());
  } catch {
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const redirectUri = `${baseUrl}/api/auth/guest-calendar/callback`;

  // Exchange code for access token
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Read guest's freebusy for next 2 weeks
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const now = new Date();
  const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const guestSlots: Array<{ start: string; end: string }> = [];
  try {
    const { data } = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: twoWeeks.toISOString(),
        items: [{ id: "primary" }],
      },
    });

    const busySlots =
      data.calendars?.primary?.busy?.map((b) => ({
        start: new Date(b.start!),
        end: new Date(b.end!),
      })) ?? [];

    // Generate available 30-minute slots during business hours
    const current = new Date(now);
    current.setMinutes(Math.ceil(current.getMinutes() / 30) * 30, 0, 0);

    while (current < twoWeeks && guestSlots.length < 40) {
      const hour = current.getHours();
      const day = current.getDay();

      if (day !== 0 && day !== 6 && hour >= 9 && hour < 18) {
        const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);
        const isBusy = busySlots.some(
          (busy) => current < busy.end && slotEnd > busy.start
        );
        if (!isBusy) {
          guestSlots.push({
            start: current.toISOString(),
            end: slotEnd.toISOString(),
          });
        }
      }
      current.setMinutes(current.getMinutes() + 30);
    }
  } catch (e) {
    console.error("Guest freebusy error:", e);
  }

  // Inject guest availability into the negotiation session as a system message
  if (guestSlots.length > 0) {
    const slotSummary = guestSlots
      .slice(0, 20)
      .map((s) => {
        const d = new Date(s.start);
        return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      })
      .join(", ");

    await prisma.message.create({
      data: {
        sessionId: state.sessionId,
        role: "system",
        content: `[SYSTEM: The guest connected their Google Calendar (read-only). Their available slots over the next 2 weeks: ${slotSummary}. Cross-reference with the host's availability to find mutual times.]`,
      },
    });
  }

  // Redirect back to deal room with a flag
  const returnUrl = new URL(state.returnUrl, baseUrl);
  returnUrl.searchParams.set("calendarConnected", "true");
  return NextResponse.redirect(returnUrl.toString());
}
