import { readFileSync } from "fs";
import { join } from "path";
import type { CalendarContext, CalendarEvent } from "@/lib/calendar";
import { getUserTimezone } from "@/lib/timezone";
import { getActiveLocationRule, type AvailabilityRule } from "@/lib/availability-rules";

// --- Playbook cache (read once per cold start) ---

const PLAYBOOK_DIR = join(process.cwd(), "src", "agent", "playbooks");

function loadPlaybook(filename: string): string {
  try {
    return readFileSync(join(PLAYBOOK_DIR, filename), "utf-8");
  } catch (e) {
    console.error(`Failed to load playbook: ${filename}`, e);
    return "";
  }
}

const playbooks: Record<string, string> = {
  groundTruth: loadPlaybook("ground-truth.md"),
  globalTaste: loadPlaybook("global-taste.md"),
  persona: loadPlaybook("persona.md"),
  negotiation: loadPlaybook("negotiation.md"),
  calendar: loadPlaybook("calendar.md"),
  // rfp: loadPlaybook("rfp.md"),  // uncomment when RFP playbook exists
};

// --- Model configuration per domain ---

export type DomainType = "calendar" | "rfp";

const MODEL_CONFIG: Record<DomainType, string> = {
  calendar: "claude-sonnet-4-6",
  rfp: "claude-sonnet-4-6",
};

export function getModelForDomain(domain: DomainType): string {
  return MODEL_CONFIG[domain] || MODEL_CONFIG.calendar;
}

// --- Prompt composition ---

export interface ComposeOptions {
  domain: DomainType;
  sessionId?: string;
  hostName: string;
  hostPreferences?: Record<string, unknown>;
  guestName?: string;
  guestEmail?: string;
  guestTimezone?: string;
  topic?: string;
  rules?: Record<string, unknown>;
  /** @deprecated Use calendarContext instead */
  availableSlots?: Array<{ start: string; end: string }>;
  calendarContext?: CalendarContext;
  /** Pre-scored slots from the availability engine. When provided, the prompt
   *  shows only offerable time blocks instead of raw calendar events. */
  scoredSlots?: ScoredSlot[];
  hostPersistentKnowledge?: string | null;
  hostUpcomingSchedulePreferences?: string | null;
  hostDirectives?: string[];
  isGroupEvent?: boolean;
  eventParticipants?: Array<{
    name: string;
    status: string;
    statedAvailability?: string;
  }>;
  role?: string;
}

export function composeSystemPrompt(options: ComposeOptions): string {
  const sections: string[] = [];

  // Layer 0: Ground Truth Protocol (loaded FIRST — deterministic data rules)
  if (playbooks.groundTruth) {
    sections.push(playbooks.groundTruth);
  }

  // Layer 0b: Global Taste (platform defaults)
  if (playbooks.globalTaste) {
    sections.push(playbooks.globalTaste);
  }

  // Layer 1: Core Persona
  sections.push(playbooks.persona);

  // Layer 2: Negotiation Intelligence
  sections.push(playbooks.negotiation);

  // Layer 3: Domain Expertise
  const domainPlaybook = playbooks[options.domain];
  if (domainPlaybook) {
    sections.push(domainPlaybook);
  }

  // Layer 4: User Preferences (explicit + learned)
  if (options.hostPreferences && Object.keys(options.hostPreferences).length > 0) {
    const prefsSection = formatPreferences(options.hostPreferences, options.calendarContext?.hostLocation);
    if (prefsSection) {
      sections.push(`# Host Preferences\n\n${prefsSection}`);
    }
  }

  // Layer 4b: Host Directives (from ::: feedback — highest priority user instructions)
  if (options.hostDirectives && options.hostDirectives.length > 0) {
    const directivesBlock = options.hostDirectives
      .map((d) => `- ${d}`)
      .join("\n");
    sections.push(
      `# Host Directives\n\nThese are explicit instructions from the host. They override defaults and learned preferences. Follow them exactly.\n\n${directivesBlock}`
    );
  }

  // Layer 4c: Host Knowledge Base (persistent + situational)
  const knowledgeParts: string[] = [];
  if (options.hostPersistentKnowledge) {
    knowledgeParts.push(
      `## Persistent Preferences\nWho this host is, how they work, and what matters to them. This rarely changes.\n\n${options.hostPersistentKnowledge}`
    );
  }
  if (options.hostUpcomingSchedulePreferences) {
    knowledgeParts.push(
      `## Situational Context\nWhat's happening right now — near-term overrides, upcoming events, temporary rules. This changes frequently. If situational context conflicts with persistent preferences, situational wins.\n\n${options.hostUpcomingSchedulePreferences}`
    );
  }
  if (knowledgeParts.length > 0) {
    sections.push(`# Host Knowledge Base\n\n${knowledgeParts.join("\n\n")}`);
  }

  // Layer 4d: Unresolved preference ambiguities — be conservative
  const compiled = (options.hostPreferences as Record<string, unknown>)?.compiled as { ambiguities?: string[] } | undefined;
  if (compiled?.ambiguities?.length) {
    const ambiguityList = compiled.ambiguities.map((a) => `- ${a}`).join("\n");
    sections.push(
      `# Unresolved Preferences\n\nThe following aspects of the host's preferences are ambiguous. Be conservative — do NOT offer times that fall in ambiguous ranges. If a scheduling question directly relates to one of these, mention the uncertainty to the guest and propose a safe alternative.\n\n${ambiguityList}`
    );
  }

  // Layer 5: Session Context (includes calendar)
  const context = buildSessionContext(options);
  sections.push(`# Session Context\n\n${context}`);

  return sections.filter(Boolean).join("\n\n---\n\n");
}

