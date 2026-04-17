/**
 * Host booking-confirmed email — the ONE email the host receives on every
 * confirmation. Replaces both the old "Meeting Confirmed" (host copy) and the
 * separate "Host New Booking" alert. Fires fire-and-forget from
 * `POST /api/negotiate/confirm` so it never delays the guest's response.
 *
 * Includes a live "Also on your schedule" section built from upcoming confirmed
 * meetings and active pending negotiations — data fetched in the confirm route's
 * parallel task block before the response is sent.
 *
 * Dual-timezone: shows host's time prominently; if the guest's captured timezone
 * differs, shows guest's local time as a secondary line.
 *
 * All user-controlled strings are HTML-escaped.
 */

export interface UpcomingMeeting {
  agreedTime: Date;
  guestDisplay: string;
  duration: number;
  format: string;
}

export interface PendingSession {
  guestDisplay: string;
  topic?: string | null;
  updatedAt: Date;
}

export interface HostBookingConfirmedParams {
  hostFirstName?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  topic?: string | null;
  dateTime: Date;
  duration: number;
  format: string;
  location?: string | null;
  meetLink?: string | null;
  hostTimezone: string;
  guestTimezone?: string | null;
  dealRoomUrl: string;
  upcoming: UpcomingMeeting[];
  pending: PendingSession[];
}

