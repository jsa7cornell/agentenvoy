import { readFileSync } from "fs";
import { join } from "path";

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
  hostName: string;
  hostPreferences?: Record<string, unknown>;
  guestName?: string;
  guestEmail?: string;
  topic?: string;
  rules?: Record<string, unknown>;
  availableSlots?: Array<{ start: string; end: string }>;
  role?: string;
}

export function composeSystemPrompt(options: ComposeOptions): string {
  const sections: string[] = [];

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
    const prefsSection = formatPreferences(options.hostPreferences);
    if (prefsSection) {
      sections.push(`# Host Preferences\n\n${prefsSection}`);
    }
  }

  // Layer 5: Session Context
  const context = buildSessionContext(options);
  sections.push(`# Session Context\n\n${context}`);

  return sections.filter(Boolean).join("\n\n---\n\n");
}

function formatPreferences(prefs: Record<string, unknown>): string {
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

function buildSessionContext(options: ComposeOptions): string {
  const parts: string[] = [];

  if (options.role) parts.push(`Role: ${options.role}`);
  parts.push(`Host: ${options.hostName}`);

  if (options.guestName) parts.push(`Guest: ${options.guestName}`);
  if (options.guestEmail) parts.push(`Guest email: ${options.guestEmail}`);
  if (options.topic) parts.push(`Topic: ${options.topic}`);

  if (options.rules && Object.keys(options.rules).length > 0) {
    parts.push(`Special rules for this negotiation: ${JSON.stringify(options.rules)}`);
  }

  if (options.availableSlots && options.availableSlots.length > 0) {
    const tz =
      (options.hostPreferences?.explicit as Record<string, unknown> | undefined)?.timezone as string | undefined ??
      (options.hostPreferences?.timezone as string | undefined);
    const tzOpts = tz ? { timeZone: tz } : {};

    parts.push(
      `Available calendar slots (host):\n${options.availableSlots
        .slice(0, 20)
        .map((s) => {
          const start = new Date(s.start);
          const end = new Date(s.end);
          const dayLabel = start.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            ...tzOpts,
          });
          const startTime = start.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
            ...tzOpts,
          });
          const endTime = end.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            ...tzOpts,
          });
          return `  ${dayLabel}: ${startTime} – ${endTime} (${s.start})`;
        })
        .join("\n")}`
    );
  }

  return parts.join("\n");
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