function formatPreferences(prefs: Record<string, unknown>, calHostLocation?: string): string {
  const parts: string[] = [];

  const explicit = prefs.explicit as Record<string, unknown> | undefined;
  const learned = prefs.learned as Record<string, unknown> | undefined;

  if (explicit) {
    const items: string[] = [];
    if (explicit.preferredTimes) items.push(`Preferred times: ${JSON.stringify(explicit.preferredTimes)}`);
    if (explicit.format) items.push(`Preferred format: ${explicit.format}`);
    if (explicit.duration) items.push(`Default duration: ${explicit.duration} minutes`);
    if (explicit.bufferMinutes) items.push(`Buffer between meetings: ${explicit.bufferMinutes} minutes`);
    if (explicit.timezone) items.push(`Timezone: ${explicit.timezone}`);
    if (explicit.blackoutDays) items.push(`Avoid days: ${JSON.stringify(explicit.blackoutDays)}`);
    const defaultLoc = (explicit.defaultLocation as string | undefined) || (explicit.location as string | undefined);
    if (defaultLoc) items.push(`Home base / default location: ${defaultLoc}`);
    if (explicit.blockedWindows && Array.isArray(explicit.blockedWindows)) {
      const windows = (explicit.blockedWindows as Array<{ start: string; end: string; days?: string[]; label?: string; expires?: string }>)
        .filter((w) => !w.expires || w.expires >= new Date().toISOString().slice(0, 10))
        .map((w) => {
          const days = w.days ? w.days.join("/") : "every day";
          const label = w.label ? ` (${w.label})` : "";
          const expires = w.expires ? `, until ${w.expires}` : "";
          return `${w.start}–${w.end} ${days}${label}${expires}`;
        });
      if (windows.length > 0) items.push(`Blocked windows (do not schedule): ${windows.join("; ")}`);
    }
    // Location: both Google workingLocation and the active location rule are signals — pass both if they differ
    const activeLocRule = getActiveLocationRule((explicit.structuredRules as AvailabilityRule[] | undefined) ?? []);
    const activePrefLocLabel = activeLocRule?.locationLabel;
    const activePrefLocUntil = activeLocRule?.expiryDate;

    if (calHostLocation && activePrefLocLabel) {
      const locNormalized = (s: string) => s.trim().toLowerCase();
      if (locNormalized(calHostLocation) === locNormalized(activePrefLocLabel)) {
        items.push(
          `Current location: ${activePrefLocLabel} (confirmed by both Google Calendar and preferences). Host is away from home base — no in-person unless guest is nearby.`
        );
      } else {
        items.push(
          `Location signals conflict: Google Calendar working location says "${calHostLocation}", preferences say "${activePrefLocLabel}". If location matters for this meeting (in-person format, travel buffers), clarify with the host. If there is no active dialog (generic invite), be conservative and assume the host is traveling.`
        );
      }
    } else if (calHostLocation) {
      items.push(
        `Current location: ${calHostLocation} (Google Calendar working location). Host is away from home base — no in-person unless guest is nearby.`
      );
    } else if (activePrefLocLabel) {
      const untilStr = activePrefLocUntil ? ` (until ${activePrefLocUntil})` : "";
      items.push(
        `Current location: ${activePrefLocLabel}${untilStr} (host-stated location rule). Host is away from home base — no in-person unless guest is nearby.`
      );
    }
    if (items.length > 0) {
      parts.push("**Explicit (host-stated):**\n" + items.map(i => `- ${i}`).join("\n"));
    }
  }

  // Meeting settings (phone, video provider, default duration)
  const meetingItems: string[] = [];
  const defaultDur = (prefs.defaultDuration as number) || (explicit?.defaultDuration as number) || 30;
  meetingItems.push(`Default meeting duration: ${defaultDur} minutes. Use this when no duration is specified in the link rules.`);
  if (prefs.phone) {
    meetingItems.push(`Host phone: ${prefs.phone} (default location for phone calls — "guest calls host @ number")`);
  } else {
    meetingItems.push(`Host phone: NOT SET. If this meeting is a phone call and the host mentions a phone number in chat, save it with update_meeting_settings so the confirmation invite auto-populates. If a phone call is being arranged and no number is on file, ask the host for it.`);
  }
  if (prefs.videoProvider === "zoom" && prefs.zoomLink) {
    meetingItems.push(`Video provider: Zoom (link: ${prefs.zoomLink}). Use "Zoom" not "Google Meet" when discussing video meetings.`);
  } else if (prefs.videoProvider === "zoom") {
    meetingItems.push(`Video provider: Zoom (no link set — mention Zoom, not Google Meet)`);
  } else {
    meetingItems.push(`Video provider: Google Meet (auto-generated on confirmation)`);
  }
  if (meetingItems.length > 0) {
    parts.push("**Meeting settings:**\n" + meetingItems.map(i => `- ${i}`).join("\n"));
  }

  if (learned && (learned as Record<string, unknown>).confidence) {
    const items: string[] = [];
    if (learned.formatDistribution) items.push(`Format usage: ${JSON.stringify(learned.formatDistribution)}`);
    if (learned.peakAcceptanceHours) items.push(`Peak acceptance hours: ${JSON.stringify(learned.peakAcceptanceHours)}`);
    if (learned.avgMeetingDuration) items.push(`Average meeting duration: ${learned.avgMeetingDuration} min`);
    if (items.length > 0) {
      parts.push("**Learned (from past negotiations):**\n" + items.map(i => `- ${i}`).join("\n"));
    }
  }

  // Flat preferences (no explicit/learned structure yet)
  if (!explicit && !learned) {
    const items: string[] = [];
    for (const [key, value] of Object.entries(prefs)) {
      if (value !== null && value !== undefined && value !== "") {
        items.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    if (items.length > 0) {
      parts.push(items.map(i => `- ${i}`).join("\n"));
    }
  }

  return parts.join("\n\n");
}

function formatRules(rules: Record<string, unknown>): string {
  const lines: string[] = ["Special rules for this negotiation:"];

  if (rules.format) {
    lines.push(`- [GROUND TRUTH] Format (decided by host): ${rules.format}. State as fact — do NOT ask the guest about format.`);
  }

  if (rules.duration) {
    lines.push(`- [GROUND TRUTH] Duration (decided by host): ${rules.duration} minutes. State as fact — do NOT ask the guest about duration.`);
  }

  const conditional = rules.conditionalRules as Array<{ condition: string; rule: string }> | undefined;
  if (conditional && conditional.length > 0) {
    for (const cr of conditional) {
      lines.push(`- IF ${cr.condition} → ${cr.rule}`);
    }
  }

  const lastResort = rules.lastResort as string[] | undefined;
  if (lastResort && lastResort.length > 0) {
    lines.push(`- LAST RESORT only (deprioritize): ${lastResort.join(", ")}`);
  }

  // Include any other rules not already handled
  const handled = new Set(["format", "duration", "conditionalRules", "lastResort"]);
  for (const [key, value] of Object.entries(rules)) {
    if (!handled.has(key) && value !== null && value !== undefined) {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    }
  }

  return lines.join("\n");
}

function buildSessionContext(options: ComposeOptions): string {
  const parts: string[] = [];

  if (options.sessionId) parts.push(`Session ID: ${options.sessionId}`);
  if (options.role) parts.push(`Role: ${options.role}`);
  parts.push(`Host: ${options.hostName}`);

  // Timezone quick reference
  const tz = getUserTimezone(options.hostPreferences ?? null);
  const now = new Date();
  const currentTimeStr = now.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: tz,
  });
  parts.push(`[GROUND TRUTH] Current time: ${currentTimeStr}`);
  parts.push(`[GROUND TRUTH] Current year: ${now.toLocaleString("en-US", { year: "numeric", timeZone: tz })}`);
  parts.push(`[GROUND TRUTH] Quick reference: PDT = UTC-7, EDT = UTC-4, CDT = UTC-5, MDT = UTC-6, BST = UTC+1, JST = UTC+9`);

  if (options.isGroupEvent) {
    const participants = options.eventParticipants || [];
    const guestParticipants = participants.filter((p) => p.status !== undefined);
    parts.push(`Session type: Group event (${guestParticipants.length} participant${guestParticipants.length !== 1 ? "s" : ""} + host)`);
    if (guestParticipants.length > 0) {
      parts.push("Other participants and their status:");
      for (const p of guestParticipants) {
        const availNote = p.statedAvailability ? ` — ${p.statedAvailability}` : "";
        parts.push(`  - ${p.name} (${p.status}${availNote})`);
      }
    }
  }

  if (options.guestName) parts.push(`Guest: ${options.guestName}`);
  if (options.guestEmail) parts.push(`Guest email: ${options.guestEmail}`);
  if (options.guestTimezone) parts.push(`[GROUND TRUTH] Guest timezone (from browser): ${options.guestTimezone} — confirm with guest if different from host timezone`);
  if (options.topic) parts.push(`Topic: ${options.topic}`);

  if (options.rules && Object.keys(options.rules).length > 0) {
    parts.push(formatRules(options.rules));
  }

  // Scored slots → pre-formatted offerable blocks (preferred: prevents hallucination)
  if (options.scoredSlots && options.scoredSlots.length > 0 && options.calendarContext) {
    const linkRules = options.rules as LinkRules | undefined;
    parts.push(formatOfferableSlots(
      options.scoredSlots,
      options.calendarContext.timezone,
      options.calendarContext.canWrite,
      linkRules
    ));
  }
  // Fallback: raw events as daily calendar view (only if no scored slots)
  else if (options.calendarContext?.connected && options.calendarContext.events.length > 0) {
    parts.push(formatCalendarContext(options.calendarContext));
  }
  // Legacy fallback: old availableSlots format
  else if (options.availableSlots && options.availableSlots.length > 0) {
    const tz = getUserTimezone(options.hostPreferences ?? null);

    const tzLabel = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
      .formatToParts(new Date(options.availableSlots[0].start))
      .find((p) => p.type === "timeZoneName")?.value ?? tz;

    const timeFmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });

    parts.push(
      `[GROUND TRUTH] Available calendar slots for the host (${tzLabel}). Copy these day names, dates, and year exactly — do not recompute:\n${options.availableSlots
        .slice(0, 20)
        .map((s) => {
          const start = new Date(s.start);
          const end = new Date(s.end);
          const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(start);
          const startTime = timeFmt.format(start);
          const endTime = timeFmt.format(end);
          return `  ${day} ${startTime}–${endTime}`;
        })
        .join("\n")}`
    );
  }

  return parts.join("\n");
}

