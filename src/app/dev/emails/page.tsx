/**
 * /dev/emails — live email template preview + test-send tool.
 *
 * Renders all email templates with sample data. Click "Send test email" to
 * dispatch a real email to ADMIN_EMAIL (jsa7cornell@gmail.com) via the
 * dispatcher so it respects EFFECT_MODE_EMAIL.
 *
 * 404s in production.
 */

import { notFound } from "next/navigation";
import { buildGuestConfirmationEmail } from "@/lib/emails/guest-confirmation";
import { buildWelcomeEmail } from "@/lib/emails/welcome";
import { buildMeetingReminderEmail } from "@/lib/emails/meeting-reminder";
import { SendTestButton } from "./SendTestButton";

export const dynamic = "force-dynamic";

const SAMPLE_DATE = new Date("2026-05-01T18:00:00Z"); // 11am PDT

interface EmailPreview {
  id: string;
  name: string;
  recipients: string;
  trigger: string;
  subject: string;
  html: string;
}

function buildPreviews(): EmailPreview[] {
  const confirmation = buildGuestConfirmationEmail({
    hostName: "John Abramson",
    guestName: "Sarah Chen",
    topic: "Q2 Roadmap Review",
    dateTime: SAMPLE_DATE,
    duration: 30,
    format: "video",
    hostTimezone: "America/Los_Angeles",
    guestTimezone: "America/New_York",
    meetLink: "https://meet.google.com/abc-defg-hij",
    dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
  });

  const welcome = buildWelcomeEmail({
    firstName: "John",
    meetSlug: "johna",
  });

  const reminder = buildMeetingReminderEmail({
    guestName: "Sarah Chen",
    hostName: "John Abramson",
    whenLabel: "Thursday, May 1, 2026 at 11:00 AM",
    timezoneLabel: "PDT",
    durationLabel: "30 min",
    format: "video",
    meetLink: "https://meet.google.com/abc-defg-hij",
    dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
  });

  return [
    {
      id: "meeting-confirmed",
      name: "Meeting Confirmed",
      recipients: "Host + Guest",
      trigger: "POST /api/negotiate/confirm",
      ...confirmation,
    },
    {
      id: "welcome",
      name: "Welcome",
      recipients: "Host (new user)",
      trigger: "events.createUser in auth.ts",
      ...welcome,
    },
    {
      id: "meeting-reminder",
      name: "Meeting Reminder",
      recipients: "Guest",
      trigger: "/api/cron/daily Phase 4 — 24h before meeting",
      ...reminder,
    },
  ];
}

export default function EmailsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const previews = buildPreviews();

  return (
    <div style={{ fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: "32px", maxWidth: "900px", margin: "0 auto", color: "#1a1a2e" }}>
      <div style={{ marginBottom: "32px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 6px 0" }}>Email Templates</h1>
        <p style={{ margin: 0, color: "#666", fontSize: "14px" }}>
          Live previews built from real template functions with sample data.
          &ldquo;Send test email&rdquo; dispatches via the side-effect dispatcher to{" "}
          <strong>jsa7cornell@gmail.com</strong> — respects <code>EFFECT_MODE_EMAIL</code>.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "48px" }}>
        {previews.map((email) => (
          <div key={email.id}>
            {/* Header row */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
              <div>
                <h2 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 4px 0" }}>{email.name}</h2>
                <div style={{ fontSize: "12px", color: "#888", display: "flex", gap: "16px", flexWrap: "wrap" }}>
                  <span>To: <strong style={{ color: "#444" }}>{email.recipients}</strong></span>
                  <span>Subject: <strong style={{ color: "#444" }}>{email.subject}</strong></span>
                  <span>Trigger: <code style={{ background: "#f4f3fc", padding: "1px 4px", borderRadius: "3px", fontSize: "11px" }}>{email.trigger}</code></span>
                </div>
              </div>
              <SendTestButton templateId={email.id} />
            </div>

            {/* Email preview iframe */}
            <div style={{ border: "1px solid #e5e1fb", borderRadius: "10px", overflow: "hidden" }}>
              <iframe
                srcDoc={email.html}
                style={{ width: "100%", height: "520px", border: "none", display: "block" }}
                title={`Preview: ${email.name}`}
                sandbox=""
              />
            </div>
          </div>
        ))}
      </div>

      <p style={{ marginTop: "48px", fontSize: "12px", color: "#bbb", textAlign: "center" }}>
        /dev/emails · not available in production
      </p>
    </div>
  );
}
