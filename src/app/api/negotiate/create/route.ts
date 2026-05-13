import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";
import { parsePreferences } from "@/agent/agent-runner";
import { authenticateRequest } from "@/lib/api-auth";
import { normalizeLinkParameters } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

// POST /api/negotiate/create
// Creates a personalized negotiation link
// Auth: Bearer token OR NextAuth session
export async function POST(req: NextRequest) {
  const userId = await authenticateRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { inviteeEmail, inviteeName, inviteeTimezone, topic, rules, prompt } = body;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { meetSlug: true },
  });

  if (!user?.meetSlug) {
    return NextResponse.json(
      { error: "No meet slug configured" },
      { status: 400 }
    );
  }

  const googleAccount = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { scope: true },
  });
  const calendarConnected = googleAccount?.scope?.includes("calendar") ?? false;
  if (!calendarConnected) {
    return NextResponse.json(
      {
        error: "calendar_not_connected",
        message:
          "sorry- i'm unable to act on this because we first need to connect your calendar.   Click the link below to do this.  It's really quick and safe and easy.",
        connectUrl: "/dashboard/account",
      },
      { status: 409 }
    );
  }

  // If a natural language prompt is provided, parse it into structured rules
  let parsedRules = rules || {};
  if (prompt && !rules) {
    parsedRules = await parsePreferences(prompt);
  }

  const code = generateCode();
  const normalizedRules = normalizeLinkParameters(parsedRules);

  // Host-declared guest TZ. Body wins over prompt-parsed. Validate via Intl —
  // reject invalid zones loudly so a client bug sending "EST" or "PDT" fails
  // on submit rather than silently dropping to null and producing wrong-TZ
  // greetings downstream.
  const rawInviteeTz = inviteeTimezone ?? parsedRules.inviteeTimezone;
  let validatedInviteeTimezone: string | null = null;
  if (rawInviteeTz != null && rawInviteeTz !== "") {
    if (typeof rawInviteeTz !== "string" || rawInviteeTz.length > 64) {
      return NextResponse.json({ error: "Invalid inviteeTimezone" }, { status: 400 });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: rawInviteeTz });
      validatedInviteeTimezone = rawInviteeTz;
    } catch {
      return NextResponse.json({ error: "Invalid IANA inviteeTimezone" }, { status: 400 });
    }
  }

  const link = await prisma.negotiationLink.create({
    data: {
      userId,
      type: "personalized",
      slug: user.meetSlug,
      code,
      inviteeEmail: inviteeEmail || parsedRules.inviteeEmail || null,
      inviteeName: inviteeName || parsedRules.inviteeName || null,
      inviteeTimezone: validatedInviteeTimezone,
      topic: topic || parsedRules.topic || null,
      parameters: normalizedRules as Prisma.InputJsonValue,
    },
  });

  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const primaryUrl = `${baseUrl}/meet/${user.meetSlug}`;
  const personalizedUrl = `${baseUrl}/meet/${user.meetSlug}/${code}`;

  return NextResponse.json({
    link: {
      id: link.id,
      type: "personalized",
      primaryUrl,
      personalizedUrl,
      code,
      inviteeEmail: link.inviteeEmail,
      inviteeName: link.inviteeName,
      inviteeTimezone: link.inviteeTimezone,
      // PR-3 reader-switchover: prefer customTitle; fall back to topic during migration window
      topic: link.customTitle ?? link.topic,
      customTitle: link.customTitle,
      parameters: link.parameters,
    },
  });
}