/**
 * Format CalendarContext as a daily event view for the AI.
 * No pre-computed availability — the AI reasons about what's open.
 */
export function formatCalendarContext(ctx: CalendarContext): string {
  const tz = ctx.timezone;

  const tzLabel = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? tz;

  // Compute the current UTC offset for this timezone (e.g., "-07:00" for PDT)
  // This is what the AI must use in CONFIRMATION_PROPOSAL dateTime fields
  const utcOffset = getUtcOffsetString(tz);

  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });

  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });

  // Group events by day
  const dayMap = new Map<string, CalendarEvent[]>();
  for (const ev of ctx.events) {
    const dayKey = dayFmt.format(ev.start);
    if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
    dayMap.get(dayKey)!.push(ev);
  }

  // Build explicit date-to-day mapping so the LLM never computes its own
  const dateKeys = Array.from(dayMap.keys());
  const dateMappingLines: string[] = [];
  if (dateKeys.length > 0) {
    // Also generate labels for dates between/around events (21-day window)
    const allDates = new Set<string>();
    const start = new Date(ctx.events[0]?.start ?? new Date());
    for (let i = 0; i < 21; i++) {
      const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      allDates.add(dayFmt.format(d));
    }
    Array.from(allDates).forEach((dk) => {
      dateMappingLines.push(dk);
    });
  }

  // Build daily view — also include days with no events in the range
  const lines: string[] = [
    `[GROUND TRUTH] Host's calendar (${tzLabel}, UTC offset: ${utcOffset}, IANA: ${tz}), calendars checked: ${ctx.calendars.join(", ")}.`,
    ``,
    `[GROUND TRUTH] DATE REFERENCE (system-computed, ALWAYS correct — includes year):`,
    ...(dateMappingLines.length > 0 ? dateMappingLines.map(d => `  ${d}`) : [`  (no events in range)`]),
    ``,
    `CRITICAL: When referring to ANY date, copy the day-of-week AND year from the DATE REFERENCE above. NEVER compute day-of-week or year yourself — LLMs get this wrong. If you write "Tuesday, Apr 15" but the reference says "Wed, Apr 15, 2026", you are WRONG. Always check the reference before writing any date.`,
    ``,
    `You decide what's available based on these events + the host knowledge base. No pre-computed slots — reason holistically.`,
    `When building a CONFIRMATION_PROPOSAL, use UTC offset "${utcOffset}" and timezone "${tz}" — e.g., "2026-04-03T16:00:00${utcOffset}".`,
    ``,
  ];

  for (const [day, events] of Array.from(dayMap)) {
    lines.push(`${day}:`);
    for (const ev of events) {
      if (ev.isAllDay) {
        const tags: string[] = [];
        if (ev.isTransparent) tags.push("FYI — does not block time");
        if (ev.responseStatus === "declined") tags.push("declined");
        if (ev.responseStatus === "tentative") tags.push("tentative");
        if (ev.calendar !== ctx.calendars[0]) tags.push(`from "${ev.calendar}"`);
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        lines.push(`  ${ev.summary} [all day${tagStr}]`);
      } else {
        const startStr = timeFmt.format(ev.start);
        const endStr = timeFmt.format(ev.end);
        const tags: string[] = [];
        if (ev.responseStatus === "declined") tags.push("declined");
        if (ev.responseStatus === "tentative") tags.push("tentative");
        if (ev.isTransparent) tags.push("FYI only");
        if (ev.location) tags.push(ev.location);
        if (ev.isRecurring) tags.push("recurring");
        if (ev.attendeeCount && ev.attendeeCount > 2) tags.push(`${ev.attendeeCount} attendees`);
        if (ev.calendar !== ctx.calendars[0]) tags.push(`from "${ev.calendar}"`);
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        lines.push(`  ${startStr}–${endStr} ${ev.summary}${tagStr}`);
      }
    }
  }

  if (!ctx.canWrite) {
    lines.push(
      "\nNote: Calendar is read-only (no write-capable provider connected). Confirmation will send an .ics email instead of creating a calendar event directly."
    );
  }

  return lines.join("\n");
}

