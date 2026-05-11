import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/agent-runner";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateCode } from "@/lib/utils";
import { hostFirstName as resolveHostFirstName } from "@/lib/host-naming";
import type { ScoredSlot, LinkParameters } from "@/lib/scoring";
import { applyEventOverrides } from "@/lib/scoring";
import { compileBookableLinks, type AvailabilityRule } from "@/lib/availability-rules";
import { applyBookableWindow } from "@/lib/bookable-links";
import type { Prisma } from "@prisma/client";
import { displayStatusLabel } from "@/lib/status-label";
import { googleCalendarEventUrl } from "@/lib/google-calendar-url";
import {
  getInviteeDisplay,
  getWaitingLabel,
} from "@/lib/invitee-display";
import { getUserTimezone } from "@/lib/timezone";
import {
  resolveSeedGuestTimezoneForCreate,
  resolveEffectiveGuestTimezone,
} from "@/lib/guest-timezone-seed";
// Phase 2 PR3b: selectGreeting retired — registry archived to
// app/src/agent/greetings/_archive/registry.ts. Runtime path now uses
// getLinkPosture(link, user).tip → renderTip().
//
// DEPRECATED: import { selectGreeting } from "@/agent/greetings/registry";
// DEPRECATED: import { buildGreetingInput } from "@/lib/greeting/build-input";
//   (buildGreetingInput is still imported by _archive/registry.ts reference
//    but has no production caller in this route — retained in build-input.ts
//    for the pre-engagement greeting regen path §11.D that's still deferred)
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";
import { getLinkPosture } from "@/lib/links/posture";
import { DEFAULT_TIP } from "@/lib/meeting-tip/default-tip";
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
 *
 * Phase 2 PR3a: new sessions no longer write a greeting Message row for
 * non-group events (USE_LEGACY_GREETING_ROW = false). When no administrator
 * row exists, returns "" — callers that previously relied on the greeting
 * message for the new MeetingCard surface should use the `tip` from
 * `Link.parameters.tip` (via renderTip()) instead.
 */
