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
  resolveSeedGuestTimezoneForCreate,
  resolveEffectiveGuestTimezone,
} from "@/lib/guest-timezone-seed";
import {
  formatAvailabilitySlotList,
  formatStretchDays,
  humanTimezoneLabel,
  formatLabel,
  buildOpenWindowGreeting,
  computeCanonicalWeekLabel,
} from "@/lib/greeting-template";
import {
  buildGuestGreeting,
  extractGuestPreferencesSummary,
} from "@/lib/guest-greeting-template";

const GENERIC_TOPICS = new Set([
  "meeting", "catch up", "catch-up", "catchup", "chat", "sync",
  "check in", "check-in", "checkin", "connect", "touch base",
  "quick chat", "quick meeting", "quick sync", "discussion",
  "call", "quick call", "phone call", "video call",
]);
function isGenericTopic(topic: string): boolean {
  return GENERIC_TOPICS.has(topic.trim().toLowerCase());
}

/**
 * Pick the greeting from a session's messages. The greeting is the first
 * administrator-role message (written when the session is created). Earlier
 * indices may be "system" update rows (Format updated, Location updated)
 * or "host_note" rows that got inserted before the guest ever arrived; those
 * must NOT be surfaced as the greeting — that was Bug 3b in the 2026-04-20
 * dashboard-channel-grounding proposal.
 */