// --- Computed Schedule Format (compact, scored) ---

import type { ScoredSlot, LinkRules } from "@/lib/scoring";
import { getTier, applyEventOverrides, filterByDuration } from "@/lib/scoring";

/**
 * Format a computed schedule (pre-scored slots) for the LLM prompt.
 * Groups slots by day, then by score tier: Preferred → Open → Soft → Protected.
 * Merges contiguous same-score slots into ranges for compactness.
 */
export function formatComputedSchedule(
  slots: ScoredSlot[],
  tz: string,
  canWrite: boolean,
  linkRules?: LinkRules
): string {
  const tzLabel = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? tz;

  const utcOffset = getUtcOffsetString(tz);

  // Apply event-level overrides if provided
  const finalSlots = linkRules ? applyEventOverrides(slots, linkRules, tz) : slots;

  // Group by day (include year in format)
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });

  const timeFmt = (date: Date): string => {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return m === 0 ? `${h}` : `${h}:${String(m).padStart(2, "0")}`;
  };

  const dayMap = new Map<string, ScoredSlot[]>();
  for (const slot of finalSlots) {
    const dayKey = dayFmt.format(new Date(slot.start));
    if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
    dayMap.get(dayKey)!.push(slot);
  }

  // Build explicit date-to-day mapping for the LLM
  const dateKeys = Array.from(dayMap.keys());
  const dateMappingLines: string[] = [];
  if (dateKeys.length > 0) {
    // Generate labels for 21-day window from first slot
    const firstSlotDate = new Date(finalSlots[0]?.start ?? new Date());
    const allDates = new Set<string>();
    for (let i = 0; i < 21; i++) {
      const d = new Date(firstSlotDate.getTime() + i * 24 * 60 * 60 * 1000);
      allDates.add(dayFmt.format(d));
    }
    Array.from(allDates).forEach((dk) => {
      dateMappingLines.push(dk);
    });
  }

  const lines: string[] = [
    `[GROUND TRUTH] Schedule (${tzLabel}, ${utcOffset}):`,
    ``,
    `[GROUND TRUTH] DATE REFERENCE (system-computed, ALWAYS correct — includes year):`,
    ...(dateMappingLines.length > 0 ? dateMappingLines.map(d => `  ${d}`) : [`  (no slots)`]),
    ``,
    `CRITICAL: When referring to ANY date, copy the day-of-week AND year from the DATE REFERENCE above. NEVER compute day-of-week or year yourself — LLMs get this wrong. Always check the reference before writing any date.`,
    ``,
    `[GROUND TRUTH] Use UTC offset "${utcOffset}" and timezone "${tz}" in CONFIRMATION_PROPOSAL — e.g., "2026-04-03T16:00:00${utcOffset}".`,
    `Protection scores: -2=exclusive (ONLY these), -1=preferred (offer first), 0=explicitly free, 1=open, 2=soft hold [low confidence], 3=moderate friction [low confidence], 4=protected (host only), 5=immovable.`,
    `Low-confidence scores (2,3): adjust based on context. Phone format = -1 friction. VIP guest = -1 friction.`,
  ];

  // Check for exclusive mode
  const hasExclusive = finalSlots.some((s) => s.score === -2);
  if (hasExclusive) {
    lines.push(`EXCLUSIVE MODE: Only offer Exclusive (-2) and Preferred (-1) slots. All other times are hidden from this guest.`);
  }
  lines.push(``);

  // Score tier labels and groupings
  const tiers = [
    { label: "Exclusive", min: -2, max: -2 },
    { label: "Preferred", min: -1, max: -1 },
    { label: "Open", min: 0, max: 1 },
    { label: "Soft", min: 2, max: 3 },
    { label: "Protected", min: 4, max: 5 },
  ];

  for (const [day, daySlots] of Array.from(dayMap)) {
    const tierLines: string[] = [];

    for (const tier of tiers) {
      const tierSlots = daySlots.filter(
        (s) => s.score >= tier.min && s.score <= tier.max
      );
      if (tierSlots.length === 0) continue;

      // Merge contiguous same-score slots into ranges
      const ranges = mergeSlotRanges(tierSlots, tz, timeFmt);
      const rangeStrs = ranges.map((r) => {
        const confStr = r.confidence === "low" ? ", low" : "";
        const summaryStr = r.eventSummary ? ` ${r.eventSummary}` : "";
        return `${r.timeRange}${summaryStr} [${r.score}${confStr}]`;
      });

      tierLines.push(`  ${tier.label}: ${rangeStrs.join(", ")}`);
    }

    if (tierLines.length > 0) {
      lines.push(`${day}:`);
      lines.push(...tierLines);
    }
  }

  if (!canWrite) {
    lines.push(
      "\nCalendar is read-only. Confirmation sends .ics email instead of creating event directly."
    );
  }

  return lines.join("\n");
}

