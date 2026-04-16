import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/administrator";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateCode } from "@/lib/utils";
import type { ScoredSlot, LinkRules } from "@/lib/scoring";
import { applyEventOverrides } from "@/lib/scoring";
import { compileOfficeHoursLinks, type AvailabilityRule } from "@/lib/availability-rules";
import { applyOfficeHoursWindow } from "@/lib/office-hours";
import type { Prisma } from "@prisma/client";
import {
  formatAvailabilityWindows,
  humanTimezoneLabel,
  formatLabel,
} from "@/lib/greeting-template";

const GENERIC_TOPICS = new Set([
  "meeting", "catch up", "catch-up", "catchup", "chat", "sync",
  "check in", "check-in", "checkin", "connect", "touch base",
  "quick chat", "quick meeting", "quick sync", "discussion",
  "call", "quick call", "phone call", "video call",
]);
function isGenericTopic(topic: string): boolean {
  return GENERIC_TOPICS.has(topic.trim().toLowerCase());
}

function buildSessionTitle(
  topic: string | null,
  inviteeName: string | null,
  hostFirstName: string,
): string {
  if (topic && !isGenericTopic(topic)) {
    return `${topic}${inviteeName ? ` — ${inviteeName}` : ""}`;
  }
  if (inviteeName) return `${hostFirstName} + ${inviteeName}`;
  return `Meeting — ${hostFirstName}`;
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

  // Office-hours detection: if a code is provided and matches an active
  // office_hours rule on this user, spawn a fresh child link + session for
  // this visitor. Each visit creates a new session (generic-link semantics).
  // Runs BEFORE the standard NegotiationLink lookup so office-hours codes
  // don't collide with contextual link codes.
  let officeHoursRule: AvailabilityRule | null = null;
  if (code) {
    const prefsRaw = (user.preferences as Record<string, unknown>) || {};
    const explicit = (prefsRaw.explicit as Record<string, unknown>) || {};
    const rules = (explicit.structuredRules as AvailabilityRule[] | undefined) || [];
    const match = rules.find(
      (r) => r.action === "office_hours" && r.officeHours?.linkCode === code,
    );
    if (match) {
      const today = new Date().toISOString().slice(0, 10);
      const isExpired =
        match.status === "expired" ||
        (match.expiryDate && match.expiryDate < today);
      const isPaused = match.status === "paused";
      if (match.status !== "active" || isExpired || isPaused) {
        // Paused or expired — surface the same "unavailable" copy as archived sessions.
        return NextResponse.json(
          { error: "archived", hostEmail: user.email || null, hostName: user.name || null },
          { status: 410 },
        );
      }
      officeHoursRule = match;
    }
  }

  // Find the link — contextual (with code) or generic
  let link;
  let reuseSessionId: string | null = null;
  if (officeHoursRule) {
    // Spawn a fresh child link for this visitor, keyed back to the rule via
    // sourceRuleId. Generic-link semantics: each visit creates a new link +
    // session, and the guest resumes via the sessionId URL, not the rule's
    // public /meet/{slug}/{code}.
    const oh = officeHoursRule.officeHours!;
    const childCode = generateCode();
    link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        type: "contextual",
        slug: user.meetSlug!,
        code: childCode,
        topic: oh.title,
        sourceRuleId: officeHoursRule.id,
        rules: {
          format: oh.format,
          duration: oh.durationMinutes,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  } else if (code) {
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

        if (existingSession.archived || existingSession.status === "expired") {
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
        if (existingSession.archived || existingSession.status === "expired") {
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

  // Create the session (or reuse an existing empty one).
  // guestTimezone (from browser) is persisted on first write and never
  // overwritten on subsequent visits — so the host stays honest to the
  // first-observed guest location even across re-visits from different
  // devices. The column is nullable and defaults to null.
  let session;
  if (reuseSessionId) {
    session = await prisma.negotiationSession.findUnique({
      where: { id: reuseSessionId },
    });
    // First-write-wins: if the existing row has no guestTimezone and the
    // current request provided one, backfill it now.
    if (session && !session.guestTimezone && guestTimezone) {
      session = await prisma.negotiationSession.update({
        where: { id: session.id },
        data: { guestTimezone },
      });
    }
    if (!session) {
      // Shouldn't happen, but fall through to create
      const hostFirstName = (user.name || "Host").split(/\s+/)[0];
      const lr = (link.rules as Record<string, unknown>) || {};
      session = await prisma.negotiationSession.create({
        data: {
          linkId: link.id,
          hostId: user.id,
          type: "calendar",
          status: "active",
          title: buildSessionTitle(link.topic, link.inviteeName, hostFirstName),
          statusLabel: `Waiting for ${link.inviteeName || 'invitee'}`,
          guestTimezone: guestTimezone || null,
          duration: (lr.duration as number) || 30,
          format: (lr.format as string) || null,
        },
      });
    }
  } else {
    const hostFirstName = (user.name || "Host").split(/\s+/)[0];
    const lr = (link.rules as Record<string, unknown>) || {};
    session = await prisma.negotiationSession.create({
      data: {
        linkId: link.id,
        hostId: user.id,
        type: "calendar",
        status: "active",
        title: buildSessionTitle(link.topic, link.inviteeName, hostFirstName),
        statusLabel: `Waiting for ${link.inviteeName || 'invitee'}`,
        guestTimezone: guestTimezone || null,
        duration: (lr.duration as number) || 30,
        format: (lr.format as string) || null,
      },
    });
  }

  console.log(`[negotiate/session] created | session=${session.id} | duration=${session.duration} | format=${session.format} | topic=${link.topic || "none"}`);

  // Effective guest timezone used for downstream formatting. Prefer the
  // persisted value (first-observed) over what the current request provided
  // — they're usually the same, but a re-visit from a different browser
  // shouldn't flip the greeting's timezone mid-conversation.
  const effectiveGuestTz = session.guestTimezone || guestTimezone || undefined;

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
    guestTimezone: effectiveGuestTz,
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
  const guestTzDiffers = !!effectiveGuestTz && effectiveGuestTz !== hostTimezone;
  const guestTimezoneLabel = guestTzDiffers ? humanTimezoneLabel(effectiveGuestTz!) : null;

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
  const effectiveMinDuration =
    (linkRules.minDuration as number | undefined) || undefined;
  // Apply link-level rules (preferredDays, dateRange, lastResort, slot overrides)
  // BEFORE formatting so the greeting shows the same set of times the LLM will
  // see in `formatOfferableSlots` on follow-up turns. Without this, the greeting
  // and the LLM disagree about availability and the agent contradicts itself.
  let filteredSlots = applyEventOverrides(
    scheduleSlots,
    linkRules as LinkRules,
    hostTimezone
  );

  // Office-hours transform for the initial greeting. Uses the rule the session
  // was spawned from (if any), so the greeting shows the same set of times the
  // slots endpoint will later return for the widget.
  if (officeHoursRule) {
    const compiledLinks = compileOfficeHoursLinks([officeHoursRule]);
    const compiled = compiledLinks[0];
    if (compiled) {
      const siblings = await prisma.negotiationSession.findMany({
        where: {
          status: "agreed",
          agreedTime: { not: null },
          link: { sourceRuleId: officeHoursRule.id },
          id: { not: session.id },
        },
        select: { agreedTime: true, duration: true },
      });
      const confirmedBookings = siblings
        .filter((s) => s.agreedTime)
        .map((s) => ({
          start: s.agreedTime!.toISOString(),
          end: new Date(s.agreedTime!.getTime() + (s.duration || compiled.durationMinutes) * 60 * 1000).toISOString(),
        }));
      filteredSlots = applyOfficeHoursWindow({
        rule: compiled,
        slots: filteredSlots,
        timezone: hostTimezone,
        confirmedBookings,
      });
    }
  }

  // Format availability. When the guest is in a different timezone, the
  // template shows times primary in guest-local with host-local in parens,
  // and groups by guest-local day — the guest should never have to translate.
  const windows = formatAvailabilityWindows(
    filteredSlots,
    hostTimezone,
    new Date(),
    guestTzDiffers ? effectiveGuestTz : undefined,
    effectiveDuration ?? undefined,
    effectiveMinDuration
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
    // Deterministic template greeting — no LLM, no hallucination risk.
    const hostName = user.name || "the organizer";
    const hostFirstName = hostName.split(/\s+/)[0] || hostName;
    const inviteeName = link.inviteeName || null;
    const rawTopic = link.topic || null;
    const topic = rawTopic && isGenericTopic(rawTopic) ? null : rawTopic;

    // 1. Intro — short and warm, no "about {topic}" (topic lives in the
    //    session title and closing, not the greeting body).
    const hello = inviteeName ? `👋 Hi ${inviteeName}!` : "👋 Hi there!";
    const intro = `${hello} I'm coordinating a meeting with ${hostFirstName}.`;

    // 2. Schedule block — compact time windows with optional dual timezone.
    const fmtLabel = formatLabel(effectiveFormat);
    const durationLabel = (effectiveMinDuration && effectiveMinDuration < (effectiveDuration ?? 30))
      ? `${effectiveMinDuration}–${effectiveDuration}`
      : effectiveDuration
      ? `${effectiveDuration}`
      : null;
    // Inline format/duration tag: "📅 45-min phone call" or "📅 30-min meeting"
    const meetingDesc = durationLabel && fmtLabel
      ? `${durationLabel}-min ${fmtLabel}`
      : fmtLabel
      ? fmtLabel
      : durationLabel
      ? `${durationLabel}-min meeting`
      : null;

    let scheduleBlock: string;
    if (windows.lines.length > 0) {
      const header = guestTzDiffers
        ? `Here are some times that work (${guestTimezoneLabel}, ${hostFirstName}'s time in parens):`
        : `Here are some times that work (${hostTimezoneLabel}):`;
      const body = windows.lines.join("\n");
      const legend = windows.hasPreferred
        ? `\n★ = best fit with ${hostFirstName}'s schedule`
        : "";
      const moreNote = windows.wasTruncated ? "  ·  More times in the calendar →" : "";
      const tagParts = [meetingDesc ? `📅 ${meetingDesc}` : null, moreNote || null].filter(Boolean);
      const tagLine = tagParts.length > 0 ? `\n\n${tagParts.join("")}` : "";
      scheduleBlock = `${header}\n\n${body}${legend}${tagLine}`;
    } else {
      scheduleBlock = `I don't have open times to show right now — tell me what generally works and I'll find a match.`;
    }

    // 3. Closing — ask for what's still needed, keep it tight.
    const needed: string[] = [];
    if (!topic) needed.push("what it's about");
    if (!inviteeName) needed.push("your name");
    if (!link.inviteeEmail) needed.push("your email");
    let closing: string;
    if (needed.length === 0) {
      closing = "Pick a time and I'll get it booked! 🤝";
    } else {
      const joined =
        needed.length === 1
          ? needed[0]
          : needed.length === 2
          ? `${needed[0]} and ${needed[1]}`
          : `${needed.slice(0, -1).join(", ")}, and ${needed[needed.length - 1]}`;
      closing = `Pick a time and let me know ${joined} — I'll get it booked! 🤝`;
    }

    // Assemble — three tight blocks.
    const parts: string[] = [intro, scheduleBlock, closing];
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
      duration: (link.rules as Record<string, unknown>)?.duration ?? null,
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