function pickGreeting(messages: Array<{ role: string; content: string }>): string {
  const administratorMsg = messages.find((m) => m.role === "administrator");
  if (administratorMsg) return administratorMsg.content;
  // Phase 2 PR3a: new sessions have no greeting Message row — return empty
  // string. Legacy resumed sessions (pre-PR3a) still have the row and take
  // the branch above. The empty string is correct for the new surface because
  // the tip is rendered on the MeetingCard, not in the chat thread.
  return "";
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

  // Bookable-link detection: if a code is provided and matches an active
  // bookable rule on this user, spawn a fresh child link + session for
  // this visitor. Each visit creates a new session (primary-link semantics).
  // Runs BEFORE the standard NegotiationLink lookup so bookable link codes
  // don't collide with personalized link codes.
  let officeHoursRule: AvailabilityRule | null = null; // variable retained for diff-locality; represents the matched bookable rule
  if (code) {
    const prefsRaw = (user.preferences as Record<string, unknown>) || {};
    const explicit = (prefsRaw.explicit as Record<string, unknown>) || {};
    const rules = (explicit.structuredRules as AvailabilityRule[] | undefined) || [];
    const match = rules.find(
      (r) => r.action === "bookable" && r.bookable?.linkCode === code,
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
    const oh = (officeHoursRule.bookable ?? (officeHoursRule as unknown as { officeHours?: typeof officeHoursRule.bookable }).officeHours)!;
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
    // Inherit recurrence + activityIcon from the bookable parent at spawn,
    // per the contract documented at availability-rules.ts:71-83 ("The child
    // NegotiationLink inherits `recurrence` from this field at session-spawn
    // time"). Pre-anchor-commit shape — firstDateLocal / timeLocal are filled
    // in on the child when the guest picks their first slot (see
    // lib/recurrence.ts). Drift fix 2026-05-11 — bookable children were
    // spawning without `recurrence`, rendering as one-off meetings in the
    // deal-room even when the parent was a weekly/biweekly template.
    // Prefer `name` over `title` for `topic` — matches the precedence used
    // by `getBookableLinkDisplayName` and the host's edit modal.
    link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        type: "personalized",
        slug: user.meetSlug!,
        code: childCode,
        topic: oh.name ?? oh.title,
        topicSource: "custom",
        recurringWindowId: officeHoursRule.id,
        ...(oh.recurrence
          ? { recurrence: oh.recurrence as unknown as Prisma.InputJsonValue }
          : {}),
        parameters: {
          format: oh.format,
          duration: oh.durationMinutes,
          ...(oh.activityIcon ? { activityIcon: oh.activityIcon } : {}),
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
            // Stored htmlLink first (canonical, always correct); constructed
            // fallback for sessions confirmed before this column shipped.
            eventLink: existingSession.gcalHtmlLink ?? googleCalendarEventUrl(existingSession.calendarEventId, user.email ?? "primary"),
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
            // Stored htmlLink first (canonical, always correct); constructed
            // fallback for sessions confirmed before this column shipped.
            eventLink: existingSession.gcalHtmlLink ?? googleCalendarEventUrl(existingSession.calendarEventId, user.email ?? "primary"),
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
      const hostFirstName = resolveHostFirstName(user);
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
    const hostFirstName = resolveHostFirstName(user);
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
        name: isHost ? user.name : null, // participant identifies themselves via chat
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
    let schedule = await getOrComputeSchedule(user.id, { link });
    // If the calendar is connected but returned zero events, the sync may
    // have been cold or failed silently — force a fresh pull before
    // generating the greeting so we don't offer times that are actually blocked.
    if (schedule.connected && schedule.events.length === 0) {
      console.warn(`[session/greeting] connected calendar returned 0 events (userId=${user.id}) — forcing refresh`);
      schedule = await getOrComputeSchedule(user.id, { forceRefresh: true, link });
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
  let groupCoordinationData: { candidateDays: string[] | null; responses: unknown[] } | undefined;
  if (isGroupEvent) {
    const allParticipants = await prisma.sessionParticipant.findMany({
      where: { linkId: link.id },
    });
    eventParticipants = allParticipants.map((p) => ({
      name: p.name || p.email || "Unknown",
      status: p.status,
    }));
    // Load the GroupCoordination row for the grid component
    const gc = await prisma.groupCoordination.findFirst({
      where: { session: { linkId: link.id } },
      select: { candidateDays: true, responses: true },
    });
    if (gc) {
      groupCoordinationData = {
        candidateDays: Array.isArray(gc.candidateDays) ? (gc.candidateDays as string[]) : null,
        responses: Array.isArray(gc.responses) ? (gc.responses as unknown[]) : [],
      };
    }
  }

  // Generate the initial greeting
  const context: AgentContext = {
    role: "coordinator",
    hostName: user.name || "the organizer",
    hostPreferences: (user.preferences as Record<string, unknown>) || {},
    hostDirectives: (user.hostDirectives as string[]) || [],
    guestName: isGroupEvent ? undefined : (link.inviteeName || undefined),
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
  // Phase 2 PR3b: effectiveDuration + effectiveMinDuration were previously
  // passed to buildGreetingInput() for slot-aware greeting rendering. That
  // path retired when selectGreeting() was replaced with renderTip().
  // Retained as underscore-prefixed vars to minimize diff noise; will be
  // cleaned up once all greeting-input references are removed.
  const _effectiveDuration =
    (linkRules.duration as number | undefined) ||
    (hostExplicit.duration as number | undefined) ||
    session.duration ||
    undefined;
  const _effectiveMinDuration =
    (linkRules.minDuration as number | undefined) || undefined;
  void _effectiveDuration; void _effectiveMinDuration; // Phase 2 PR3b — unused
  // Apply link-level filters (availability, dateRange, blockedRanges, lastResort)
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
    const compiledLinks = compileBookableLinks([officeHoursRule]);
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
      filteredSlots = applyBookableWindow({
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
  // widget deferral. Slot filtering still happens before the greeting block
  // to ensure the client sees the same set of slots as the LLM sees later.

  let greeting: string;

  if (isGroupEvent) {
    // Group links are shared with the whole group — the visitor hasn't identified
    // themselves yet. Greet them generically: reference the event (topic) and
    // who it's for (inviteeNames on the link), then ask who they are.
    const knownNames = Array.isArray(link.inviteeNames) && link.inviteeNames.length > 0
      ? (link.inviteeNames as string[]).join(", ")
      : null;
    const forWhom = knownNames ? ` for ${knownNames}` : "";
    const greetingPrompt = `Someone just opened this group coordination link. This is a shared link — the same URL goes to everyone the host invited. The visitor hasn't told you their name yet. Greet them warmly in 2–3 short sentences: welcome them to the ${link.topic ? `"${link.topic}"` : "group event"} coordination${forWhom}, let them know everyone is sharing their availability here, and ask them to tell you their name so you can record their windows. Do not assume who they are or reference any individual's name as if you know it's them.`;
    greeting = await generateAgentResponse({
      ...context,
      conversationHistory: [{ role: "user", content: greetingPrompt }],
    });
  } else {
    // Phase 2 PR3b: runtime template selection (selectGreeting) retired.
    // The elaborate deterministic greeting templates (6-template registry)
    // are archived at app/src/agent/greetings/_archive/registry.ts and used
    // only as reference material for the LLM seed-generator prompt (PR3d).
    //
    // The greeting field is now the host-authored tip (from Link.parameters.tip
    // via getLinkPosture → renderTip). This is the same content the MeetingCard
    // tip slot shows — so the EnvoyDock thread and the card are consistent.
    //
    // For new sessions (USE_LEGACY_GREETING_ROW = false), this value is NOT
    // written to a Message row; it's returned to the frontend only to seed
    // the deal-room's initial display while the tip appears on the MeetingCard.
    // For resumed sessions, this value is only used as a fallback when no
    // administrator Message exists (which is the new normal for PR3a sessions).
    let tipText: string;
    try {
      const posture = getLinkPosture(link, { preferences: user.preferences as import("@/lib/scoring").UserPreferences });
      const tipInput = buildTipInput({
        hostName: user.name ?? "",
        inviteeName: link.inviteeName ?? "",
        linkFormat: effectiveFormat ?? "video",
        linkActivity: (parseLinkParameters(link.parameters).activity as string | null) ?? null,
        linkLocation: (parseLinkParameters(link.parameters).location as string | null) ?? null,
        isAnonymousLink: link.type === "primary" || !!link.recurringWindowId,
        linkAuthoredTip: posture.tip ?? null,
      });
      tipText = renderTip(tipInput, "guest")?.text ?? DEFAULT_TIP;
    } catch {
      tipText = DEFAULT_TIP;
    }
    greeting = tipText;
  }

  // PHASE 2 PR3a — greeting Message-row gate.
  //
  // The new MeetingCard + EnvoyDock surface reads the tip directly from
  // `Link.parameters.tip` (rendered by `renderTip()` on the card's info
  // block). Having a greeting Message-row duplicates the content:
  //   - tip on the MeetingCard  ← the canonical host-personality surface
  //   - greeting in the chat thread ← now redundant noise in the new surface
  //
  // For group events we keep the Message row unconditionally — the LLM-
  // generated group greeting is the ONLY greeting (no MeetingCard tip
  // surface), so the chat thread is the sole render surface.
  //
  // For non-group events the row is deprecated starting Phase 2 PR3a.
  // Set USE_LEGACY_GREETING_ROW = true to re-enable for all non-group
  // sessions (e.g. to test the legacy event-card fall-through path).
  //
  // IMPORTANT: resume paths (`pickGreeting`) already handle sessions with
  // no administrator Message — `pickGreeting` returns "" defensively, and
  // `hasGreeting` (line ~398) falls through to fresh-greeting generation.
  const USE_LEGACY_GREETING_ROW = false; // DEPRECATED Phase 2 PR3a
  if (isGroupEvent || USE_LEGACY_GREETING_ROW) {
    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: "administrator",
        content: greeting,
      },
    });
  }

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
    // B5: guest DealRoom uses this to render the bookable subtitle.
    // link.recurringWindowId is set at session-spawn time for bookable children.
    isBookable: !!(link.recurringWindowId),
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
    groupCoordination: groupCoordinationData,
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