/**
 * Format pre-computed offerable time blocks for the LLM prompt.
 * The LLM can ONLY suggest times from this list — no raw events, no score interpretation.
 * Groups consecutive 30-min slots into contiguous blocks labeled by tier.
 */
export function formatOfferableSlots(
  slots: ScoredSlot[],
  tz: string,
  canWrite: boolean,
  linkRules?: LinkRules
): string {
  const tzLabel = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? tz;

  const utcOffset = getUtcOffsetString(tz);

  // Apply event-level overrides if provided
  const overriddenSlots = linkRules ? applyEventOverrides(slots, linkRules, tz) : slots;

  // Filter to valid start positions for the meeting duration. A lone 30-min
  // slot can't host a 60-min meeting — the agent would propose a time that
  // bleeds into a blocked window. filterByDuration is a no-op for ≤ 30 min.
  // LinkRules doesn't type `duration` (it lives in the rules JSON blob) so we
  // cast through unknown to read it safely.
  const meetingDuration = ((linkRules as unknown as Record<string, unknown>)?.duration as number | undefined);
  const finalSlots = meetingDuration ? filterByDuration(overriddenSlots, meetingDuration) : overriddenSlots;

  const now = new Date();
  const rules = linkRules ?? {};

  // Check for exclusive mode
  const hasExclusive = finalSlots.some((s) => s.score === -2);

  // Bucket every slot by its tier using the new intrinsic scoring. First-
  // offer is the only tier any guest sees in the widget or in the initial
  // greeting; stretch1 and stretch2 are VIP-only and the LLM may reach
  // into them ONLY after guest pushback (see guardrails below).
  const firstOfferSlots: ScoredSlot[] = [];
  const stretch1Slots: ScoredSlot[] = [];
  const stretch2Slots: ScoredSlot[] = [];
  for (const s of finalSlots) {
    if (new Date(s.start) <= now) continue;
    // Exclusive mode: only -2/-1 host picks count, regardless of VIP.
    if (hasExclusive) {
      if (s.score <= 0) firstOfferSlots.push(s);
      continue;
    }
    const tier = getTier(s, rules, tz);
    if (tier === "first-offer") firstOfferSlots.push(s);
    else if (tier === "stretch1") stretch1Slots.push(s);
    else if (tier === "stretch2") stretch2Slots.push(s);
  }
  const chrono = (a: ScoredSlot, b: ScoredSlot) =>
    new Date(a.start).getTime() - new Date(b.start).getTime();
  firstOfferSlots.sort(chrono);
  stretch1Slots.sort(chrono);
  stretch2Slots.sort(chrono);

  if (firstOfferSlots.length === 0 && stretch1Slots.length === 0 && stretch2Slots.length === 0) {
    return [
      `[GROUND TRUTH] OFFERABLE SLOTS (${tzLabel}, UTC offset: ${utcOffset}, IANA: ${tz})`,
      `No offerable times in the current window. Ask the guest what times work for them and escalate to the host.`,
    ].join("\n");
  }

  // Formatters
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });

  // Compact time: "10 AM" not "10:00 AM", "3:30 PM" keeps minutes
  const timeFmt = (date: Date): string => {
    const raw = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    }).format(date);
    return raw.replace(/:00/g, "");
  };

  // Build day-grouped, contiguous-merged blocks for a given slot list.
  // All slots in a tier are presented uniformly — no per-slot "weekend" /
  // "off-hours" labels. The tier IS the framing; within a tier, slots
  // collapse into ranges the guest reads like any other availability.
  function renderTier(slots: ScoredSlot[]): string[] {
    if (slots.length === 0) return [];
    const dayMap = new Map<string, ScoredSlot[]>();
    for (const slot of slots) {
      const dayKey = dayFmt.format(new Date(slot.start));
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
      dayMap.get(dayKey)!.push(slot);
    }
    const out: string[] = [];
    for (const [day, daySlots] of Array.from(dayMap)) {
      interface OfferBlock { start: Date; end: Date; hasPreferred: boolean }
      const blocks: OfferBlock[] = [];
      let current: OfferBlock | null = null;
      for (const slot of daySlots) {
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        const isPreferred = slot.score <= 0;
        if (current && start.getTime() === current.end.getTime()) {
          current.end = end;
          if (isPreferred) current.hasPreferred = true;
        } else {
          if (current) blocks.push(current);
          current = { start, end, hasPreferred: isPreferred };
        }
      }
      if (current) blocks.push(current);
      out.push(`${day}:`);
      for (const b of blocks) {
        const star = b.hasPreferred ? "★ " : "";
        out.push(`  ${star}${timeFmt(b.start)}–${timeFmt(b.end)}`);
      }
    }
    return out;
  }

  // Date reference (21-day window) — computed from the earliest slot across
  // all tiers so stretch-only days still resolve correctly.
  const allSlots = [...firstOfferSlots, ...stretch1Slots, ...stretch2Slots].sort(chrono);
  const dateMappingLines: string[] = [];
  const firstSlotDate = new Date(allSlots[0].start);
  for (let i = 0; i < 21; i++) {
    const d = new Date(firstSlotDate.getTime() + i * 24 * 60 * 60 * 1000);
    dateMappingLines.push(`  ${dayFmt.format(d)}`);
  }

  const lines: string[] = [
    `[GROUND TRUTH] OFFERABLE SLOTS (${tzLabel}, UTC offset: ${utcOffset}, IANA: ${tz})`,
    `These are the times you may suggest to the guest. Do NOT invent or calculate other times.`,
    ``,
    `[GROUND TRUTH] DATE REFERENCE (system-computed, ALWAYS correct):`,
    ...dateMappingLines,
    ``,
    `CRITICAL: Copy day-of-week and year from DATE REFERENCE. NEVER compute them yourself.`,
    `Use UTC offset "${utcOffset}" and timezone "${tz}" in CONFIRMATION_PROPOSAL.`,
    ``,
  ];

  if (hasExclusive) {
    lines.push(`EXCLUSIVE MODE: Only the slots listed below are available for this guest.`);
    lines.push(``);
  }

  // Tier 1: first-offer — the widget's offering, always shown first.
  lines.push(`FIRST OFFER (widget + default availability):`);
  const firstOfferLines = renderTier(firstOfferSlots);
  if (firstOfferLines.length > 0) {
    lines.push(...firstOfferLines);
  } else {
    lines.push(`  (none — default window has no offerable times)`);
  }
  lines.push(``);

  // Tier 2: stretch 1 — VIP-only, surfaced on first round of guest pushback.
  if (rules.isVip && stretch1Slots.length > 0) {
    lines.push(`STRETCH OPTIONS (VIP — reach ONLY after first guest pushback):`);
    lines.push(
      `Present these as regular times. NEVER explain why they're "extra" — no references to weekends, focus time, early mornings, "making room", or any host context. Just offer the slot. If the guest accepts a specific stretch slot, you may propose a 48h tentative hold via [HOLD_SLOT] so it's protected from concurrent bookings.`
    );
    lines.push(...renderTier(stretch1Slots));
    lines.push(``);
  }

  // Tier 3: stretch 2 — VIP-only, surfaced on second round of pushback.
  if (rules.isVip && stretch2Slots.length > 0) {
    lines.push(`DEEP STRETCH OPTIONS (VIP — reach ONLY after a second round of guest pushback):`);
    lines.push(
      `These stretch further into the host's protected time. Present neutrally — no "host has made room" framing. Only reach here if STRETCH OPTIONS above have been exhausted. Hold mechanics same as stretch 1.`
    );
    lines.push(...renderTier(stretch2Slots));
    lines.push(``);
  }

  lines.push(`Legend: ★ = host's preferred times. All listed times are safe to propose within their tier — do not combine or promote between tiers without guest pushback.`);

  if (!canWrite) {
    lines.push(`Calendar is read-only. Confirmation sends .ics email instead of creating event directly.`);
  }

  return lines.join("\n");
}