function pickGreeting(messages: Array<{ role: string; content: string }>): string {
  const administratorMsg = messages.find((m) => m.role === "administrator");
  if (administratorMsg) return administratorMsg.content;
  // Defensive fallback — preserves prior behavior for legacy rows.
  return messages[0]?.content ?? "";
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
          { error: "archived", hostEmail: user.email || null, hostName: user.name || null, hostMeetSlug: user.meetSlug || null },
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
      // Extra diagnostics — we've had a few "dashboard shows confirmed but
      // deal-room says link not found" reports (e.g. hvn5p2 on 2026-04-18).
      // Log whether the slug exists at all (user does exist) and whether
      // ANY link with that code exists under a different slug (shouldn't,
      // code is unique — but let's know).
      const byCode = await prisma.negotiationLink.findUnique({
        where: { code },
        select: { slug: true, userId: true, createdAt: true },
      });
      const hasSessions = await prisma.negotiationSession.count({
        where: { link: { code } },
      });
      console.error(
        `[negotiate/session] Link not found: slug="${slug}" code="${code}". ` +
        `byCode: ${byCode ? `exists-slug="${byCode.slug}"-userId=${byCode.userId}` : "null"}. ` +
        `sessions-referencing-code: ${hasSessions}`
      );
      return NextResponse.json({ error: "Link not found" }, { status: 404 });
    }

    const isHost = authSession?.user?.id === user.id;
    // Bilateral: detect a logged-in guest (authenticated User who is NOT the host).
    // Anonymous guests leave authSession null → isGuest false.
    const isGuest = !isHost && !!authSession?.user?.id;
    const guestUserPayload = isGuest && authSession?.user
      ? {
          id: authSession.user.id,
          name: authSession.user.name || null,
          email: authSession.user.email || null,
        }
      : undefined;
    const linkPayload = {
      type: link.type,
      topic: link.topic,
      inviteeName: link.inviteeName,
      format: (link.rules as Record<string, unknown>)?.format ?? null,
      duration: (link.rules as Record<string, unknown>)?.duration ?? null,
      location: (link.rules as Record<string, unknown>)?.location ?? null,
      activity: (link.rules as Record<string, unknown>)?.activity ?? null,
      activityIcon: (link.rules as Record<string, unknown>)?.activityIcon ?? null,
      timingLabel: (link.rules as Record<string, unknown>)?.timingLabel ?? null,
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
            { error: "archived", hostEmail: user.email || null, hostName: user.name || null, hostMeetSlug: user.meetSlug || null },
            { status: 410 }
          );
        }

        // Backfill guestId for logged-in guests whose session predates bilateral
        // recognition (or who opened it anonymously and later signed in). Only
        // write if unset so we don't overwrite a different guest's claim.
        if (isGuest && !existingSession.guestId && authSession?.user?.id) {
          await prisma.negotiationSession.update({
            where: { id: existingSession.id },
            data: { guestId: authSession.user.id },
          });
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
              id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt.toISOString(),
            })),
            host: { name: user.name },
            link: linkPayload,
            isHost,
            isGuest,
            guestUser: guestUserPayload,
            sessionTimezone: existingSession.guestTimezone ?? null,
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
            greeting: pickGreeting(existingSession.messages),
            messages: existingSession.messages.map((m) => ({
              id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt.toISOString(),
            })),
            resumed: true,
            host: { name: user.name },
            link: linkPayload,
            isHost,
            isGuest,
            guestUser: guestUserPayload,
            sessionTimezone: existingSession.guestTimezone ?? null,
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
            { error: "archived", hostEmail: user.email || null, hostName: user.name || null, hostMeetSlug: user.meetSlug || null },
            { status: 410 }
          );
        }

        // Backfill guestId for logged-in guests (single-mode) — same rule as group mode:
        // only write if unset, never overwrite another guest's claim.
        if (isGuest && !existingSession.guestId && authSession?.user?.id) {
          await prisma.negotiationSession.update({
            where: { id: existingSession.id },
            data: { guestId: authSession.user.id },
          });
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
              id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt.toISOString(),
            })),
            host: { name: user.name },
            link: linkPayload,
            isHost,
            isGuest,
            guestUser: guestUserPayload,
            sessionTimezone: existingSession.guestTimezone ?? null,
            hostName: user.name,
          });
        }

        if (existingSession.messages.length > 0) {
          return NextResponse.json({
            sessionId: existingSession.id,
            status: existingSession.status,
            statusLabel: existingSession.statusLabel,
            greeting: pickGreeting(existingSession.messages),
            messages: existingSession.messages.map((m) => ({
              id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt.toISOString(),
            })),
            resumed: true,
            host: { name: user.name },
            link: linkPayload,
            isHost,
            isGuest,
            guestUser: guestUserPayload,
            sessionTimezone: existingSession.guestTimezone ?? null,
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
  // Bilateral: logged-in guest = authenticated User who is NOT the host.
  // Anonymous guests leave authSession null → isGuest false.
  const isGuest = !isHost && !!authSession?.user?.id;
  const guestUserPayload = isGuest && authSession?.user
    ? {
        id: authSession.user.id,
        name: authSession.user.name || null,
        email: authSession.user.email || null,
      }
    : undefined;
  const guestIdForCreate = isGuest && authSession?.user?.id ? authSession.user.id : null;

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
    // First-write-wins backfills: guestTimezone and guestId both follow the
    // same rule — only write if unset so we never overwrite an earlier claim.
    // Guards on guestTimezone:
    //   - Never land host's browser TZ (isHost guard): a host previewing
    //     from a travel laptop shouldn't corrupt the guest-facing greeting.
    //   - If the link has an `inviteeTimezone` declaration, that's the
    //     authoritative seed — the session row should have been created with
    //     it already. Don't let observed browser TZ sneak in as a backfill
    //     and undermine the declared soft-lock.
    const backfillData: Prisma.NegotiationSessionUpdateInput = {};
    if (
      session &&
      !session.guestTimezone &&
      guestTimezone &&
      !isHost &&
      !link.inviteeTimezone
    ) {
      backfillData.guestTimezone = guestTimezone;
    }
    if (session && !session.guestId && guestIdForCreate) {
      backfillData.guest = { connect: { id: guestIdForCreate } };
    }
    if (session && Object.keys(backfillData).length > 0) {
      session = await prisma.negotiationSession.update({
        where: { id: session.id },
        data: backfillData,
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
          guestId: guestIdForCreate,
          type: "calendar",
          status: "active",
          title: buildSessionTitle(link.topic, link.inviteeName, hostFirstName),
          statusLabel: `Waiting for ${link.inviteeName || 'invitee'}`,
          guestTimezone: resolveSeedGuestTimezoneForCreate({
          linkInviteeTimezone: link.inviteeTimezone,
          observedBrowserTimezone: guestTimezone,
          isHost,
        }),
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
        guestId: guestIdForCreate,
        type: "calendar",
        status: "active",
        title: buildSessionTitle(link.topic, link.inviteeName, hostFirstName),
        statusLabel: `Waiting for ${link.inviteeName || 'invitee'}`,
        guestTimezone: resolveSeedGuestTimezoneForCreate({
          linkInviteeTimezone: link.inviteeTimezone,
          observedBrowserTimezone: guestTimezone,
          isHost,
        }),
        duration: (lr.duration as number) || 30,
        format: (lr.format as string) || null,
      },
    });
  }

  console.log(`[negotiate/session] created | session=${session.id} | duration=${session.duration} | format=${session.format} | topic=${link.topic || "none"}`);

  // Effective guest timezone used for downstream formatting. Priority:
  //   1. link.inviteeTimezone — host-declared ("Sarah is on EST")
  //   2. session.guestTimezone — first-observed browser TZ
  //   3. guestTimezone (current request) — host-preview fallback, never persisted
  // Declared wins so a host previewing from a travel laptop still sees
  // greetings in the invitee's TZ. Acts as a soft-lock until the greeting
  // re-render path ships (see proposals/2026-04-18_link-invitee-timezone-seed).
  const effectiveGuestTz = resolveEffectiveGuestTimezone({
    linkInviteeTimezone: link.inviteeTimezone,
    sessionGuestTimezone: session.guestTimezone,
    observedBrowserTimezone: guestTimezone,
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

  // Format availability as the V2 Danny-spec bullet list. Dual-timezone is
  // inline ("6:00 AM PT / 9:00 AM ET"), same-timezone collapses to one label,
  // days are bold markdown headers, cap 5 bullets per day.
  const slotList = formatAvailabilitySlotList(
    filteredSlots,
    hostTimezone,
    new Date(),
    guestTzDiffers ? effectiveGuestTz : undefined,
    effectiveDuration ?? undefined,
    effectiveMinDuration,
    { collapseIdenticalWindows: true },
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

    // Greeting V2 (Danny spec, 2026-04-18). Structure:
    //   👋 Hi {name}! I'm scheduling time with you and {host}.
    //   {emoji} {duration}-min {format}
    //   🕒 Times in your timezone: {viewerTz} · {host} is on {hostTz}
    //
    //   **Mon, Apr 27**
    //   • 6:00 AM PT / 9:00 AM ET
    //   ...
    //
    //   👉 Reply with a time that works for you, and I'll get it booked.
    const greeteeName = inviteeName ? inviteeName.split(/\s+/)[0] : "there";

    // Format emoji: phone → 📞, video → 📹, in-person → 👤 (person; per UX
    // 2026-04-20 we switched from 🤝 to 👤 to convey "together/in person"
    // without the handshake formality), fallback → 📅
    const formatEmoji = effectiveFormat === "phone" ? "📞"
      : effectiveFormat === "video" ? "📹"
      : effectiveFormat === "in-person" ? "👤"
      : "📅";

    // Activity (free-form) + its icon (free-form emoji) — set by the host's
    // LLM at create_link time. Keeps the meeting-type taxonomy expansive
    // rather than discrete.
    const activityText =
      typeof linkRules.activity === "string" && linkRules.activity.trim()
        ? linkRules.activity.trim()
        : null;
    const activityEmoji =
      typeof linkRules.activityIcon === "string" && linkRules.activityIcon.trim()
        ? linkRules.activityIcon.trim()
        : null;

    // V4 prose-first opener (2026-04-20) — replaces V3's Proposal bar.
    // Composes two sentences from whatever link-rule fragments are present,
    // drops quietly when fields are missing. Structured at-a-glance info
    // lives in the deal-room event card now, not the greeting.
    //
    //   1. Opener: "👋 NAME! I'm scheduling time with you and HOST[ for TIMING]."
    //   2. Proposal: "He's proposing [TIMING and ][DUR min ]for ACTIVITY[ in LOC]."
    //
    // If we have no substantive fields (no activity, no timing, no
    // duration/location) — drop the proposal sentence entirely.
    const linkLocationForOpener =
      typeof linkRules.location === "string" && linkRules.location.trim()
        ? linkRules.location.trim()
        : null;
    const durationForOpener =
      typeof linkRules.duration === "number" ? linkRules.duration : (effectiveDuration ?? null);
    const rawTimingLabel =
      typeof linkRules.timingLabel === "string" && linkRules.timingLabel.trim()
        ? linkRules.timingLabel.trim().slice(0, 80)
        : null;

    // Week-label hygiene (narration-hygiene-v2 S1, 2026-04-20). The host's
    // LLM sometimes parrots ambiguous host phrasing into `timingLabel`
    // (e.g., host said "next week" on a Sunday meaning the week *after*
    // this one, but create_link wrote "next week" meaning Mon–Fri
    // starting tomorrow). When the authored label says "this week" /
    // "next week" / "the week of …", compute the canonical label from the
    // actual filtered slots and override if they disagree. No external
    // date library — first-slot date vs today, both normalized to the
    // host's timezone, bucketed by the Monday-starting week.
    const canonicalWeekLabel = computeCanonicalWeekLabel(filteredSlots, hostTimezone);
    const timingLabelLooksLikeWeek =
      rawTimingLabel && /\b(this|next)\s+week\b|\bthe\s+week\s+of\b/i.test(rawTimingLabel);
    const timingLabel =
      timingLabelLooksLikeWeek && canonicalWeekLabel
        ? canonicalWeekLabel
        : rawTimingLabel;

    const openerTimingClause = timingLabel ? ` for ${timingLabel}` : "";

    const buildProposalSentence = (): string | null => {
      // Fragments assemble into: "He's proposing [timing] [and] [dur min] [for activity] [in loc]."
      const durStr = durationForOpener ? `${durationForOpener} min` : null;
      if (activityText) {
        const lead = timingLabel && durStr
          ? `${timingLabel} and ${durStr}`
          : timingLabel
          ? timingLabel
          : durStr
          ? durStr
          : null;
        const tail = linkLocationForOpener ? ` in ${linkLocationForOpener}` : "";
        if (lead) return `He's proposing ${lead} for ${activityText}${tail}.`;
        return `He's proposing a${/^[aeiou]/i.test(activityText) ? "n" : ""} ${activityText}${tail}.`;
      }
      // No activity — fall back to duration/format/location framing.
      if (durStr || linkLocationForOpener || timingLabel) {
        const parts: string[] = [];
        if (timingLabel) parts.push(timingLabel);
        if (durStr) parts.push(durStr);
        const leadJoined = parts.join(" and ");
        const locTail = linkLocationForOpener ? ` in ${linkLocationForOpener}` : "";
        return leadJoined
          ? `He's proposing ${leadJoined}${locTail}.`
          : linkLocationForOpener
          ? `He's proposing to meet in ${linkLocationForOpener}.`
          : null;
      }
      return null;
    };

    const proposalSentence = buildProposalSentence();
    // Note: hostNote is no longer rendered verbatim (narration-hygiene-v2,
    // 2026-04-20), so the proposal sentence is now always safe to include
    // when we have structured fields — no dupe risk with a pass-through line.
    const hello = `👋 ${greeteeName}! I'm scheduling time with you and ${hostFirstName}${openerTimingClause}.${
      proposalSentence ? ` ${proposalSentence}` : ""
    }`;

    const fmtLabel = formatLabel(effectiveFormat);
    const durationLabel = (effectiveMinDuration && effectiveMinDuration < (effectiveDuration ?? 30))
      ? `${effectiveMinDuration}–${effectiveDuration}`
      : effectiveDuration
      ? `${effectiveDuration}`
      : null;
    const meetingDescShort = durationLabel && fmtLabel
      ? `${durationLabel}-min ${fmtLabel}`
      : fmtLabel
      ? fmtLabel
      : durationLabel
      ? `${durationLabel}-min meeting`
      : "meeting";

    // Optional venue/address. Shown as a fourth line when set.
    const linkLocation = typeof linkRules.location === "string" && linkRules.location.trim()
      ? linkRules.location.trim()
      : null;

    const isVip = !!(linkRules.isVip);

    // guestPicks branch (2026-04-17): when the host deferred details to the
    // guest, skip the day-bullet windows list entirely and render the
    // open-window variant. Preserves the host's ambiguity instead of
    // artificially pinning a narrow offer.
    const guestPicks = (linkRules as Record<string, unknown>).guestPicks as
      | { window?: { startHour: number; endHour: number }; date?: boolean; duration?: boolean | number[]; location?: boolean }
      | undefined;
    const guestGuidance = (linkRules as Record<string, unknown>).guestGuidance as
      | { suggestions?: { locations?: string[]; durations?: number[] }; tone?: string }
      | undefined;
    const hasGuestPicks =
      !!guestPicks &&
      !!(guestPicks.window || guestPicks.date || guestPicks.duration || guestPicks.location);

    if (hasGuestPicks) {
      // Anchor date: use the earliest filteredSlot's host-tz date as the "when"
      // when the host specified one (e.g., "this afternoon" → today). Null
      // when guestPicks.date is true so the greeting reads "any day that works".
      const anchorIso = !guestPicks!.date && filteredSlots.length > 0
        ? new Intl.DateTimeFormat("en-CA", { timeZone: hostTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(filteredSlots[0].start))
        : null;
      // The open-window path emits its own intro so topic ("hike", "welcome-back
      // lunch") can flow through naturally. Email is NOT asked for up front —
      // it's collected by the confirm card flow when the guest locks a time.
      greeting = buildOpenWindowGreeting({
        hostFirstName,
        inviteeName,
        topic,
        formatEmoji,
        hostTimezone,
        guestTimezone: guestTzDiffers ? effectiveGuestTz : undefined,
        window: guestPicks!.window,
        anchorDate: anchorIso,
        picks: {
          date: guestPicks!.date,
          duration: guestPicks!.duration,
          location: guestPicks!.location,
        },
        guidance: guestGuidance,
        hostNote: link.hostNote,
      });
    } else {
      // V4 assembly (2026-04-20 — prose-first, Proposal bar removed):
      //   hello (opener + proposal sentence, both prose; empty lines preserved)
      //   [tzLine — only when timezones differ]
      //   [hostNoteLine — verbatim host flavor]
      //
      //   **Mon, Apr 27**
      //   • 6:00 AM PT / 9:00 AM ET
      //   ...
      //
      //   closing (points at both chat + calendar)
      //
      // Structured at-a-glance facts (activity · duration · timing · location)
      // now live in the deal-room event card instead of a greeting-bar.
      // `fmtLabel`, `durationLabel`, `linkLocation`, `activityEmoji` are still
      // used below by tzLine / hostNoteLine / event-card reader via linkRules.
      void fmtLabel; void durationLabel; void linkLocation; void activityEmoji; void meetingDescShort;

      // Timezone line. Only render when guest's tz differs — when they match,
      // the slot times themselves already include the tz abbreviation, so the
      // line is redundant noise.
      const tzLine: string | null =
        guestTzDiffers && guestTimezoneLabel
          ? `🕒 Times shown in your timezone: ${guestTimezoneLabel} · ${hostFirstName} is on ${hostTimezoneLabel}`
          : null;

      // Schedule body — the bulleted V2 list. If empty, fall back to an
      // open-ended ask.
      let scheduleBody: string;
      if (slotList.lines.length > 0) {
        scheduleBody = slotList.lines.join("\n");
        if (slotList.hasPreferred) {
          scheduleBody += `\n\n★ = best fit with ${hostFirstName}'s schedule`;
        }
        if (isVip) {
          const stretchDays = formatStretchDays(
            filteredSlots,
            hostTimezone,
            new Date(),
            guestTzDiffers ? effectiveGuestTz : undefined,
          );
          if (stretchDays) {
            scheduleBody += `\n\nIf none of those work, I can also make ${stretchDays} available — just ask.`;
          }
        }
      } else {
        scheduleBody = `I don't have open times to show right now — tell me what generally works and I'll find a match.`;
      }

      // Closing — V3 keeps it to one line and NEVER asks for email up front
      // (the confirmation card collects it when the guest locks a time). If
      // we're missing name/topic, fold just those into the sentence.
      const closing = `Choose a slot from the calendar below or reply to me with your preference to get it booked.`;

      // Host-supplied flavor (hostNote) is NO LONGER rendered verbatim in
      // the guest greeting (narration-hygiene-v2, 2026-04-20). Root cause:
      // hosts write hostNote as *context to Envoy* ("next week — he's back
      // from London"), but the 2026-04-18 pass-through ship rendered it as
      // a literal guest-facing line ("💬 John: next week — he's back from
      // London"). That leaked host-to-Envoy context into the guest view.
      // hostNote now stays in the DB as context for the create_link LLM to
      // inform structured fields (timingLabel, activity, etc.) but is never
      // displayed verbatim to guests.

      // V4: Proposal bar is gone; header is just the prose hello + optional
      // tz line. Scheduled body and closing follow with blank lines.
      const headerLines = [hello];
      if (tzLine) headerLines.push(tzLine);
      const header = headerLines.join("\n");

      greeting = [header, scheduleBody, closing].join("\n\n");
    }
  }

  // Save the greeting message
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "administrator",
      content: greeting,
    },
  });

  // Bilateral: if the visitor is a logged-in guest, fire a deterministic
  // greeting from *their* Envoy right after the host's. Template-driven, no
  // LLM — matches the host-side pattern per SPEC. Skipped for anonymous
  // guests (isGuest false) and for group events (the group flow handles its
  // own greeting shape).
  if (isGuest && !isGroupEvent && authSession?.user?.id) {
    try {
      const guestUser = await prisma.user.findUnique({
        where: { id: authSession.user.id },
        select: { name: true, preferences: true },
      });
      if (guestUser) {
        const guestPrefsSummary = extractGuestPreferencesSummary(guestUser.preferences);
        const guestFirstName = guestUser.name ? guestUser.name.split(/\s+/)[0] : null;
        const hostFirst = (user.name || "the organizer").split(/\s+/)[0];
        const guestGreeting = buildGuestGreeting({
          guestFirstName,
          hostFirstName: hostFirst,
          offerableSlots: filteredSlots,
          guestPreferences: guestPrefsSummary,
          guestTimezone: effectiveGuestTz ?? null,
          hostTimezone,
        });
        if (guestGreeting) {
          await prisma.message.create({
            data: {
              sessionId: session.id,
              // Distinct role so the client can render this in the guest-team
              // color (blue for the guest viewer, violet for the host viewer).
              role: "guest_envoy",
              content: guestGreeting,
            },
          });
        }
      }
    } catch (e) {
      // Never block the host greeting — bilateral intelligence is strictly
      // additive. Log and move on.
      console.error("[negotiate/session] guest-envoy greeting failed", e);
    }
  }

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
      location: (link.rules as Record<string, unknown>)?.location ?? null,
      activity: (link.rules as Record<string, unknown>)?.activity ?? null,
      activityIcon: (link.rules as Record<string, unknown>)?.activityIcon ?? null,
      timingLabel: (link.rules as Record<string, unknown>)?.timingLabel ?? null,
    },
    isHost,
    isGuest,
    guestUser: guestUserPayload,
    // Session's stored guest timezone (first-write-wins). Client compares to
    // the browser's detected TZ to decide whether to show the TZ recovery
    // banner. Null when no visitor has posted a TZ yet.
    sessionTimezone: session.guestTimezone ?? null,
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
