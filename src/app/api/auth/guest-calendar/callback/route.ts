import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { dispatchGuestFlowWelcomeEmailOnce } from "@/lib/emails/guest-flow-welcome";
import { logCalibrationWrite } from "@/lib/calibration-audit";
import { GUEST_REQUIRED, auditScopes } from "@/lib/oauth/required-scopes";
import {
  filterGuestEvents,
  type GuestSnapshotEvent,
  type GuestSnapshotBusy,
} from "@/lib/guest-snapshot";

// GET /api/auth/guest-calendar/callback?code=xxx&state=xxx
//
// Handles the OAuth callback for the guest-calendar CTA. Does three things:
//
//   (1) Upserts a NextAuth User + Account and sets a session cookie so the
//       guest is treated as signed in for the rest of the deal-room flow
//       (header updates, they get a meetSlug, etc.). We intentionally skip
//       the dashboard onboarding flow — they're mid-scheduling — and mark
//       the account with `preferences.explicit.signupSource = "guest_flow"`
//       so confirm/route.ts can send a "finish your setup" nudge after the
//       meeting is locked in.
//
//   (2) Writes a system Message with guest freebusy slots as metadata, so
//       the bilateral-compute pipeline can surface mutual windows for the
//       anonymous guest flow (preserved for backward compatibility — still
//       works even if the user was already signed in).
//
//   (3) Redirects back to the deal room with ?calendarConnected=true.
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

  // Look up the guest's identity from the id_token or userinfo endpoint.
  // We need email + sub for User/Account upsert.
  let guestEmail: string | null = null;
  let guestName: string | null = null;
  let guestImage: string | null = null;
  let googleSub: string | null = null;

  try {
    if (tokens.id_token) {
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      guestEmail = payload?.email ?? null;
      guestName = payload?.name ?? null;
      guestImage = payload?.picture ?? null;
      googleSub = payload?.sub ?? null;
    } else if (tokens.access_token) {
      // Fallback: call userinfo endpoint directly.
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (res.ok) {
        const info = await res.json();
        guestEmail = info.email ?? null;
        guestName = info.name ?? null;
        guestImage = info.picture ?? null;
        googleSub = info.sub ?? null;
      }
    }
  } catch (e) {
    console.error("[guest-calendar] identity resolve failed:", e);
  }

  // If we got a real identity, upsert the NextAuth user + account and mint
  // a session cookie. If not (shouldn't happen — we requested openid), fall
  // through to the legacy anonymous-slots-only path.
  let sessionCookieToSet: { name: string; value: string; expires: Date } | null = null;
  let signedInUserId: string | null = null;

  if (guestEmail && googleSub) {
    try {
      // Upsert User by email. New users get a meetSlug + seeded timezone +
      // `signupSource = "guest_flow"` so confirm/route can tell them apart
      // from fully-onboarded users for the post-confirm nudge.
      let user = await prisma.user.findUnique({ where: { email: guestEmail } });
      const isNewUser = !user;
      if (!user) {
        // Generate a unique meetSlug.
        const base = guestName
          ? guestName.toLowerCase().replace(/[^a-z0-9]/g, "")
          : guestEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
        let slug = base || "user";
        let counter = 1;
        while (await prisma.user.findUnique({ where: { meetSlug: slug } })) {
          slug = `${base}${counter}`;
          counter++;
        }
        const preferences: Record<string, unknown> = {
          explicit: { signupSource: "guest_flow" },
        };
        const calibratedAt = new Date();
        user = await prisma.user.create({
          data: {
            email: guestEmail,
            name: guestName,
            image: guestImage,
            meetSlug: slug,
            preferences: preferences as Prisma.InputJsonValue,
            // Skip onboarding: the user is mid-booking. We'll nudge them
            // post-confirm via email + deal-room thread.
            lastCalibratedAt: calibratedAt,
          },
        });
        logCalibrationWrite({ userId: user.id, value: calibratedAt, source: "guest-calendar-link" });
      }
      signedInUserId = user.id;

      // Upsert Account for (google, googleSub).
      const existingAccount = await prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId: googleSub,
          },
        },
      });
      if (existingAccount) {
        await prisma.account.update({
          where: { id: existingAccount.id },
          data: {
            access_token: tokens.access_token ?? undefined,
            refresh_token: tokens.refresh_token ?? existingAccount.refresh_token,
            expires_at: tokens.expiry_date
              ? Math.floor(tokens.expiry_date / 1000)
              : undefined,
            scope: tokens.scope ?? undefined,
            id_token: tokens.id_token ?? undefined,
            token_type: tokens.token_type ?? undefined,
          },
        });
      } else {
        await prisma.account.create({
          data: {
            userId: user.id,
            type: "oauth",
            provider: "google",
            providerAccountId: googleSub,
            access_token: tokens.access_token ?? null,
            refresh_token: tokens.refresh_token ?? null,
            expires_at: tokens.expiry_date
              ? Math.floor(tokens.expiry_date / 1000)
              : null,
            scope: tokens.scope ?? null,
            id_token: tokens.id_token ?? null,
            token_type: tokens.token_type ?? null,
          },
        });
      }

      // Mint a NextAuth database session. Token is a random cuid-ish string;
      // the adapter only cares that it's unique.
      const sessionToken = randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await prisma.session.create({
        data: {
          sessionToken,
          userId: user.id,
          expires,
        },
      });

      // Match NextAuth's default cookie naming: `__Secure-` prefix when the
      // deployment uses HTTPS (production), plain otherwise (local dev).
      const useSecureCookies = baseUrl.startsWith("https://");
      const cookieName = useSecureCookies
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token";
      sessionCookieToSet = { name: cookieName, value: sessionToken, expires };

      if (isNewUser) {
        console.log(
          `[guest-calendar] created new user ${user.id} (${guestEmail}) via guest_flow`
        );
        // Fire-and-forget welcome email. The dispatch is idempotent via
        // SideEffectLog (PLAYBOOK Rule 13), so repeat OAuth returns don't
        // re-email. Look up the triggering host name so the email can say
        // "while connecting your calendar to schedule with Mike...".
        try {
          const sessionRow = await prisma.negotiationSession.findUnique({
            where: { id: state.sessionId },
            select: { host: { select: { name: true } } },
          });
          await dispatchGuestFlowWelcomeEmailOnce(user.id, {
            triggeringHostName: sessionRow?.host?.name ?? null,
          });
        } catch (e) {
          console.error("[guest-calendar] welcome email dispatch failed:", e);
          // Non-blocking — account already exists, session cookie is set.
        }
      }
    } catch (e) {
      console.error("[guest-calendar] user/account/session upsert failed:", e);
      // Fall through — the slots part still works anonymously.
    }
  }

  // === Scope audit ===
  // If the guest unticked calendar.readonly on Google's consent screen, we
  // can't run freebusy at all — surface a denied banner in the deal room
  // instead of falsely claiming we connected.
  const scopeAudit = auditScopes(tokens.scope, GUEST_REQUIRED);
  const calendarReadDenied = !scopeAudit.satisfied;

  // === Guest events.list → bilateral snapshot ===
  //
  // Upgraded from `freebusy.query()` per 2026-04-29 bilateral+picker bundle
  // PR-A1. The richer payload carries event titles + visibility +
  // transparency, which lets the picker's Detailed tab name conflicts
  // ("Standup" instead of dim grey block). Privacy filtering happens
  // deterministically in `filterGuestEvents` (visibility=private strips
  // titles, transparency=transparent drops, declined attendance drops,
  // cancelled drops).
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const now = new Date();
  const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  let snapshotEvents: GuestSnapshotEvent[] = [];
  let snapshotBusy: GuestSnapshotBusy[] = [];
  const humanLabels: string[] = [];
  let fetchFailed = false;

  try {
    if (calendarReadDenied) {
      throw new Error("calendar.readonly scope not granted");
    }
    const { data } = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: twoWeeks.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      orderBy: "startTime",
    });

    const filtered = filterGuestEvents(data.items ?? []);
    snapshotEvents = filtered.events;
    snapshotBusy = filtered.busy;

    // Build a short prose summary of the guest's first ~20 free half-hour
    // labels for the [SYSTEM:...] message body. The bilateral compute path
    // doesn't need this (it walks `busy` directly), but the message body
    // is also surfaced verbatim in feedback bundles when debugging snapshot
    // shape — keep it readable.
    const cursor = new Date(now);
    cursor.setMinutes(Math.ceil(cursor.getMinutes() / 30) * 30, 0, 0);
    while (cursor < twoWeeks && humanLabels.length < 20) {
      const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
      const isBusy = snapshotBusy.some(
        (b) =>
          cursor < new Date(b.end) && slotEnd > new Date(b.start),
      );
      if (!isBusy) {
        humanLabels.push(
          `${cursor.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${cursor.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
        );
      }
      cursor.setMinutes(cursor.getMinutes() + 30);
    }
  } catch (e) {
    fetchFailed = true;
    console.error("Guest events.list error:", e);
  }

  const denied = calendarReadDenied || fetchFailed;

  // Persist the snapshot. Shape per PR-A1:
  //   { kind, busy[], events[], source, capturedAt, [guestUserId] }
  // Note: `scoredSlots` is intentionally absent — Decision 1(c) of the
  // bilateral+picker bundle removed it. The single legacy reader at
  // `negotiate/slots/route.ts` is migrated to read this shape via
  // `computeBilateralForSession` in the same atomic PR.
  if (snapshotBusy.length > 0 || snapshotEvents.length > 0) {
    await prisma.message.create({
      data: {
        sessionId: state.sessionId,
        role: "system",
        content: `[SYSTEM: The guest connected their Google Calendar (read-only). Their available slots over the next 2 weeks include: ${humanLabels.join(", ")}. Cross-reference with the host's availability to find mutual times.]`,
        metadata: {
          kind: "guest_calendar_snapshot",
          busy: snapshotBusy,
          events: snapshotEvents,
          source: "google_readonly",
          capturedAt: new Date().toISOString(),
          ...(signedInUserId ? { guestUserId: signedInUserId } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Link the signed-in user to this session as the guest, so the deal room
  // shows their identity and future visits resume the same thread.
  if (signedInUserId) {
    try {
      await prisma.negotiationSession.update({
        where: { id: state.sessionId },
        data: { guestId: signedInUserId },
      });
    } catch (e) {
      console.error("[guest-calendar] link guestId to session failed:", e);
    }
  }

  // Redirect back to deal room with a flag so the client can re-fetch slots
  // and surface bilateral chips. `denied` triggers the partial-permission
  // banner — manual time-pick still works.
  const returnUrl = new URL(state.returnUrl, baseUrl);
  returnUrl.searchParams.set("calendarConnected", denied ? "denied" : "true");
  const response = NextResponse.redirect(returnUrl.toString());

  // Set the NextAuth session cookie so the header reflects signed-in state
  // without requiring the user to sign in again.
  if (sessionCookieToSet) {
    response.cookies.set({
      name: sessionCookieToSet.name,
      value: sessionCookieToSet.value,
      expires: sessionCookieToSet.expires,
      httpOnly: true,
      sameSite: "lax",
      secure: baseUrl.startsWith("https://"),
      path: "/",
    });
  }

  return response;
}
