/**
 * Welcome email — first email a new host receives after linking Google.
 *
 * Voice: short, warm, a little playful. Mirrors the Envoy persona —
 * concierge tone, no feature dump. Mirrors `buildConfirmationEmail`
 * structurally: inline CSS, mobile-friendly, purple accent.
 *
 * Fires from `events.createUser` in `src/lib/auth.ts` through
 * `dispatch({ kind: "email.send", ... })`. Idempotency gated by
 * `hasDispatchedFor({ kind: "email.send", userId, purpose: "welcome" })`
 * against SideEffectLog — replaces the deprecated `welcomeEmailSentAt`
 * column on User, which turned out to be the wrong place to track this
 * (see LOG 2026-04-17 schema drift incident).
 */

import { prisma } from "@/lib/prisma";
import { dispatch, hasDispatchedFor } from "@/lib/side-effects/dispatcher";

const BASE_URL = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";

export interface WelcomeEmailParams {
  /** Host's first name (or full name if we only have that). Optional — fallback is "there". */
  firstName?: string | null;
  /** The host's shareable meet slug, e.g. "johna". Required — the link is the whole point. */
  meetSlug: string;
}

export function buildWelcomeEmail(params: WelcomeEmailParams): { subject: string; html: string } {
  const greeting = params.firstName ? params.firstName : "there";
  const meetUrl = `${BASE_URL}/meet/${params.meetSlug}`;
  const meetLabel = `agentenvoy.ai/meet/${params.meetSlug}`;
  const dashboardUrl = `${BASE_URL}/dashboard`;
  const faqUrl = `${BASE_URL}/faq`;

  const subject = "Your AI negotiator is on duty";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1a1a2e;">
      <div style="text-align: center; margin-bottom: 28px;">
        <div style="font-size: 44px; margin-bottom: 8px;">🤝</div>
        <h1 style="font-size: 24px; font-weight: 700; margin: 0;">Hi ${escapeHtml(greeting)} — Envoy here.</h1>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 18px 0;">
        I'm your new scheduling concierge. Someone wants to grab time? Hand them this link and I'll take it from there —
        I read your calendar, negotiate the time, and drop it on both calendars when we're done.
      </p>

      <div style="background: #f4f3fc; border: 1px solid #e5e1fb; border-radius: 12px; padding: 18px 20px; margin: 0 0 22px 0; text-align: center;">
        <p style="margin: 0 0 6px 0; font-size: 12px; color: #6c5ce7; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;">Your shareable link</p>
        <p style="margin: 0;"><a href="${meetUrl}" style="color: #1a1a2e; font-size: 16px; font-weight: 600; text-decoration: none;">${escapeHtml(meetLabel)}</a></p>
      </div>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 18px 0;">
        A few things worth knowing, in order of usefulness:
      </p>

      <ul style="font-size: 14px; line-height: 1.7; margin: 0 0 22px 20px; padding: 0; color: #3a3a52;">
        <li>Your <a href="${dashboardUrl}" style="color: #6c5ce7; text-decoration: none; font-weight: 600;">dashboard</a> shows every conversation I'm having on your behalf.</li>
        <li><strong>Today's Insight</strong> (top of the dashboard) is my daily read of what's on your plate.</li>
        <li>The <a href="${faqUrl}" style="color: #6c5ce7; text-decoration: none; font-weight: 600;">FAQ</a> has the weird stuff — directives, office hours, VIP links.</li>
      </ul>

      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
        Go ahead and try it — open your link in a private window and pretend to be someone trying to schedule with you. It's worth the three minutes.
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
 * Gate + dispatch, idempotent. If a prior dispatch row for
 * `(email.send, userId, purpose: "welcome")` exists in SideEffectLog with
 * any terminal status EXCEPT `skipped` (sent/suppressed/dryrun/failed),
 * this is a no-op. `skipped` rows come from the `off` kill-switch and
 * should be retried once it's turned back on.
 *
 * The stamp lives in SideEffectLog itself — every `dispatch()` call
 * writes exactly one row, so the gate just queries that log. No per-email
 * columns on the User model. Safe to call from anywhere; the createUser
 * event in auth.ts is the production caller.
 */
export async function dispatchWelcomeEmailOnce(userId: string): Promise<
  { dispatched: true } | { dispatched: false; reason: "already_sent" | "missing_email" | "missing_slug" }
> {
  const alreadySent = await hasDispatchedFor({
    kind: "email.send",
    userId,
    purpose: "welcome",
  });
  if (alreadySent) return { dispatched: false, reason: "already_sent" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, meetSlug: true },
  });
  if (!user) return { dispatched: false, reason: "missing_email" };
  if (!user.email) return { dispatched: false, reason: "missing_email" };
  if (!user.meetSlug) return { dispatched: false, reason: "missing_slug" };

  const firstName = user.name?.split(/\s+/)[0] ?? null;
  const { subject, html } = buildWelcomeEmail({ firstName, meetSlug: user.meetSlug });
  await dispatch({
    kind: "email.send",
    to: user.email,
    subject,
    html,
    context: { userId, purpose: "welcome" },
  });
  return { dispatched: true };
}
