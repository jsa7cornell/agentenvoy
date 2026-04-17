/**
 * Guest meeting confirmation email — sent to the guest (and CC'd to host for
 * group events) immediately on `POST /api/negotiate/confirm`. This email stays
 * on the critical path — guests expect it instantly.
 *
 * Shows the meeting time in the guest's captured timezone first; if the host's
 * timezone differs, shows the host's local time as a secondary line so the
 * guest can coordinate without confusion.
 *
 * All user-controlled strings (topic, location, hostName, guestName, meetLink)
 * are HTML-escaped before insertion.
 */

export interface GuestConfirmationEmailParams {
  hostName: string;
  guestName?: string | null;
  topic?: string | null;
  dateTime: Date;
  duration: number;
  format: string;
  location?: string | null;
  meetLink?: string | null;
  /** Host's IANA timezone — canonical for the booking. */
  hostTimezone: string;
  /** Guest's IANA timezone captured from their browser, if available. */
  guestTimezone?: string | null;
  dealRoomUrl?: string | null;
}

export function buildGuestConfirmationEmail(
  p: GuestConfirmationEmailParams,
): { subject: string; html: string } {
  // Display in guest's tz if we have it; fall back to host's.
  const displayTz = p.guestTimezone || p.hostTimezone;
  const showHostTime = p.guestTimezone && p.guestTimezone !== p.hostTimezone;

  const guestDateLabel = formatDate(p.dateTime, displayTz);
  const guestTimeLabel = formatTime(p.dateTime, displayTz);
  const guestTzAbbr = tzAbbr(displayTz, p.dateTime);

  const hostTimeLabel = showHostTime
    ? `${formatTime(p.dateTime, p.hostTimezone)} ${tzAbbr(p.hostTimezone, p.dateTime)}`
    : null;

  const formatDisplay = p.format.charAt(0).toUpperCase() + p.format.slice(1);

  const subject = p.topic
    ? `Meeting confirmed: ${p.topic}`
    : "Meeting confirmed";

  const greeting = p.guestName ? `Hi ${escapeHtml(p.guestName)} —` : "Hi there —";

  const joinButton = p.meetLink
    ? `<div style="text-align:center;margin:0 0 20px 0;">
        <a href="${escapeHtml(p.meetLink)}" style="display:inline-block;padding:11px 26px;background:#6c5ce7;border-radius:8px;color:#fff;font-size:14px;font-weight:600;text-decoration:none;">Join Meeting</a>
      </div>`
    : "";

  const dealRoomLine = p.dealRoomUrl
    ? `<p style="text-align:center;font-size:13px;margin:0 0 20px 0;">
        Need to change or cancel? <a href="${escapeHtml(p.dealRoomUrl)}" style="color:#6c5ce7;font-weight:600;text-decoration:none;">Open your deal room</a>
      </p>`
    : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a2e;">
      <div style="text-align:center;margin-bottom:28px;">
        <div style="font-size:48px;margin-bottom:8px;">✅</div>
        <h1 style="font-size:22px;font-weight:700;margin:0;">${greeting} you're confirmed.</h1>
      </div>

      <div style="background:#f4f3fc;border:1px solid #e5e1fb;border-radius:12px;padding:18px 20px;margin:0 0 22px 0;">
        ${p.topic ? `<p style="margin:0 0 12px 0;font-size:15px;font-weight:600;">${escapeHtml(p.topic)}</p>` : ""}
        <p style="margin:0 0 8px 0;color:#444;font-size:14px;">with <strong>${escapeHtml(p.hostName)}</strong></p>
        <p style="margin:0 0 8px 0;color:#444;font-size:14px;">📅 ${escapeHtml(guestDateLabel)}</p>
        <p style="margin:0 0 8px 0;color:#444;font-size:14px;">🕐 ${escapeHtml(guestTimeLabel)} ${escapeHtml(guestTzAbbr)} · ${p.duration} min · ${escapeHtml(formatDisplay)}</p>
        ${hostTimeLabel ? `<p style="margin:0 0 8px 0;color:#999;font-size:12px;">Host's time: ${escapeHtml(hostTimeLabel)}</p>` : ""}
        ${p.location ? `<p style="margin:0 0 8px 0;color:#444;font-size:14px;">📍 ${escapeHtml(p.location)}</p>` : ""}
        ${p.meetLink ? `<p style="margin:0;font-size:14px;"><a href="${escapeHtml(p.meetLink)}" style="color:#6c5ce7;font-weight:600;text-decoration:none;">${escapeHtml(p.meetLink)}</a></p>` : ""}
      </div>

      ${joinButton}
      ${dealRoomLine}

      <p style="text-align:center;font-size:13px;color:#999;margin:24px 0 0 0;">
        — Envoy · <a href="https://agentenvoy.ai" style="color:#6c5ce7;text-decoration:none;">AgentEnvoy</a>
      </p>
    </div>
  `;

  return { subject, html };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date, tz: string): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tz,
  });
}

function formatTime(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

function tzAbbr(tz: string, d: Date): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? tz
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
