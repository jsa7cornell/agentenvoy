import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { ScoredSlot } from "@/lib/scoring";

// GET /api/auth/guest-calendar/callback?code=xxx&state=xxx
// Handles the OAuth callback, reads guest availability, injects into session.
//
// Produces TWO things on a successful read:
//   (1) A system `Message` whose text summarizes the guest's free times for
//       the LLM's context (legacy behavior, preserved).
//   (2) The same message's `metadata.guestSlots` carries a structured
//       ScoredSlot[] — 30-minute free slots with score=1 (bookable, no
//       preference). The slots endpoint picks these up for anonymous guests
//       when computing bilateral chips, letting the existing
//       computeBilateralAvailability() pipeline work identically to the
//       logged-in-guest case. No schema change required.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const stateParam = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error || !code || !stateParam) {
    // User denied or something went wrong — redirect back.
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

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const now = new Date();
  const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // scoredSlots is what we pass into bilateral compute.
  // humanSummary feeds the LLM's conversational context.
  const scoredSlots: ScoredSlot[] = [];
  const humanLabels: string[] = [];

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

    // Walk the window in 30-min steps. Business hours only (9–18 weekday)
    // — same heuristic as the prior impl. Free slots get score=1
    // (bookable, no preference); busy slots are simply omitted, which
    // computeBilateralAvailability treats as "unknown for guest" → no chip.
    // That's the right behavior for a read-only freebusy signal where we
    // can't distinguish "protected" from "blocked."
    const current = new Date(now);
    current.setMinutes(Math.ceil(current.getMinutes() / 30) * 30, 0, 0);

    while (current < twoWeeks && scoredSlots.length < 240) {
      const hour = current.getHours();
      const day = current.getDay();
      if (day !== 0 && day !== 6 && hour >= 9 && hour < 18) {
        const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);
        const isBusy = busySlots.some(
          (busy) => current < busy.end && slotEnd > busy.start,
        );
        if (!isBusy) {
          scoredSlots.push({
            start: current.toISOString(),
            end: slotEnd.toISOString(),
            score: 1,
            kind: "open",
            reason: "guest free (read-only cal)",
            confidence: "high",
          });
          if (humanLabels.length < 20) {
            humanLabels.push(
              `${current.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${current.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
            );
          }
        }
      }
      current.setMinutes(current.getMinutes() + 30);
    }
  } catch (e) {
    console.error("Guest freebusy error:", e);
  }

  // One message carries both surfaces — text for LLM context, metadata for
  // the slots endpoint's bilateral compute.
  if (scoredSlots.length > 0) {
    await prisma.message.create({
      data: {
        sessionId: state.sessionId,
        role: "system",
        content: `[SYSTEM: The guest connected their Google Calendar (read-only). Their available slots over the next 2 weeks include: ${humanLabels.join(", ")}. Cross-reference with the host's availability to find mutual times.]`,
        metadata: {
          kind: "guest_calendar_snapshot",
          scoredSlots,
          source: "google_readonly",
          capturedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Redirect back to deal room with a flag so the client can re-fetch slots
  // and surface bilateral chips.
  const returnUrl = new URL(state.returnUrl, baseUrl);
  returnUrl.searchParams.set("calendarConnected", "true");
  return NextResponse.redirect(returnUrl.toString());
}