interface MergedRange {
  timeRange: string;
  score: number;
  confidence: "high" | "low";
  eventSummary?: string;
}

function mergeSlotRanges(
  slots: ScoredSlot[],
  tz: string,
  timeFmt: (date: Date) => string
): MergedRange[] {
  if (slots.length === 0) return [];

  // Sort by start time
  const sorted = [...slots].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const ranges: MergedRange[] = [];
  let rangeStart = new Date(sorted[0].start);
  let rangeEnd = new Date(sorted[0].end);
  let currentScore = sorted[0].score;
  let currentConfidence = sorted[0].confidence;
  let currentSummary = sorted[0].eventSummary;

  for (let i = 1; i < sorted.length; i++) {
    const slot = sorted[i];
    const slotStart = new Date(slot.start);

    // Contiguous and same score/summary → extend range
    if (
      slotStart.getTime() === rangeEnd.getTime() &&
      slot.score === currentScore &&
      slot.eventSummary === currentSummary
    ) {
      rangeEnd = new Date(slot.end);
      // Take lowest confidence in range
      if (slot.confidence === "low") currentConfidence = "low";
    } else {
      // Flush current range
      ranges.push({
        timeRange: `${timeFmt(rangeStart)}–${timeFmt(rangeEnd)}`,
        score: currentScore,
        confidence: currentConfidence,
        eventSummary: currentSummary,
      });
      rangeStart = slotStart;
      rangeEnd = new Date(slot.end);
      currentScore = slot.score;
      currentConfidence = slot.confidence;
      currentSummary = slot.eventSummary;
    }
  }

  // Flush last range
  ranges.push({
    timeRange: `${timeFmt(rangeStart)}–${timeFmt(rangeEnd)}`,
    score: currentScore,
    confidence: currentConfidence,
    eventSummary: currentSummary,
  });

  return ranges;
}

// --- Timezone helpers ---

/**
 * Get the UTC offset string for an IANA timezone (e.g., "America/Los_Angeles" → "-07:00").
 * Uses Intl to compute the correct offset including DST.
 */
export function getUtcOffsetString(tz: string): string {
  const now = new Date();
  // Format a date in the target timezone and in UTC, compare to get offset
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  // offsetPart is like "GMT-07:00" or "GMT+05:30" or "GMT" (for UTC)
  const match = offsetPart.match(/GMT([+-]\d{2}:\d{2})/);
  if (match) return match[1]; // e.g., "-07:00"
  if (offsetPart === "GMT") return "+00:00";
  // Fallback: compute manually
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const diffMin = Math.round(diffMs / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const absMin = Math.abs(diffMin);
  const h = String(Math.floor(absMin / 60)).padStart(2, "0");
  const m = String(absMin % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

// --- Playbook metadata (for evals and debugging) ---

export function getPlaybookInfo(): Record<string, { loaded: boolean; length: number }> {
  return Object.fromEntries(
    Object.entries(playbooks).map(([name, content]) => [
      name,
      { loaded: content.length > 0, length: content.length },
    ])
  );
}
