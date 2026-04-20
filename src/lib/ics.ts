/**
 * Minimal RFC 5545 VCALENDAR builder for the .ics fallback flow (T3c).
 *
 * When a host hasn't granted `calendar.events` write access, we can't put
 * the agreed meeting on their Google Calendar. Instead, we hand them an
 * .ics file they can drop into any calendar client. This is the
 * "degrade-not-block" floor — they still get a confirmed meeting, just
 * without the auto-add convenience.
 *
 * Scope is intentionally tiny: VEVENT, no recurrence, no alarms, no
 * attendees beyond ORGANIZER + ATTENDEE lines for the host and guest.
 * Anything richer (RSVP tracking, METHOD:REQUEST inbox routing) belongs
 * in a separate proposal — for now this just needs to open in a calendar
 * app and show the right time.
 */

export interface IcsEvent {
  /** Stable per-meeting identifier (use sessionId — never changes). */
  uid: string;
  startUtc: Date;
  endUtc: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  meetLink?: string | null;
  organizer?: { name?: string | null; email: string };
  attendees?: Array<{ name?: string | null; email: string }>;
}

/**
 * Format a Date as the ICS UTC timestamp `YYYYMMDDTHHMMSSZ`.
 * Always emits UTC — clients localize on display, and UTC dodges every
 * DST/timezone-string compatibility wart we'd otherwise run into.
 */
function fmtIcsUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/**
 * Escape per RFC 5545 §3.3.11: backslash, comma, semicolon, and newlines
 * get backslash-escaped. Newlines become literal `\n`.
 */
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Fold long content lines per RFC 5545 §3.1 — 75 octet soft limit, CRLF +
 * single-space continuation. Keeps Outlook + Apple Calendar happy on
 * descriptions that include long URLs.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  while (i < line.length) {
    chunks.push((i === 0 ? "" : " ") + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join("\r\n");
}

export function buildIcs(event: IcsEvent): string {
  const now = new Date();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AgentEnvoy//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}@agentenvoy.ai`,
    `DTSTAMP:${fmtIcsUtc(now)}`,
    `DTSTART:${fmtIcsUtc(event.startUtc)}`,
    `DTEND:${fmtIcsUtc(event.endUtc)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];

  const descParts: string[] = [];
  if (event.description) descParts.push(event.description);
  if (event.meetLink) descParts.push(`Join: ${event.meetLink}`);
  if (descParts.length > 0) {
    lines.push(`DESCRIPTION:${escapeIcsText(descParts.join("\n\n"))}`);
  }

  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }

  if (event.organizer) {
    const namePart = event.organizer.name
      ? `;CN=${escapeIcsText(event.organizer.name)}`
      : "";
    lines.push(`ORGANIZER${namePart}:mailto:${event.organizer.email}`);
  }

  for (const a of event.attendees ?? []) {
    const namePart = a.name ? `;CN=${escapeIcsText(a.name)}` : "";
    lines.push(
      `ATTENDEE${namePart};RSVP=FALSE;PARTSTAT=ACCEPTED:mailto:${a.email}`,
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
