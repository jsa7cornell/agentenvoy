/**
 * Host new-booking email — notifies the host when a guest books via a
 * generic link or an office-hours rule.
 *
 * Fires from `POST /api/negotiate/confirm` in parallel with the guest
 * confirmation email, but only for generic links and office-hours links
 * (where the host had no prior context about the invitee). Contextual
 * links are skipped — the host already knew the invite was out.
 *
 * Gate: `link.type === "generic"` OR `link.sourceRuleId` is set.
 * The dispatch does NOT use hasDispatchedFor() — each booking is a
 * distinct event and hosts should hear about every one.
 *
 * Voice: short, informational. Mirrors the concierge tone of welcome.ts.
 */

const BASE_URL = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";

export interface HostNewBookingEmailParams {
  /** Host's first name (or fallback "there"). */
  hostFirstName?: string | null;
  /** Guest's display name as captured by the session link. */
  guestName?: string | null;
  /** Guest's email address. May be null for guests who didn't provide one. */
  guestEmail?: string | null;
  /** Meeting topic (from the link). May be null for generic links. */
  topic?: string | null;
  /** Pre-formatted date + time string, e.g. "Friday, April 18, 2026 at 2:00 PM". */
  whenLabel: string;
  /** Short timezone label, e.g. "PDT". */
  timezoneLabel: string;
  /** Duration string, e.g. "30 min". */
  durationLabel: string;
  /** Meeting format, e.g. "video", "phone", "in-person". */
  format: string;
  /** URL to the deal room for this session. */
  dealRoomUrl: string;
}

export function buildHostNewBookingEmail(
  params: HostNewBookingEmailParams,
): { subject: string; html: string } {
  const greeting = params.hostFirstName ? params.hostFirstName : "there";
  const guestDisplay = params.guestName || params.guestEmail || "Someone";
  const topicLine = params.topic
    ? `<p style="margin: 0 0 8px 0; color: #666; font-size: 14px;"><strong>Topic:</strong> ${escapeHtml(params.topic)}</p>`
    : "";
  const formatDisplay =
    params.format.charAt(0).toUpperCase() + params.format.slice(1);

  const subject = params.guestName
    ? `New booking: ${escapeHtml(params.guestName)} — ${params.whenLabel}`
    : `New booking — ${params.whenLabel}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a2e;">
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="font-size: 44px; margin-bottom: 8px;">📅</div>
        <h1 style="font-size: 22px; font-weight: 700; margin: 0;">Hey ${escapeHtml(greeting)} — new booking.</h1>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 18px 0;">
        <strong>${escapeHtml(guestDisplay)}</strong> just confirmed a meeting with you.
        ${params.guestEmail && params.guestName
          ? `Their email is <a href="mailto:${escapeHtml(params.guestEmail)}" style="color: #6c5ce7; text-decoration: none;">${escapeHtml(params.guestEmail)}</a>.`
          : ""}
      </p>

      <div style="background: #f4f3fc; border: 1px solid #e5e1fb; border-radius: 12px; padding: 18px 20px; margin: 0 0 22px 0;">
        <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">📅 ${escapeHtml(params.whenLabel)} ${escapeHtml(params.timezoneLabel)}</p>
        <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">⏱ ${escapeHtml(params.durationLabel)} · ${escapeHtml(formatDisplay)}</p>
        ${topicLine}
      </div>

      <div style="text-align: center; margin-bottom: 20px;">
        <a href="${escapeHtml(params.dealRoomUrl)}" style="display: inline-block; padding: 11px 26px; background: #6c5ce7; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none;">View Deal Room</a>
      </div>

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
