import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/agent-runner";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateCode } from "@/lib/utils";
import type { ScoredSlot, LinkParameters } from "@/lib/scoring";
import { applyEventOverrides } from "@/lib/scoring";
import { compileOfficeHoursLinks, type AvailabilityPreference } from "@/lib/availability-rules";
import { applyOfficeHoursWindow } from "@/lib/office-hours";
import type { Prisma } from "@prisma/client";
import { displayStatusLabel } from "@/lib/status-label";
import {
  getInviteeDisplay,
  getWaitingLabel,
  getInviteeFirstNamesDisplay,
  getInviteeNames,
} from "@/lib/invitee-display";
import { getUserTimezone } from "@/lib/timezone";
import {
  resolveSeedGuestTimezoneForCreate,
  resolveEffectiveGuestTimezone,
} from "@/lib/guest-timezone-seed";
import {
  formatLabel,
  computeCanonicalWeekLabel,
} from "@/lib/greeting-template";
import { selectGreeting, type GreetingInput } from "@/agent/greetings/registry";
// formatAvailabilitySlotList / formatAvailabilityProse / formatStretchDays /
// buildOpenWindowGreeting removed 2026-04-23 when the bulleted schedule body
// and guestPicks open-window template were folded into the unified greeting
// framework. Exports retained in greeting-template.ts for unit tests; no
// production caller remains.
// Guest-Envoy greeting imports — intentionally retained as comment so the
// re-enable path is one-line. See disabled block below (2026-04-23).
// import {
//   buildGuestGreeting,
//   extractGuestPreferencesSummary,
// } from "@/lib/guest-greeting-template";
import {
  deriveLegacy,
  hasExclusiveOverride,
  readStoredSteering,
} from "@/lib/intent";
import { computeDensityHorizon } from "@/lib/availability-density";
import { getSchedulingMode } from "@/lib/scheduling-mode";
import { parseLinkParameters } from "@/lib/link-parameters";
import { isGenericTopic } from "@/lib/activity-vocab";

