import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/administrator";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateCode } from "@/lib/utils";
import type { ScoredSlot } from "@/lib/scoring";

/**
 * Format the best available slots into readable time windows for the greeting.
 * Groups consecutive 30-min slots into contiguous blocks, then picks the best ones.
 * When urgentSoonest=true, prioritizes the nearest blocks over the biggest.
 */
/**
 * Compact time formatter: "10 AM" not "10:00 AM", "3:30 PM" keeps minutes.
 */
function fmtTimeShort(d: Date, timezone: string): string {
  const raw = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  // "12:00 PM" → "12 PM", "3:30 PM" stays
  return raw.replace(/:00/g, "");
}

/**
 * Compact time range: collapses shared AM/PM.
 * "10 AM–4 PM" stays, "10 AM–11 AM" → "10–11 AM"
 */
function fmtTimeRange(start: Date, end: Date, timezone: string): string {
  const s = fmtTimeShort(start, timezone);
  const e = fmtTimeShort(end, timezone);
  // If both share AM or PM, collapse: "10 AM" + "11 AM" → "10–11 AM"
  const sMatch = s.match(/^(.+)\s(AM|PM)$/);
  const eMatch = e.match(/^(.+)\s(AM|PM)$/);
  if (sMatch && eMatch && sMatch[2] === eMatch[2]) {
    return `${sMatch[1]}–${eMatch[1]} ${sMatch[2]}`;
  }
  return `${s}–${e}`;
}

/**
 * Format the best available slots into readable time windows for the greeting.
 * Groups consecutive 30-min slots into contiguous blocks, then picks the best ones.
 * When urgentSoonest=true, prioritizes the nearest blocks over the biggest.
 */