export function buildHostBookingConfirmedEmail(
  p: HostBookingConfirmedParams,
): { subject: string; html: string } {
  const greeting = p.hostFirstName ? escapeHtml(p.hostFirstName) : "there";
  const guestDisplay = p.guestName || p.guestEmail || "Someone";

  const showGuestTime = p.guestTimezone && p.guestTimezone !== p.hostTimezone;
  const hostDateLabel = formatDate(p.dateTime, p.hostTimezone);
  const hostTimeLabel = formatTime(p.dateTime, p.hostTimezone);
  const hostTzLabel = tzAbbr(p.hostTimezone, p.dateTime);
  const guestTimeLine = showGuestTime
    ? `<p style="margin:0 0 8px 0;color:#999;font-size:12px;">Guest's time: ${escapeHtml(formatTime(p.dateTime, p.guestTimezone!))} ${escapeHtml(tzAbbr(p.guestTimezone!, p.dateTime))}</p>`
    : "";

  const formatDisplay = p.format.charAt(0).toUpperCase() + p.format.slice(1);

  const guestEmailLine =
    p.guestEmail && p.guestName
      ? `Their email is <a href="mailto:${escapeHtml(p.guestEmail)}" style="color:#6c5ce7;text-decoration:none;">${escapeHtml(p.guestEmail)}</a>.`
      : p.guestEmail
      ? `Email: <a href="mailto:${escapeHtml(p.guestEmail)}" style="color:#6c5ce7;text-decoration:none;">${escapeHtml(p.guestEmail)}</a>.`
      : "";

  const subject = p.guestName
    ? `New meeting confirmed: ${escapeHtml(p.guestName)}`
    : "New meeting confirmed";

  const scheduleSection = buildScheduleSection(p.upcoming, p.pending, p.hostTimezone);

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a2e;">
      <div style="text-align:center;margin-bottom:28px;">
        <div style="font-size:44px;margin-bottom:8px;">📅</div>
        <h1 style="font-size:22px;font-weight:700;margin:0;">Hey ${greeting} — new meeting confirmed.</h1>
      </div>

      <p style="font-size:15px;line-height:1.6;margin:0 0 18px 0;">
        <strong>${escapeHtml(guestDisplay)}</strong> just booked. ${guestEmailLine}
      </p>

      <div style="background:#f4f3fc;border:1px solid #e5e1fb;border-radius:12px;padding:18px 20px;margin:0 0 22px 0;">
        ${p.topic ? `<p style="margin:0 0 10px 0;font-size:15px;font-weight:600;">${escapeHtml(p.topic)}</p>` : ""}
        <p style="margin:0 0 8px 0;color:#444;font-size:14px;">📅 ${escapeHtml(hostDateLabel)}</p>
        <p style="margin:0 0 8px 0;color:#444;font-size:14px;">🕐 ${escapeHtml(hostTimeLabel)} ${escapeHtml(hostTzLabel)} · ${p.duration} min · ${escapeHtml(formatDisplay)}</p>
        ${guestTimeLine}
        ${p.location ? `<p style="margin:0 0 8px 0;color:#444;font-size:14px;">📍 ${escapeHtml(p.location)}</p>` : ""}
        ${p.meetLink ? `<p style="margin:0;font-size:14px;"><a href="${escapeHtml(p.meetLink)}" style="color:#6c5ce7;font-weight:600;text-decoration:none;">${escapeHtml(p.meetLink)}</a></p>` : ""}
      </div>

      <div style="text-align:center;margin:0 0 24px 0;">
        <a href="${escapeHtml(p.dealRoomUrl)}" style="display:inline-block;padding:11px 26px;background:#6c5ce7;border-radius:8px;color:#fff;font-size:14px;font-weight:600;text-decoration:none;">View Deal Room</a>
      </div>

      ${scheduleSection}

      <p style="text-align:center;font-size:13px;color:#999;margin:24px 0 0 0;">
        — Envoy · <a href="https://agentenvoy.ai" style="color:#6c5ce7;text-decoration:none;">AgentEnvoy</a>
      </p>
    </div>
  `;

  return { subject, html };
}

function buildScheduleSection(
  upcoming: UpcomingMeeting[],
  pending: PendingSession[],
  hostTimezone: string,
): string {
  if (upcoming.length === 0 && pending.length === 0) return "";

  const upcomingRows = upcoming
    .map((m) => {
      const timeStr = fmtUpcoming(m.agreedTime, hostTimezone);
      const fmt = m.format.charAt(0).toUpperCase() + m.format.slice(1);
      return `<li style="padding:6px 0;border-bottom:1px solid #f0eef7;font-size:13px;color:#444;">
        ${escapeHtml(timeStr)} · <strong>${escapeHtml(m.guestDisplay)}</strong> · ${m.duration} min ${escapeHtml(fmt)}
      </li>`;
    })
    .join("");

  const pendingRows = pending
    .map((s) => {
      const ago = fmtRelative(s.updatedAt);
      const detail = s.topic ? ` — ${escapeHtml(s.topic)}` : "";
      return `<li style="padding:6px 0;border-bottom:1px solid #f0eef7;font-size:13px;color:#444;">
        <strong>${escapeHtml(s.guestDisplay)}</strong>${detail} <span style="color:#999;">(${ago})</span>
      </li>`;
    })
    .join("");

  return `
    <div style="border-top:1px solid #e5e1fb;padding-top:20px;margin-bottom:20px;">
      <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#999;margin:0 0 12px 0;">Also on your schedule</p>
      ${upcoming.length > 0 ? `
        <p style="font-size:12px;color:#666;margin:0 0 6px 0;">Upcoming confirmed</p>
        <ul style="list-style:none;margin:0 0 16px 0;padding:0;">${upcomingRows}</ul>
      ` : ""}
      ${pending.length > 0 ? `
        <p style="font-size:12px;color:#666;margin:0 0 6px 0;">Pending negotiations</p>
        <ul style="list-style:none;margin:0;padding:0;">${pendingRows}</ul>
      ` : ""}
    </div>
  `;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtUpcoming(date: Date, tz: string): string {
  const now = new Date();
  const diffDays = Math.floor((date.getTime() - now.getTime()) / 86400000);
  const t = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  if (diffDays === 0) return `Today at ${t}`;
  if (diffDays === 1) return `Tomorrow at ${t}`;
  const d = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  return `${d} at ${t}`;
}

function fmtRelative(date: Date): string {
  const diffH = Math.floor((Date.now() - date.getTime()) / 3600000);
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

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