// GENERIC_TOPICS / isGenericTopic moved to @/lib/activity-vocab in the
// 2026-04-28 event-edit proposal (Q3 fold) — single source of truth.

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
  link: { inviteeName?: string | null; inviteeNames?: string[] },
  hostFirstName: string,
): string {
  const display = getInviteeDisplay(link);
  if (topic && !isGenericTopic(topic)) {
    return `${topic}${display ? ` — ${display}` : ""}`;
  }
  if (display) return `${hostFirstName} + ${display}`;
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

  // Host timezone — resolved from preferences here so every response shape
  // (resume paths + fresh-greeting path) can surface it to the client. The
  // calendar card picker needs it to render the secondary "{host} is in
  // {host-tz}" label without a separate fetch. Defaults consistent with the
  // later fallback used for schedule compute.
  const hostTimezoneEarly = getUserTimezone(
    (user.preferences as Record<string, unknown>) || {},
  );

  // Office-hours detection: if a code is provided and matches an active
  // office_hours rule on this user, spawn a fresh child link + session for
  // this visitor. Each visit creates a new session (primary-link semantics).
  // Runs BEFORE the standard NegotiationLink lookup so office-hours codes
  // don't collide with contextual link codes.
  let officeHoursRule: AvailabilityPreference | null = null;
  if (code) {
    const prefsRaw = (user.preferences as Record<string, unknown>) || {};
    const explicit = (prefsRaw.explicit as Record<string, unknown>) || {};
    const rules = (explicit.structuredRules as AvailabilityPreference[] | undefined) || [];
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

  // Find the link — contextual (with code) or primary
  let link;
  let reuseSessionId: string | null = null;
  if (officeHoursRule) {
    // Spawn a fresh child link for this visitor, keyed back to the rule via
    // recurringWindowId. Primary-link semantics: each visit creates a new link +
    // session, and the guest resumes via the sessionId URL, not the rule's
    // public /meet/{slug}/{code}.
    const oh = officeHoursRule.officeHours!;
    const childCode = generateCode();
    // Pipe host's per-rule guest-picks toggles (if opted in) into the child
    // link's parameters.guestPicks. Defensive: only writes when the dimension
    // isn't already set (would only matter if a future code path pre-populates
    // — today the link is freshly minted so guestPicks is always absent here).
    // Reusable-link guest-picks proposal, decided 2026-04-28.
    const ohGuestPicks = oh.guestPicks;
    const ohGuestPicksParam =
      ohGuestPicks?.format || ohGuestPicks?.duration
        ? {
            ...(ohGuestPicks.format ? { format: true as const } : {}),
            ...(ohGuestPicks.duration ? { duration: true as const } : {}),
          }
        : null;
    link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        type: "contextual",
        slug: user.meetSlug!,
        code: childCode,
        topic: oh.title,
        recurringWindowId: officeHoursRule.id,
        parameters: {
          format: oh.format,
          duration: oh.durationMinutes,
          ...(ohGuestPicksParam ? { guestPicks: ohGuestPicksParam } : {}),
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
      inviteeNames: link.inviteeNames,
      format: parseLinkParameters(link.parameters).format ?? null,
      duration: parseLinkParameters(link.parameters).duration ?? null,
      location: parseLinkParameters(link.parameters).location ?? null,
      activity: parseLinkParameters(link.parameters).activity ?? null,
      activityIcon: parseLinkParameters(link.parameters).activityIcon ?? null,
      timingLabel: parseLinkParameters(link.parameters).timingLabel ?? null,
      startTime: parseLinkParameters(link.parameters).startTime ?? null,
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
            hostTimezone: hostTimezoneEarly,
            viewerTimezone: existingSession.viewerTimezone ?? null,
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
            hostTimezone: hostTimezoneEarly,
            viewerTimezone: existingSession.viewerTimezone ?? null,
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
            hostTimezone: hostTimezoneEarly,
            viewerTimezone: existingSession.viewerTimezone ?? null,
            hostName: user.name,
          });
        }

        // Only resume (return existing messages as the "greeting") if the
        // session actually has an administrator greeting message. If the only
        // messages are pre-engagement host-update system rows (e.g., from
        // the host calling update_format / update_time / update_location on
        // the link before any guest visit), fall through to the fresh-greeting
        // generation path — the guest's first view should be a proper greeting,
        // not a bare "Format updated to phone" system line.
        //
        // Reported 2026-04-21 (Marco link narh3f) — host said "find time with
        // Marco" then "lets switch it to a call" before Marco visited. Marco
        // loaded the deal room and saw only "✓ Format updated to phone" with
        // no greeting. Same class as the update_link pre-engagement bug but
        // via a different handler path.
        const hasGreeting = existingSession.messages.some(
          (m) => m.role === "administrator",
        );
        if (hasGreeting) {
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
            hostTimezone: hostTimezoneEarly,
            viewerTimezone: existingSession.viewerTimezone ?? null,
            hostName: user.name,
          });
        }

        // Pre-engagement session (no greeting yet, with or without
        // pre-engagement host-update system messages). Fall through to the
        // fresh-greeting path. Before that, delete any host-edit artifacts
        // so they don't precede the generated greeting chronologically — the
        // guest shouldn't see "Format updated to phone" before any actual
        // introduction. Only metadata.kind === "host_update" system rows are
        // touched; any real content (shouldn't exist pre-engagement, but
        // guarded anyway) is left alone.
        if (existingSession.messages.length > 0) {
          await prisma.message.deleteMany({
            where: {
              sessionId: existingSession.id,
              role: "system",
              AND: [
                { metadata: { path: ["kind"], equals: "host_update" } },
              ],
            },
          });
        }

        // Clean up any other empty sessions for this link.
        await prisma.negotiationSession.deleteMany({
          where: {
            linkId: link.id,
            id: { not: existingSession.id },
            messages: { none: {} },
          },
        });
        // Reuse this session for the fresh-greeting generation below.
        reuseSessionId = existingSession.id;
      }
    }
  } else {
    // Bare-slug visit (`/meet/<slug>` with no code): mint a fresh link +
    // session so the URL has something to persist against. Stamped as
    // `type: "primary"` so downstream greeting rendering and guest-facing
    // UI reach the right branches — these links have no inviteeName, no
    // host-personalization, and shouldn't read as "John proposes…" to the
    // guest. Pre-2026-04-21 this was mis-stamped as "contextual" (with a
    // comment apologizing for it); fixed after feedback cmo8d9eqs.
    //
    // Link-rules mirroring (actions.ts:patchLinkRulesForContextual,
    // update-gcal:141) intentionally skips "primary" type — per-visit
    // mints don't benefit from rule mirroring anyway (no shared link,
    // no future guests on the same URL).
    const autoCode = generateCode();
    // Pipe host's primary-link guest-picks toggles (if opted in) into the
    // freshly minted link's parameters.guestPicks. Defensive: only writes
    // dimensions the host has flipped on; preserves the absent default.
    // Reusable-link guest-picks proposal, decided 2026-04-28.
    const primaryPrefsRaw = (user.preferences as Record<string, unknown>) || {};
    const primaryExplicit = (primaryPrefsRaw.explicit as Record<string, unknown>) || {};
    const primaryGuestPicks = primaryExplicit.primaryLinkGuestPicks as
      | { format?: boolean; duration?: boolean }
      | undefined;
    const primaryGuestPicksParam =
      primaryGuestPicks?.format || primaryGuestPicks?.duration
        ? {
            ...(primaryGuestPicks.format ? { format: true as const } : {}),
            ...(primaryGuestPicks.duration ? { duration: true as const } : {}),
          }
        : null;
    link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        type: "primary",
        slug: user.meetSlug!,
        code: autoCode,
        ...(primaryGuestPicksParam
          ? {
              parameters: {
                guestPicks: primaryGuestPicksParam,
              } as unknown as Prisma.InputJsonValue,
            }
          : {}),
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
      const lr = parseLinkParameters(link.parameters);
      session = await prisma.negotiationSession.create({
        data: {
          linkId: link.id,
          hostId: user.id,
          guestId: guestIdForCreate,
          type: "calendar",
          status: "active",
          title: buildSessionTitle(link.topic, link, hostFirstName),
          statusLabel: getWaitingLabel(link) || "Waiting for invitee",
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
    const lr = parseLinkParameters(link.parameters);
    session = await prisma.negotiationSession.create({
      data: {
        linkId: link.id,
        hostId: user.id,
        guestId: guestIdForCreate,
        type: "calendar",
        status: "active",
        title: buildSessionTitle(link.topic, link, hostFirstName),
        statusLabel: getWaitingLabel(link) || "Waiting for invitee",
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
    let schedule = await getOrComputeSchedule(user.id);
    // If the calendar is connected but returned zero events, the sync may
    // have been cold or failed silently — force a fresh pull before
    // generating the greeting so we don't offer times that are actually blocked.
    if (schedule.connected && schedule.events.length === 0) {
      console.warn(`[session/greeting] connected calendar returned 0 events (userId=${user.id}) — forcing refresh`);
      schedule = await getOrComputeSchedule(user.id, { forceRefresh: true });
    }
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
    rules: parseLinkParameters(link.parameters),
    calendarContext,
    hostPersistentKnowledge: user.persistentKnowledge,
    hostUpcomingSchedulePreferences: user.upcomingSchedulePreferences,
    isGroupEvent,
    eventParticipants,
    conversationHistory: [],
  };

  // Human-readable timezone label for the greeting ("Pacific time", not "GMT-7").
  // hostTimezoneLabel was used in the tz line (removed 2026-04-21). Kept
  // importable via humanTimezoneLabel in case downstream callers surface it.
  // `guestTzDiffers` and `guestTimezoneLabel` were removed 2026-04-21 when
  // dual-tz greeting rendering was dropped (decision #10). The calendar card
  // picker + Envoy follow-up chat now handle viewer-tz presentation;
  // effectiveGuestTz is still used as the seed for session.guestTimezone
  // (first-visit capture) so we keep it in scope.

  // Resolve effective format/duration — link rules override user preferences.
  const linkRules = parseLinkParameters(link.parameters);
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
    linkRules as LinkParameters,
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
          link: { recurringWindowId: officeHoursRule.id },
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

  // guestPicks.window clamp (2026-04-20): mirror what slots-route.ts already
  // does for the widget — clamp offered slots to the host-tz hour window
  // ("afternoon" = 12–17). Historically this lived only in the widget's slot
  // filter, which meant the greeting saw unclamped slots. Safe now because
  // with a pure `window` constraint (no guest picks for date/duration/location)
  // we route through the standard prose/bulleted path instead of the
  // open-window template, so the greeting must see the same clamp the widget
  // does or they disagree.
  {
    const gpWindow = (linkRules as Record<string, unknown>).guestPicks as
      | { window?: { startHour?: number; endHour?: number } }
      | undefined;
    const win = gpWindow?.window;
    if (
      win &&
      typeof win.startHour === "number" &&
      typeof win.endHour === "number" &&
      win.endHour > win.startHour
    ) {
      const { slotStartInWindow } = await import("@/lib/time-of-day");
      const clampWindow = { startHour: win.startHour, endHour: win.endHour };
      filteredSlots = filteredSlots.filter((s) =>
        slotStartInWindow(s.start, clampWindow, hostTimezone),
      );
    }
  }

  // Density-aware horizon: expand lookout window if the host is very busy.
  // Multi-day (date-mode) links skip this — they use the full 8-week pool.
  const schedulingMode = getSchedulingMode(linkRules as { duration?: number | null });
  if (schedulingMode === "time") {
    const horizonDays = computeDensityHorizon(filteredSlots);
    const cutoff = new Date(Date.now() + horizonDays * 86_400_000);
    filteredSlots = filteredSlots.filter((s) => new Date(s.start) < cutoff);
    console.log(`[session] density horizon=${horizonDays}d filteredSlots=${filteredSlots.length}`);
  }

  // V2 bullet-list pre-computation removed 2026-04-23 — the bulleted body
  // branch was deleted when the greeting framework unified around calendar-
  // widget deferral. `effectiveDuration` + `effectiveMinDuration` still
  // flow into the widget via scoring; nothing in the greeting renderer
  // needs a flat slot list anymore.

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

    const rawTopic = link.topic || null;

    // Greeting V2 (Danny spec, 2026-04-18). Multi-invitee-aware: for a 2+
    // invitee link we greet "Will & Andrew" rather than just the first name
    // (feedback cmoc4mue0…, 2026-04-23). Single-invitee behavior unchanged.
    const inviteeNamesArr = getInviteeNames(link);
    const greeteeName = getInviteeFirstNamesDisplay(link) || "there";

    // Activity (free-form) — set by the host's LLM at create_link time.
    // Keeps the meeting-type taxonomy expansive rather than discrete.
    // Format emoji + activityIcon are no longer rendered in the greeting
    // (activityIcon lives on the thread card; format emoji was dropped with
    // the 2026-04-23 voice refactor).
    const activityText =
      typeof linkRules.activity === "string" && linkRules.activity.trim()
        ? linkRules.activity.trim()
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

    const guestPicks = (linkRules as Record<string, unknown>).guestPicks as
      | { window?: { startHour: number; endHour: number }; date?: boolean; duration?: boolean | number[]; location?: boolean; format?: boolean | string[] }
      | undefined;
    const guestGuidance = (linkRules as Record<string, unknown>).guestGuidance as
      | { suggestions?: { locations?: string[]; durations?: number[] }; tone?: string }
      | undefined;
    // ────────────────────────────────────────────────────────────────────
    // Greeting render (2026-04-23 unified-branch refactor)
    //
    //   Branch A — named invitee + steering=exclusive + single-slot override
    //              → "Envoy lined up a time" handoff to the offer card.
    //   Branch B-proposal — named invitee + any structural field set (format,
    //              duration, activity, or location) → "He's proposing {xxx}"
    //              voice. Timing is folded into {xxx}.
    //   Branch B-find-time — named invitee with no structural fields set
    //              → "{Host} asked me to find time{ timingLabel}" voice.
    //   Branch C — anonymous link (type=primary OR recurringWindowId!=null, i.e.
    //              office-hours child) → agent-voice self-intro. Office-hours
    //              surface `topic` inline; bare primaries use "default is".
    //
    // Rules baked in:
    //   • `link.type === "primary" || link.recurringWindowId != null` is the ONLY
    //     gate for anonymous voice. Steering does NOT select the branch.
    //   • Bulleted schedule body (old Branch D) deleted. Calendar widget IS
    //     the enumeration.
    //   • guestPicks open-window template (`buildOpenWindowGreeting`) folded
    //     inline as a "Let me know where/how long works" hint on B-templates.
    //   • Dimension-aware suggest-alt clause — mentions only the dimensions
    //     the host actually set; skipped for directive steering (narrow/
    //     exclusive) and skipped entirely for office-hours links (topic
    //     defines the offer).
    //   • Calendar-connect pitch — shown only when there's >1 bookable slot
    //     AND the viewer is anonymous (logged-in guests already have app-
    //     level calendar access).
    // ────────────────────────────────────────────────────────────────────

    const isAnonymousLink = link.type === "primary" || !!link.recurringWindowId;
    const isOfficeHoursLink = !!link.recurringWindowId;

    const storedSteering = readStoredSteering(linkRules);
    const effectiveSteering = storedSteering ?? deriveLegacy(linkRules);
    if (effectiveSteering === "exclusive" && !hasExclusiveOverride(linkRules)) {
      console.error(
        `[greeting] intent=exclusive with no slotOverrides[-2] (sessionId=${session.id}, linkCode=${link.code ?? "?"})`,
      );
    }
    const isDirective =
      effectiveSteering === "narrow" || effectiveSteering === "exclusive";

    // Multi-slot signal drives the calendar-connect pitch. "Bookable" = future
    // slot with score ≤ 1 (matches the widget's offerable predicate).
    const nowMs = Date.now();
    const bookableSlotCount = filteredSlots.filter(
      (s) =>
        new Date(s.start).getTime() > nowMs &&
        typeof s.score === "number" &&
        s.score <= 1,
    ).length;
    const isMultiSlot = bookableSlotCount > 1;
    const calendarPitch = isMultiSlot && !isGuest
      ? "Also, if you connect your calendar I can automagically find the best fit for you! 🗓️"
      : null;

    // Dimension-aware suggest-alt clause for the named-invitee greeting
    // branches. Gated on guestPicks: only promise flexibility on dimensions
    // where the host has explicitly opted guests in. Otherwise the composer
    // refuses the change and the greeting becomes a broken promise — see the
    // 2026-04-28 reusable-link guest-picks proposal (B5) and the screenshot
    // regression where Envoy invited "suggest a different meeting length",
    // accepted "45 mins", then refused with "I can't adjust that here."
    // Anonymous reusable links use the separate seeded follow-up message
    // below; this clause stays for the named-invitee contextual-link path.
    const suggestAltClause = ((): string | null => {
      if (isDirective || isOfficeHoursLink) return null;
      const fmtPick = !!guestPicks?.format;
      const durPick =
        guestPicks?.duration === true ||
        (Array.isArray(guestPicks?.duration) && guestPicks.duration.length > 0);
      if (!fmtPick && !durPick) return null;
      if (fmtPick && durPick)
        return "and feel free to suggest a different format or meeting length if that's better for you";
      if (fmtPick)
        return "and feel free to suggest a different format if that's better for you";
      return "and feel free to suggest a different meeting length if that's better for you";
    })();

    // Guest-pick hint — folds the old `hasGuestPicks` / buildOpenWindowGreeting
    // special case inline. Date-pick is intentionally suppressed (the calendar
    // widget IS the day picker).
    const guestPickHint = ((): string | null => {
      if (!guestPicks) return null;
      const locPick = !!guestPicks.location;
      const durPick = guestPicks.duration === true || (Array.isArray(guestPicks.duration) && guestPicks.duration.length > 0);
      let lead: string | null = null;
      if (locPick && durPick) lead = "where and how long works for you";
      else if (locPick) lead = "where works for you";
      else if (durPick) lead = "how long works for you";
      if (!lead) return null;
      let hint = `Let me know ${lead}`;
      const locSugs = guestGuidance?.suggestions?.locations || [];
      if (locPick && locSugs.length > 0) {
        if (locSugs.length === 1) {
          hint += ` — ${hostFirstName} suggested ${locSugs[0]}`;
        } else if (locSugs.length === 2) {
          hint += ` — ${hostFirstName} suggested ${locSugs[0]} or ${locSugs[1]}`;
        } else {
          hint += ` — ${hostFirstName} suggested ${locSugs.slice(0, -1).join(", ")}, or ${locSugs[locSugs.length - 1]}`;
        }
      }
      return `${hint}.`;
    })();

    // Pre-filter `rawTopic` for the registry: the anonymous template surfaces
    // it inline, but only when it's a real host-authored topic — generic
    // chat-talk ("meeting", "catch up") gets stripped here so the registry
    // stays pure. Non-anonymous branches don't read `rawTopic`.
    const filteredTopicForRegistry =
      rawTopic && !isGenericTopic(rawTopic) ? rawTopic : null;

    // Build the registry input bundle. Mirrors the exact shape the previous
    // inlined branches read; the registry resolver picks the matching
    // template and renders.
    const greetingInput: GreetingInput = {
      hostFirstName,
      hostTimezone,
      greeteeName,
      inviteeCount: inviteeNamesArr.length,
      linkRules,
      isAnonymousLink,
      isOfficeHoursLink,
      effectiveSteering,
      activityText,
      linkLocationForOpener,
      durationForOpener,
      effectiveDuration,
      effectiveFormat,
      rawTopic: filteredTopicForRegistry,
      meetingDescShort,
      timingLabel,
      guestPickHint,
      suggestAltClause,
      calendarPitch,
      toneLine: guestGuidance?.tone ? guestGuidance.tone : null,
    };
    greeting = selectGreeting(greetingInput).render(greetingInput);
  }

  // Save the greeting message
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "administrator",
      content: greeting,
    },
  });

  // Suggest-alt follow-up message — fires for anonymous reusable links
  // (primary or Office Hours) where the host has opted into guestPicks.
  // Posted as a SEPARATE Envoy message after the greeting so the suggestion
  // reads as its own conversational beat (visually following the picker UI
  // in the deal-room render). Reusable-link guest-picks proposal,
  // decided 2026-04-28. Removes the prior `suggestAltClause` greeting-string
  // approach for anonymous links — that scaffolding still handles named-
  // invitee contextual-link branches.
  // `isAnonymousLink` is also computed inside the greeting-render block above
  // (line ~929) but that's local-scope; recompute here for the seeded follow-up.
  const isAnonymousForFollowUp = link.type === "primary" || !!link.recurringWindowId;
  if (
    isAnonymousForFollowUp &&
    (linkRules.guestPicks?.format || linkRules.guestPicks?.duration)
  ) {
    const fmtSet = !!linkRules.guestPicks?.format;
    const durSet = !!linkRules.guestPicks?.duration;
    const followUp = (() => {
      if (fmtSet && durSet) {
        return "Also… if you prefer a different duration or format (eg phone or in person) we can do that — just let me know what is best for this meeting.";
      }
      if (fmtSet) {
        return "Also… if you prefer a different format (eg phone or in person) we can do that — just let me know what is best for this meeting.";
      }
      return "Also… if you prefer a different duration we can do that — just let me know what is best for this meeting.";
    })();
    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: "administrator",
        content: followUp,
        metadata: { kind: "suggest_alt_followup" } as Prisma.InputJsonValue,
      },
    });
  }

  // Bilateral guest-Envoy initial greeting — DISABLED 2026-04-23 per John.
  // Didn't add enough at the initial-greeting stage to justify the extra
  // bubble; template, helpers, and tests are retained for potential re-
  // enable once the voice is redesigned to match the find-time/proposal
  // model. To re-enable: restore the block below + the two imports
  // (buildGuestGreeting, extractGuestPreferencesSummary).
  //
  // if (isGuest && !isGroupEvent && authSession?.user?.id) {
  //   try {
  //     const guestUser = await prisma.user.findUnique({
  //       where: { id: authSession.user.id },
  //       select: { name: true, preferences: true },
  //     });
  //     if (guestUser) {
  //       const guestPrefsSummary = extractGuestPreferencesSummary(guestUser.preferences);
  //       const guestFirstName = guestUser.name ? guestUser.name.split(/\s+/)[0] : null;
  //       const hostFirst = (user.name || "the organizer").split(/\s+/)[0];
  //       const guestGreeting = buildGuestGreeting({
  //         guestFirstName,
  //         hostFirstName: hostFirst,
  //         offerableSlots: filteredSlots,
  //         guestPreferences: guestPrefsSummary,
  //         guestTimezone: effectiveGuestTz ?? null,
  //         hostTimezone,
  //       });
  //       if (guestGreeting) {
  //         await prisma.message.create({
  //           data: {
  //             sessionId: session.id,
  //             role: "guest_envoy",
  //             content: guestGreeting,
  //           },
  //         });
  //       }
  //     }
  //   } catch (e) {
  //     console.error("[negotiate/session] guest-envoy greeting failed", e);
  //   }
  // }

  const participantSummary = eventParticipants?.map((p) => ({
    name: p.name,
    status: p.status,
  }));

  return NextResponse.json({
    sessionId: session.id,
    status: session.status,
    statusLabel: displayStatusLabel({
      status: session.status,
      statusLabel: session.statusLabel,
      guestEmail: session.guestEmail,
      guestName: session.guestName,
      linkType: link.type,
    }),
    greeting,
    code: link.code || undefined,
    host: {
      name: user.name,
    },
    link: {
      type: link.type,
      topic: link.topic,
      inviteeName: link.inviteeName,
      inviteeNames: link.inviteeNames,
      // Per-field "Edited just now" pill — proposal 2026-04-28 §3.C.
      // Set by update_link when material fields change (see actions.ts
      // diffMaterialFields). Surfaced verbatim to the EditedPill component.
      lastMaterialEditAt: link.lastMaterialEditAt ? link.lastMaterialEditAt.toISOString() : null,
      lastEditedFields: link.lastEditedFields ?? [],
      format: parseLinkParameters(link.parameters).format ?? null,
      duration: parseLinkParameters(link.parameters).duration ?? null,
      location: parseLinkParameters(link.parameters).location ?? null,
      activity: parseLinkParameters(link.parameters).activity ?? null,
      activityIcon: parseLinkParameters(link.parameters).activityIcon ?? null,
      activityOptions: parseLinkParameters(link.parameters).activityOptions ?? null,
      guestPicks: parseLinkParameters(link.parameters).guestPicks ?? null,
      timingLabel: parseLinkParameters(link.parameters).timingLabel ?? null,
      startTime: parseLinkParameters(link.parameters).startTime ?? null,
      // Intent.steering is the host-classified steering tier (open / soft /
      // narrow / exclusive) from PR #58. Stage 2 `deriveMode()` reads this to
      // decide offer-mode eligibility for single-slot exclusive links. Pre-
      // PR-58 links have no intent blob — client falls through to slot-count
      // / same-day rules (N7 fold of deal-room-widget-state-machine).
      intent: (parseLinkParameters(link.parameters).intent as Record<string, unknown> | null) ?? null,
    },
    isHost,
    isGuest,
    guestUser: guestUserPayload,
    // Session's stored guest timezone (first-write-wins). Client compares to
    // the browser's detected TZ to decide whether to show the TZ recovery
    // banner. Null when no visitor has posted a TZ yet.
    sessionTimezone: session.guestTimezone ?? null,
    // Host's timezone, surfaced so the calendar card picker can render the
    // "{host} is in {host-tz}" secondary label without a separate fetch.
    // Fresh-greeting path resolves hostTimezone from the schedule compute
    // (same value as hostTimezoneEarly in practice), so either is fine here.
    hostTimezone,
    // Viewer-authoritative tz on the session (null on the fresh-greeting
    // path because the session was just created). Widget writes it on first
    // card render via POST /api/negotiate/session/viewer-timezone.
    viewerTimezone: session.viewerTimezone ?? null,
    isGroupEvent: isGroupEvent || undefined,
    participants: participantSummary,
    hostName: user.name,
    // Guest-negotiated values (set by lock_activity_location in the deal room).
    // Client uses these to display the locked state in the event card thread.
    negotiatedActivity: session.negotiatedActivity ?? null,
    negotiatedLocation: session.negotiatedLocation ?? null,
    negotiatedFormat: session.negotiatedFormat ?? null,
    negotiatedLockedBy: session.negotiatedLockedBy ?? null,
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
