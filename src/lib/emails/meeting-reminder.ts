/**
 * Guest meeting reminder email — sent ~24h before the agreed meeting time.
 *
 * Fires from the daily cron (`/api/cron/daily` Phase 4) for sessions where:
 *   - status === "agreed"
 *   - archived === false
 *   - wantsReminder === true  (new column on NegotiationSession, default true)
 *   - agreedTime is between now+23h and now+25h
 *
 * Idempotency: `hasDispatchedFor({ kind: "email.send", sessionId, purpose:
 * "meeting_reminder" })` guards against double-send if the cron runs more
 * than once in a 2-hour window. Note: hasDispatchedFor() takes userId; the
 * cron uses a sessionId-keyed raw query instead — see daily/route.ts Phase 4.
 *
 * Voice: friendly, concise. Assumes the guest already knows the context — no
 * need to re-explain who AgentEnvoy is. Surface the join link or location
 * prominently so they're not hunting for it tomorrow.
 */

export interface MeetingReminderEmailParams {
  /** Guest's display name (from session link) or fallback. */
  guestName?: string | null;
  /** Host's display name. */
  hostName: string;
  /** Pre-formatted date + time string, e.g. "Saturday, April 19, 2026 at 10:00 AM". */
  whenLabel: string;
  /** Short timezone label, e.g. "PDT". */
  timezoneLabel: string;
  /** Duration string, e.g. "45 min". */
  durationLabel: string;
  /** Meeting format, e.g. "video", "phone", "in-person". */
  format: string;
  /** Physical location or phone number if format is phone/in-person. May be null. */
  location?: string | null;
  /** Google Meet / Zoom URL if format is video. May be null. */
  meetLink?: string | null;
  /** URL to the deal room. */
  dealRoomUrl: string;
}

export function buildMeetingReminderEmail(
  params: MeetingReminderEmailParams,
): { subject: string; html: string } {
  const guestGreeting = params.guestName ? `Hi ${escapeHtml(params.guestName)} —` : "Just a heads-up —";
  const formatDisplay =
    params.format.charAt(0).toUpperCase() + params.format.slice(1);

  const joinSection = params.meetLink
    ? `
      <div style="text-align: center; margin-bottom: 20px;">
        <a href="${escapeHtml(params.meetLink)}" style="display: inline-block; padding: 11px 26px; background: #6c5ce7; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none;">Join Meeting</a>
      </div>
    `
    : "";

  const locationLine = params.location && !params.meetLink
    ? `<p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">📍 ${escapeHtml(params.location)}</p>`
    : "";

  const subject = `Reminder: meeting with ${escapeHtml(params.hostName)} tomorrow`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a2e;">
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="font-size: 44px; margin-bottom: 8px;">🔔</div>
        <h1 style="font-size: 22px; font-weight: 700; margin: 0;">${guestGreeting} your meeting is tomorrow.</h1>
      </div>

      <div style="background: #f4f3fc; border: 1px solid #e5e1fb; border-radius: 12px; padding: 18px 20px; margin: 0 0 22px 0;">
        <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;"><strong>${escapeHtml(params.hostName)}</strong></p>
        <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">📅 ${escapeHtml(params.whenLabel)} ${escapeHtml(params.timezoneLabel)}</p>
        <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">⏱ ${escapeHtml(params.durationLabel)} · ${escapeHtml(formatDisplay)}</p>
        ${locationLine}
        ${params.meetLink ? `<p style="margin: 0; font-size: 14px;"><a href="${escapeHtml(params.meetLink)}" style="color: #6c5ce7; font-weight: 600; text-decoration: none;">${escapeHtml(params.meetLink)}</a></p>` : ""}
      </div>

      ${joinSection}

      <p style="font-size: 14px; line-height: 1.6; margin: 0 0 18px 0; text-align: center;">
        Need to change or cancel?
        <a href="${escapeHtml(params.dealRoomUrl)}" style="color: #6c5ce7; text-decoration: none; font-weight: 600;">Open your deal room</a>
      </p>

      <p style="text-align: center; font-size: 13px; color: #999; margin: 20px 0 0 0;">
        — Envoy · <a href="https://agentenvoy.ai" style="color: #6c5ce7; text-decoration: none;">AgentEnvoy</a>
      </p>
    </div>
  `;

  return { subject, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
