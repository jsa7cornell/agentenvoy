import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/administrator";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateCode } from "@/lib/utils";
import type { ScoredSlot } from "@/lib/scoring";
import {
  formatAvailabilityWindows,
  humanTimezoneLabel,
  formatLabel,
  alternateFormatsLabel,
} from "@/lib/greeting-template";

// POST /api/negotiate/session
// Start a new negotiation session from a link click
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { slug, code, guestTimezone } = body;

  if (!slug) {
    return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  }

  // Detect if the visitor is the host
  const authSession = await getServerSession(authOptions);

  // Find the user by meetSlug
  const user = await prisma.user.findUnique({
    where: { meetSlug: slug },
    select: { id: true, name: true, email: true, preferences: true, hostDirectives: true, meetSlug: true, persistentKnowledge: true, upcomingSchedulePreferences: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Find the link — contextual (with code) or generic
  let link;
  let reuseSessionId: string | null = null;
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

        // Existing session with 0 messages — reuse it instead of creating a duplicate.
        // Clean up any other empty sessions for this link first.
        await prisma.negotiationSession.deleteMany({
          where: {
            linkId: link.id,
            id: { not: existingSession.id },
            messages: { none: {} },
          },
        });
        // Fall through to generate greeting on this existing session
        // Override the session creation below by using existingSession
        reuseSessionId = existingSession.id;
      }
    }
  } else {
    // Generic link: auto-create a contextual link so the session persists
    const autoCode = generateCode();
    link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        type: "contextual",
        slug: user.meetSlug!,
        code: autoCode,
      },
    });
  }

  const isGroupEvent = link.mode === "group";
  const isHost = authSession?.user?.id === user.id;

  // Create the session (or reuse an existing empty one)
  let session;
  if (reuseSessionId) {
    session = await prisma.negotiationSession.findUnique({
      where: { id: reuseSessionId },
    });
    if (!session) {
      // Shouldn't happen, but fall through to create
      session = await prisma.negotiationSession.create({
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
    }
  } else {
    session = await prisma.negotiationSession.create({
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
  }

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
  let scheduleSlots: ScoredSlot[] = [];
  let hostTimezone = "America/Los_Angeles";
  try {
    const schedule = await getOrComputeSchedule(user.id);
    if (schedule.connected) {
      calendarContext = {
        connected: true,
        events: schedule.events,
        calendars: schedule.calendars,
        timezone: schedule.timezone,
        canWrite: schedule.canWrite,
      };
      scheduleSlots = schedule.slots;
      hostTimezone = schedule.timezone;
    }
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
    guestTimezone: guestTimezone || undefined,
    topic: link.topic || undefined,
    rules: (link.rules as Record<string, unknown>) || {},
    calendarContext,
    hostPersistentKnowledge: user.persistentKnowledge,
    hostUpcomingSchedulePreferences: user.upcomingSchedulePreferences,
    isGroupEvent,
    eventParticipants,
    conversationHistory: [],
  };

  // Human-readable timezone label for the greeting ("Pacific time", not "GMT-7").
  const hostTimezoneLabel = humanTimezoneLabel(hostTimezone);
  const guestTimezoneLabel = guestTimezone ? humanTimezoneLabel(guestTimezone) : null;
  const guestTzDiffers = !!guestTimezone && guestTimezone !== hostTimezone;

  // Resolve effective format/duration — link rules override user preferences.
  const linkRules = (link.rules as Record<string, unknown>) || {};
  const hostPrefs = (user.preferences as { explicit?: Record<string, unknown> } | null) || {};
  const hostExplicit = (hostPrefs.explicit as Record<string, unknown>) || {};
  const effectiveFormat =
    (linkRules.format as string | undefined) ||
    (hostExplicit.format as string | undefined) ||
    session.format ||
    undefined;
  const effectiveDuration =
    (linkRules.duration as number | undefined) ||
    (hostExplicit.duration as number | undefined) ||
    session.duration ||
    undefined;
  const formatIsLocked = Boolean(linkRules.format);

  // Format availability in the HOST's timezone (matches the widget).
  const windows = formatAvailabilityWindows(scheduleSlots, hostTimezone);

  let greeting: string;

  if (isGroupEvent) {
    // Group events use AI-generated greeting for dynamic participant context
    const greetingPrompt = `A new participant just opened the deal room for a group event. Generate your initial greeting following your GREETING STRATEGY and GROUP EVENT COORDINATION instructions. Mention the group context — how many others are involved, who has responded, any emerging time overlaps. Use all context you have — name, topic, format, timing, available slots. Be efficient.`;
    greeting = await generateAgentResponse({
      ...context,
      conversationHistory: [{ role: "user", content: greetingPrompt }],
    });
  } else {
    // Deterministic template greeting — no LLM, no hallucination risk.
    const hostName = user.name || "the organizer";
    const hostFirstName = hostName.split(/\s+/)[0] || hostName;
    const inviteeName = link.inviteeName || null;
    const topic = link.topic || null;

    // 1. Intro — "Hi [name]! I'm coordinating a meeting with {host} [about {topic}]."
    const hello = inviteeName ? `Hi ${inviteeName}!` : "Hi!";
    const introCore = topic
      ? `I'm coordinating a meeting with ${hostName} about ${topic}.`
      : `I'm coordinating a meeting with ${hostName}.`;
    const intro = `${hello} ${introCore}`;

    // 2. Schedule block.
    let scheduleBlock: string;
    if (windows.lines.length > 0) {
      const header = `Here are some times that work (${hostTimezoneLabel}):`;
      const body = windows.lines.join("\n");
      const legend = windows.hasPreferred
        ? `\n\n★ = best fit with ${hostFirstName}'s schedule`
        : "";
      scheduleBlock = `${header}\n\n${body}${legend}`;
    } else {
      scheduleBlock = `I don't have open times to show yet in ${hostTimezoneLabel} — just tell me what generally works and I'll find a match.`;
    }

    // 3. Format/duration sentence — "This would be a 30-minute video call."
    const fmtLabel = formatLabel(effectiveFormat);
    let formatSentence = "";
    if (effectiveDuration && fmtLabel) {
      formatSentence = `This would be a ${effectiveDuration}-minute ${fmtLabel}.`;
    } else if (fmtLabel) {
      formatSentence = `This would be a ${fmtLabel}.`;
    } else if (effectiveDuration) {
      formatSentence = `This would be a ${effectiveDuration}-minute meeting.`;
    }

    // 4. Options sentence — conditional on what's still flexible.
    const options: string[] = ["find another time"];
    if (!formatIsLocked) {
      const alts = alternateFormatsLabel(effectiveFormat);
      if (alts) {
        options.push(`change format (to ${alts})`);
      } else {
        options.push("change format");
      }
    }
    if (guestTzDiffers) {
      options.push("convert the times to your timezone");
    }
    const optionsSentence =
      options.length === 1
        ? `If you'd like, I can ${options[0]}.`
        : options.length === 2
        ? `If you'd like, I can ${options[0]} or ${options[1]}.`
        : `If you'd like, I can ${options.slice(0, -1).join(", ")}, or ${options[options.length - 1]}.`;

    // 5. Closing sentence — ask for whatever's still needed.
    const needed: string[] = [];
    if (!topic) needed.push("the meeting subject");
    if (!inviteeName) needed.push("your name");
    if (!link.inviteeEmail) needed.push("your email");
    let closing: string;
    if (needed.length === 0) {
      closing = "Otherwise, just pick a time and I'll get it booked.";
    } else {
      const joined =
        needed.length === 1
          ? needed[0]
          : needed.length === 2
          ? `${needed[0]} and ${needed[1]}`
          : `${needed.slice(0, -1).join(", ")}, and ${needed[needed.length - 1]}`;
      closing = `Otherwise, just pick a time and let me know ${joined} — I'll get it booked.`;
    }

    // Assemble. Blank lines separate semantic blocks so the greeting skims cleanly.
    const parts: string[] = [intro, scheduleBlock];
    if (formatSentence) parts.push(formatSentence);
    parts.push(optionsSentence);
    parts.push(closing);
    greeting = parts.join("\n\n");
  }

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
    code: link.code || undefined,
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
