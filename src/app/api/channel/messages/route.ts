import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { shortTimezoneLabel } from "@/lib/timezone";

// GET /api/channel/messages
// Returns channel messages with thread snapshots for ThreadCard rendering
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const channel = await prisma.channel.findUnique({
    where: { userId: user.id },
  });
  if (!channel) {
    return NextResponse.json({ messages: [] });
  }

  // Scope to active channel session (or fall back to 3-day window)
  const activeSession = await prisma.channelSession.findFirst({
    where: { channelId: channel.id, closed: false },
    orderBy: { startedAt: "desc" },
  });
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const sessionStart = activeSession?.startedAt
    ? (activeSession.startedAt > threeDaysAgo ? activeSession.startedAt : threeDaysAgo)
    : threeDaysAgo;

  const messages = await prisma.channelMessage.findMany({
    where: { channelId: channel.id, createdAt: { gte: sessionStart } },
    orderBy: { createdAt: "asc" },
    include: {
      thread: {
        select: {
          id: true,
          title: true,
          status: true,
          statusLabel: true,
          type: true,
          meetingType: true,
          duration: true,
          format: true,
          archived: true,
          agreedTime: true,
          meetLink: true,
          createdAt: true,
          updatedAt: true,
          linkId: true,
          guestTimezone: true, // populated on first guest visit (Layer 4)
          link: {
            select: {
              inviteeName: true,
              inviteeEmail: true,
              topic: true,
              code: true,
              slug: true,
              mode: true,
              rules: true, // read by the client to extract priority (Layer 5)
            },
          },
          _count: {
            select: { messages: true },
          },
        },
      },
    },
  });

  // For group links, attach participant data
  const groupLinkIds = new Set<string>();
  for (const msg of messages) {
    if (msg.thread?.link?.mode === "group" && msg.thread.linkId) {
      groupLinkIds.add(msg.thread.linkId);
    }
  }

  const participantsByLink: Record<string, Array<{ name: string | null; status: string; role: string }>> = {};
  if (groupLinkIds.size > 0) {
    const participants = await prisma.sessionParticipant.findMany({
      where: { linkId: { in: Array.from(groupLinkIds) } },
    });
    for (const p of participants) {
      if (!participantsByLink[p.linkId]) participantsByLink[p.linkId] = [];
      participantsByLink[p.linkId].push({
        name: p.name || p.email || null,
        status: p.status,
        role: p.role,
      });
    }
  }

  // Enrich thread data: group info, extracted isVip from rules JSON, and a
  // short human-readable guest TZ label so the ThreadCard doesn't need to
  // parse JSON or import timezone helpers.
  const enrichedMessages = messages.map((msg) => {
    if (!msg.thread) return msg;

    const rules = (msg.thread.link?.rules as Record<string, unknown> | null) || null;
    // Binary isVip flag — anything truthy (including legacy priority strings
    // "high"|"vip") is treated as VIP for backward compat with rows written
    // before this refactor. Anything else is not VIP.
    const rawVip = rules?.isVip;
    const legacyPriority = rules?.priority;
    const isVip =
      rawVip === true ||
      legacyPriority === "high" ||
      legacyPriority === "vip";

    const guestTz = msg.thread.guestTimezone;
    const guestTimezoneLabel = guestTz ? shortTimezoneLabel(guestTz, new Date()) : null;

    const base = {
      ...msg,
      thread: {
        ...msg.thread,
        isVip,
        guestTimezoneLabel,
      },
    };

    if (msg.thread.link?.mode === "group" && msg.thread.linkId) {
      return {
        ...base,
        thread: {
          ...base.thread,
          isGroupEvent: true,
          participants: participantsByLink[msg.thread.linkId] || [],
        },
      };
    }
    return base;
  });

  // Check calendar connection for onboarding UI
  const googleAccount = await prisma.account.findFirst({
    where: { userId: user.id, provider: "google" },
    select: { scope: true },
  });
  const calendarConnected = googleAccount?.scope?.includes("calendar") ?? false;

  return NextResponse.json({
    messages: enrichedMessages,
    lastCalibratedAt: user.lastCalibratedAt,
    calendarConnected,
  });
}