function formatAvailabilityWindows(
  slots: ScoredSlot[],
  timezone: string,
  urgentSoonest = false
): string | null {
  const now = new Date();
  // Filter to offerable slots in the future (score <= 1: preferred, free, or open)
  const goodSlots = slots
    .filter((s) => {
      const start = new Date(s.start);
      return start > now && s.score <= 1;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  if (goodSlots.length === 0) return null;

  const fmtDay = (d: Date) =>
    d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timezone });

  // Build contiguous blocks of consecutive 30-min slots on the same day.
  // Track whether a block contains any preferred slots (score <= 0).
  interface Block {
    start: Date; end: Date; dayLabel: string; count: number;
    hasPreferred: boolean;
  }
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const slot of goodSlots) {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const dayLabel = fmtDay(start);
    const isPreferred = slot.score <= 0;

    if (current && current.dayLabel === dayLabel && start.getTime() === current.end.getTime()) {
      current.end = end;
      current.count++;
      if (isPreferred) current.hasPreferred = true;
    } else {
      if (current) blocks.push(current);
      current = { start, end, dayLabel, count: 1, hasPreferred: isPreferred };
    }
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) return null;

  // Prioritize: preferred blocks first, then by soonest (urgent) or biggest (normal)
  let picked: Block[];
  const preferred = blocks.filter((b) => b.hasPreferred);
  const regular = blocks.filter((b) => !b.hasPreferred);

  if (urgentSoonest) {
    // Soonest preferred first, then soonest regular, cap at 3
    picked = [...preferred, ...regular].slice(0, 3);
  } else {
    // Preferred first (biggest), then regular (biggest), cap at 3, re-sort chronologically
    const sortedPref = preferred.sort((a, b) => b.count - a.count);
    const sortedReg = regular.sort((a, b) => b.count - a.count);
    picked = [...sortedPref, ...sortedReg]
      .slice(0, 3)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  const lines = picked.map((b) => {
    const timeStr = b.count === 1
      ? `${b.dayLabel}, ${fmtTimeShort(b.start, timezone)}`
      : `${b.dayLabel}, ${fmtTimeRange(b.start, b.end, timezone)}`;
    return b.hasPreferred ? `${timeStr} ★` : timeStr;
  });

  return lines.map((l) => `  • ${l}`).join("\n");
}

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

  // Timezone labels for greeting
  const hostTzAbbr = new Intl.DateTimeFormat("en-US", { timeZone: hostTimezone, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value || hostTimezone;

  const guestTzAbbr = guestTimezone
    ? new Intl.DateTimeFormat("en-US", { timeZone: guestTimezone, timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value || null
    : null;

  // Read format/duration/urgency from link rules (primary) or session (legacy fallback)
  const linkRules = (link.rules as Record<string, unknown>) || {};
  const effectiveFormat = (linkRules.format as string) || session.format || undefined;
  const effectiveDuration = (linkRules.duration as number) || session.duration || undefined;
  const effectiveUrgency = (linkRules.urgency as string) || undefined;

  // Always format availability in the HOST's timezone (matches the widget)
  const availabilityWindows = formatAvailabilityWindows(
    scheduleSlots,
    hostTimezone,
    effectiveUrgency === "asap"
  );

  let greeting: string;

  if (isGroupEvent) {
    // Group events use AI-generated greeting for dynamic participant context
    const greetingPrompt = `A new participant just opened the deal room for a group event. Generate your initial greeting following your GREETING STRATEGY and GROUP EVENT COORDINATION instructions. Mention the group context — how many others are involved, who has responded, any emerging time overlaps. Use all context you have — name, topic, format, timing, available slots. Be efficient.`;
    greeting = await generateAgentResponse({
      ...context,
      conversationHistory: [{ role: "user", content: greetingPrompt }],
    });
  } else {
    // Deterministic template greeting — no LLM, no hallucination risk
    const hostName = user.name || "the organizer";
    const guestName = link.inviteeName || null;

    // 1. Intro
    const intro = guestName
      ? `Hi ${guestName}! I'm coordinating a time for you and ${hostName}.`
      : `Hi! I'm coordinating a meeting with ${hostName}.`;

    // 2. Format/duration — state as fact if known, ask if not
    let formatLine: string;
    const fmtLabel = effectiveFormat === "phone" ? "phone call" : effectiveFormat === "video" ? "video call" : effectiveFormat === "in-person" ? "in-person meeting" : effectiveFormat;
    if (effectiveFormat && effectiveDuration) {
      formatLine = ` This is a ${effectiveDuration}-minute ${fmtLabel}.`;
    } else if (effectiveFormat) {
      formatLine = ` This is a ${fmtLabel}.`;
    } else if (effectiveDuration) {
      formatLine = ` This is a ${effectiveDuration}-minute meeting.`;
    } else {
      formatLine = " We can do phone, video, or in-person — let me know your preference.";
    }

    // 3. Topic — only if set
    const topicLine = link.topic ? ` Re: ${link.topic}.` : "";

    // 4. Urgency
    const urgencyLine = effectiveUrgency === "asap"
      ? " Looking to get this scheduled as soon as possible."
      : "";

    // 5. Timezone sentence (standalone, before times)
    const guestTzDiffers = guestTzAbbr && guestTzAbbr !== hostTzAbbr;
    let tzSentence: string;
    if (guestTzDiffers) {
      tzSentence = `Times below are in ${hostTzAbbr}.`;
    } else if (guestTzAbbr) {
      tzSentence = `Times below are in ${hostTzAbbr}.`;
    } else {
      tzSentence = `Times below are in ${hostTzAbbr}. What timezone are you in?`;
    }

    // 6. Schedule — availability with tz label
    let scheduleLine: string;
    const hasPreferredSlots = availabilityWindows?.includes("★") ?? false;
    if (availabilityWindows) {
      scheduleLine = `Here are some times that work (${hostTzAbbr}):\n${availabilityWindows}`;
      if (hasPreferredSlots) {
        scheduleLine += `\n  (★ = best for ${hostName})`;
      }
      scheduleLine += `\n\nIf none of these work, just tell me what does and I'll find a match.`;
    } else {
      scheduleLine = "Let me know what times generally work for you and I'll find the best fit.";
    }

    // 7. What we still need
    const needItems: string[] = [];
    if (!guestName) needItems.push("your name");
    if (!link.inviteeEmail) needItems.push("your email");
    const needLine = needItems.length > 0
      ? `\n\nJust need ${needItems.join(" and ")} to send the invite once we lock in a time.`
      : "\n\nJust need your email to send the invite once we lock in a time.";

    // 8. Timezone switch offer (only when guest is in a different tz)
    const tzOffer = guestTzDiffers
      ? `\n\nI notice you might be in ${guestTzAbbr}. Want me to show times in your timezone instead?`
      : "";

    // Assemble: intro + format + topic + urgency → tz sentence → times → fallback → tz offer → need
    greeting = `${intro}${formatLine}${topicLine}${urgencyLine}\n\n${tzSentence}\n\n${scheduleLine}${tzOffer}${needLine}`;
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
