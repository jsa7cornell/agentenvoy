import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCalendarContext } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/administrator";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// POST /api/negotiate/session
// Start a new negotiation session from a link click
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { slug, code } = body;

  if (!slug) {
    return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  }

  // Detect if the visitor is the host
  const authSession = await getServerSession(authOptions);

  // Find the user by meetSlug
  const user = await prisma.user.findUnique({
    where: { meetSlug: slug },
    select: { id: true, name: true, email: true, preferences: true, hostDirectives: true, meetSlug: true, persistentKnowledge: true, situationalKnowledge: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Find the link — contextual (with code) or generic
  let link;
  if (code) {
    link = await prisma.negotiationLink.findFirst({
      where: { slug, code },
    });
    if (!link) {
      return NextResponse.json({ error: "Link not found" }, { status: 404 });
    }

    const isHost = authSession?.user?.id === user.id;
    const linkPayload = {
      type: link.type,
      topic: link.topic,
      inviteeName: link.inviteeName,
      format: (link.rules as Record<string, unknown>)?.format ?? null,
    };

    // --- GROUP MODE: each visitor gets their own session ---
    if (link.mode === "group") {
      const visitorEmail = authSession?.user?.email || null;
      const visitorUserId = authSession?.user?.id || null;

      // Load all participants for this link
      const participants = await prisma.sessionParticipant.findMany({
        where: { linkId: link.id },
        include: { session: { include: { messages: { orderBy: { createdAt: "asc" } } } } },
      });

      const participantSummary = participants.map((p) => ({
        name: p.name || p.email || "Unknown",
        status: p.status,
        role: p.role,
      }));

      // Find this visitor's existing session
      let myParticipant = null;
      if (isHost) {
        myParticipant = participants.find((p) => p.role === "host");
      } else if (visitorUserId) {
        myParticipant = participants.find((p) => p.userId === visitorUserId && p.role === "guest");
      }
      if (!myParticipant && visitorEmail) {
        myParticipant = participants.find((p) => p.email === visitorEmail && p.role === "guest");
      }

      if (myParticipant) {
        const existingSession = myParticipant.session;

        if (existingSession.archived) {
          return NextResponse.json(
            { error: "archived", hostEmail: user.email || null, hostName: user.name || null },
            { status: 410 }
          );
        }

        if (existingSession.status === "agreed") {
          return NextResponse.json({
            sessionId: existingSession.id,
            status: existingSession.status,
            statusLabel: existingSession.statusLabel,
            confirmed: true,
            agreedTime: existingSession.agreedTime?.toISOString() ?? null,
            agreedFormat: existingSession.agreedFormat,
            duration: existingSession.duration,
            meetLink: existingSession.meetLink,
            messages: existingSession.messages.map((m) => ({
              id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(),
            })),
            host: { name: user.name },
            link: linkPayload,
            isHost,
            isGroupEvent: true,
            participants: participantSummary,
            hostName: user.name,
          });
        }

        if (existingSession.messages.length > 0) {
          return NextResponse.json({
            sessionId: existingSession.id,
            status: existingSession.status,
            statusLabel: existingSession.statusLabel,
            greeting: existingSession.messages[0].content,
            messages: existingSession.messages.map((m) => ({
              id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(),
            })),
            resumed: true,
            host: { name: user.name },
            link: linkPayload,
            isHost,
            isGroupEvent: true,
            participants: participantSummary,
            hostName: user.name,
          });
        }
      }

      // No existing session for this visitor — will fall through to create one below.
      // But first, set group context so the greeting is group-aware.
    } else {
      // --- SINGLE MODE (default): resume existing session ---
      const existingSession = await prisma.negotiationSession.findFirst({
        where: { linkId: link.id },
        orderBy: { createdAt: "desc" },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
        },
      });

      if (existingSession) {
        if (existingSession.archived) {
          return NextResponse.json(
            { error: "archived", hostEmail: user.email || null, hostName: user.name || null },
            { status: 410 }
          );
        }

        if (existingSession.status === "agreed") {
          return NextResponse.json({
            sessionId: existingSession.id,
            status: existingSession.status,
            statusLabel: existingSession.statusLabel,
            confirmed: true,
            agreedTime: existingSession.agreedTime?.toISOString() ?? null,
            agreedFormat: existingSession.agreedFormat,
            duration: existingSession.duration,
            meetLink: existingSession.meetLink,
            messages: existingSession.messages.map((m) => ({
              id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(),
            })),
            host: { name: user.name },
            link: linkPayload,
            isHost,
            hostName: user.name,
          });
        }

        if (existingSession.messages.length > 0) {
          return NextResponse.json({
            sessionId: existingSession.id,
            status: existingSession.status,
            statusLabel: existingSession.statusLabel,
            greeting: existingSession.messages[0].content,
            messages: existingSession.messages.map((m) => ({
              id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(),
            })),
            resumed: true,
            host: { name: user.name },
            link: linkPayload,
            isHost,
            hostName: user.name,
          });
        }
      }
    }
  } else {
    // Find or create the generic link for this user
    link = await prisma.negotiationLink.findFirst({
      where: { userId: user.id, type: "generic" },
    });
    if (!link) {
      link = await prisma.negotiationLink.create({
        data: {
          userId: user.id,
          type: "generic",
          slug: user.meetSlug!,
        },
      });
    }
  }

  const isGroupEvent = link.mode === "group";
  const isHost = authSession?.user?.id === user.id;

  // Create the session
  const session = await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      hostId: user.id,
      type: "calendar",
      status: "active",
      title: link.topic
        ? `${link.topic}${link.inviteeName ? ` — ${link.inviteeName}` : ''}`
        : `Meeting${link.inviteeName ? ` with ${link.inviteeName}` : ''}`,
      statusLabel: `Waiting for ${link.inviteeName || 'invitee'}`,
    },
  });

  // For group links, create a SessionParticipant row
  if (isGroupEvent) {
    const visitorEmail = authSession?.user?.email || null;
    const visitorUserId = authSession?.user?.id || null;
    await prisma.sessionParticipant.create({
      data: {
        linkId: link.id,
        sessionId: session.id,
        userId: visitorUserId,
        email: visitorEmail,
        name: isHost ? user.name : (link.inviteeName || null),
        role: isHost ? "host" : "guest",
        status: "active",
      },
    });
  }

  // Get calendar context for the next 2 weeks
  let calendarContext: CalendarContext | undefined;
  try {
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const tz =
      (user.preferences as Record<string, unknown>)?.timezone as string ??
      ((user.preferences as Record<string, unknown>)?.explicit as Record<string, unknown> | undefined)?.timezone as string ??
      "America/Los_Angeles";
    calendarContext = await getCalendarContext(user.id, now, twoWeeks, tz);
  } catch (e) {
    // Calendar might not be connected — that's ok
    console.log("Could not fetch calendar context:", e);
  }

  // Build group participant context if applicable
  let eventParticipants: Array<{ name: string; status: string }> | undefined;
  if (isGroupEvent) {
    const allParticipants = await prisma.sessionParticipant.findMany({
      where: { linkId: link.id },
    });
    eventParticipants = allParticipants.map((p) => ({
      name: p.name || p.email || "Unknown",
      status: p.status,
    }));
  }

  // Generate the initial greeting
  const context: AgentContext = {
    role: "coordinator",
    hostName: user.name || "the organizer",
    hostPreferences: (user.preferences as Record<string, unknown>) || {},
    hostDirectives: (user.hostDirectives as string[]) || [],
    guestName: link.inviteeName || undefined,
    guestEmail: link.inviteeEmail || undefined,
    topic: link.topic || undefined,
    rules: (link.rules as Record<string, unknown>) || {},
    calendarContext,
    hostPersistentKnowledge: user.persistentKnowledge,
    hostSituationalKnowledge: user.situationalKnowledge,
    isGroupEvent,
    eventParticipants,
    conversationHistory: [],
  };

  // Generate greeting
  const greetingPrompt = isGroupEvent
    ? `A new participant just opened the deal room for a group event. Generate your initial greeting following your GREETING STRATEGY and GROUP EVENT COORDINATION instructions. Mention the group context — how many others are involved, who has responded, any emerging time overlaps. Use all context you have — name, topic, format, timing, available slots. Be efficient.`
    : `A new visitor just opened the deal room. Generate your initial greeting following your GREETING STRATEGY instructions. Use all context you have — name, topic, format, timing, available slots. Propose specific times if you have calendar data and preferences. Be efficient.`;

  const greeting = await generateAgentResponse({
    ...context,
    conversationHistory: [{ role: "user", content: greetingPrompt }],
  });

  // Save the greeting message
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "administrator",
      content: greeting,
    },
  });

  const participantSummary = eventParticipants?.map((p) => ({
    name: p.name,
    status: p.status,
  }));

  return NextResponse.json({
    sessionId: session.id,
    status: session.status,
    statusLabel: session.statusLabel,
    greeting,
    host: {
      name: user.name,
    },
    link: {
      type: link.type,
      topic: link.topic,
      inviteeName: link.inviteeName,
      format: (link.rules as Record<string, unknown>)?.format ?? null,
    },
    isHost,
    isGroupEvent: isGroupEvent || undefined,
    participants: participantSummary,
    hostName: user.name,
  });
}

// GET /api/negotiate/session?id=xxx
// Get session details and messages
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("id");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session id" }, { status: 400 });
  }

  const negotiation = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      link: true,
      host: { select: { id: true, name: true, image: true } },
      messages: { orderBy: { createdAt: "asc" } },
      proposals: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!negotiation) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const authSession = await getServerSession(authOptions);
  const isHost = authSession?.user?.id === negotiation.hostId;

  return NextResponse.json({ session: negotiation, isHost, hostName: negotiation.host.name });
}
