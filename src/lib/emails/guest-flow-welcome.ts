/**
 * Guest-flow welcome email.
 *
 * Fires when a new user is created via the deal-room calendar-connect CTA
 * — i.e. they came here mid-scheduling and got an AgentEnvoy account as a
 * side-effect. Tone differs from the standard welcome email: the reader
 * did NOT set out to sign up, so we acknowledge that and frame the
 * account as "bonus, no action required."
 *
 * Dispatch is gated by hasDispatchedFor({ kind: "email.send", userId,
 * purpose: "guest_flow_welcome" }) so repeat sign-ins from the same user
 * won't re-email. Uses SideEffectLog as the idempotency gate per PLAYBOOK
 * Rule 13 — no extra column on User.
 */

import { prisma } from "@/lib/prisma";
import { dispatch, hasDispatchedFor } from "@/lib/side-effects/dispatcher";

const BASE_URL = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";

export interface GuestFlowWelcomeParams {
  firstName?: string | null;
  meetSlug: string;
  /** The host's name (of the meeting that triggered the signup). Helpful
   *  context — "you just connected your calendar to schedule with {hostName}." */
  triggeringHostName?: string | null;
}

export function buildGuestFlowWelcomeEmail(
  params: GuestFlowWelcomeParams,
): { subject: string; html: string } {
  const greeting = params.firstName ? params.firstName : "there";
  const meetUrl = `${BASE_URL}/meet/${params.meetSlug}`;
  const meetLabel = `agentenvoy.ai/meet/${params.meetSlug}`;
  const homeUrl = `${BASE_URL}/dashboard`;
  const linksUrl = `${BASE_URL}/dashboard/my-links`;

  const triggeredBy = params.triggeringHostName
    ? `While connecting your calendar to schedule with ${escapeHtml(params.triggeringHostName)}, you also set up your own AgentEnvoy account.`
    : `While connecting your calendar to book that meeting, you also set up your own AgentEnvoy account.`;

  const subject = "You got an AgentEnvoy account out of that";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a2e;">
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="font-size: 44px; margin-bottom: 8px;">🤝</div>
        <h1 style="font-size: 22px; font-weight: 700; margin: 0;">Hi ${escapeHtml(greeting)} — welcome.</h1>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 18px 0;">
        ${triggeredBy} No action required — your meeting is still on track.
        But as long as you're here, you now have an AI scheduling concierge of your own.
      </p>

      <div style="background: #f4f3fc; border: 1px solid #e5e1fb; border-radius: 12px; padding: 18px 20px; margin: 0 0 22px 0; text-align: center;">
        <p style="margin: 0 0 6px 0; font-size: 12px; color: #6c5ce7; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;">Your shareable link</p>
        <p style="margin: 0;"><a href="${meetUrl}" style="color: #1a1a2e; font-size: 16px; font-weight: 600; text-decoration: none;">${escapeHtml(meetLabel)}</a></p>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 18px 0;">
        Hand that link to anyone who wants to grab time with you.
        I'll read your calendar, negotiate the time, and put the meeting on both calendars when we're done.
      </p>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 22px 0;">
        When you have a minute, two places worth a look:
      </p>

      <ul style="font-size: 14px; line-height: 1.7; margin: 0 0 22px 20px; padding: 0; color: #3a3a52;">
        <li><a href="${homeUrl}" style="color: #6c5ce7; text-decoration: none; font-weight: 600;">Your AgentEnvoy</a> — set meeting length, buffers, and preferences (takes 60 seconds).</li>
        <li><a href="${linksUrl}" style="color: #6c5ce7; text-decoration: none; font-weight: 600;">My Links</a> — share your scheduling link and see what's happening on it.</li>
      </ul>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
        You can ignore this email entirely and nothing bad happens — the meeting you just booked still works the same. This is just the &ldquo;by the way, you have this now&rdquo; note.
      </p>

      <p style="text-align: center; font-size: 13px; color: #999; margin: 28px 0 0 0;">
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

/**
 * Gate + dispatch, idempotent by `(kind, userId, purpose: "guest_flow_welcome")`.
 * Called from `src/app/api/auth/guest-calendar/callback/route.ts` the first
 * time a guest-flow user is created. Returns early if already sent, missing
 * email, missing meetSlug.
 */
export async function dispatchGuestFlowWelcomeEmailOnce(
  userId: string,
  opts?: { triggeringHostName?: string | null },
): Promise<
  | { dispatched: true }
  | {
      dispatched: false;
      reason: "already_sent" | "missing_email" | "missing_slug" | "missing_user";
    }
> {
  const alreadySent = await hasDispatchedFor({
    kind: "email.send",
    userId,
    purpose: "guest_flow_welcome",
  });
  if (alreadySent) return { dispatched: false, reason: "already_sent" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, meetSlug: true },
  });
  if (!user) return { dispatched: false, reason: "missing_user" };
  if (!user.email) return { dispatched: false, reason: "missing_email" };
  if (!user.meetSlug) return { dispatched: false, reason: "missing_slug" };

  const firstName = user.name?.split(/\s+/)[0] ?? null;
  const { subject, html } = buildGuestFlowWelcomeEmail({
    firstName,
    meetSlug: user.meetSlug,
    triggeringHostName: opts?.triggeringHostName ?? null,
  });

  await dispatch({
    kind: "email.send",
    to: user.email,
    subject,
    html,
    context: { userId, purpose: "guest_flow_welcome" },
  });
  return { dispatched: true };
}
