import { readFileSync } from "fs";
import { join } from "path";
import type { CalendarContext, CalendarEvent } from "@/lib/calendar";

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
    if (explicit.location) items.push(`Default location: ${explicit.location}`);
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
    // Location: both Google workingLocation and preferences are signals — pass both if they differ
    const todayStr = new Date().toISOString().slice(0, 10);
    const prefLoc = explicit.currentLocation as { label: string; until?: string } | undefined;
    const activePrefLoc = prefLoc && (!prefLoc.until || prefLoc.until >= todayStr) ? prefLoc : undefined;

    if (calHostLocation && activePrefLoc) {
      const locNormalized = (s: string) => s.trim().toLowerCase();
      if (locNormalized(calHostLocation) === locNormalized(activePrefLoc.label)) {
        // Signals agree
        items.push(
          `Current location: ${activePrefLoc.label} (confirmed by both Google Calendar and preferences). Host is away from home base — no in-person unless guest is nearby.`
        );
      } else {
        // Signals conflict — surface both, let LLM apply playbook rules
        items.push(
          `Location signals conflict: Google Calendar working location says "${calHostLocation}", preferences say "${activePrefLoc.label}". If location matters for this meeting (in-person format, travel buffers), clarify with the host. If there is no active dialog (generic invite), be conservative and assume the host is traveling.`
        );
      }
    } else if (calHostLocation) {
      items.push(
        `Current location: ${calHostLocation} (Google Calendar working location). Host is away from home base — no in-person unless guest is nearby.`
      );
    } else if (activePrefLoc) {
      const untilStr = activePrefLoc.until ? ` (until ${activePrefLoc.until})` : "";
      items.push(
        `Current location: ${activePrefLoc.label}${untilStr} (host-stated preference). Host is away from home base — no in-person unless guest is nearby.`
      );
    }
    if (items.length > 0) {
      parts.push("**Explicit (host-stated):**\n" + items.map(i => `- ${i}`).join("\n"));
    }
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
  const tz =
    (options.hostPreferences?.explicit as Record<string, unknown> | undefined)?.timezone as string | undefined ??
    (options.hostPreferences?.timezone as string | undefined) ??
    "America/Los_Angeles";
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

  // New: CalendarContext — raw events as daily calendar view
  if (options.calendarContext?.connected && options.calendarContext.events.length > 0) {
    parts.push(formatCalendarContext(options.calendarContext));
  }
  // Legacy fallback: old availableSlots format
  else if (options.availableSlots && options.availableSlots.length > 0) {
    const tz =
      (options.hostPreferences?.explicit as Record<string, unknown> | undefined)?.timezone as string | undefined ??
      (options.hostPreferences?.timezone as string | undefined) ??
      "America/Los_Angeles";

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
import { applyEventOverrides } from "@/lib/scoring";

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
