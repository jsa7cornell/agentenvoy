/**
 * POST /api/admin/send-test-email
 *
 * OAuth-gated to ADMIN_EMAIL. Accepts a template ID and dispatches a real
 * test email to ADMIN_EMAIL via the side-effect dispatcher (respects
 * EFFECT_MODE_EMAIL). Used by /admin/emails.
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/admin-auth";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { buildGuestConfirmationEmail } from "@/lib/emails/guest-confirmation";
import { buildWelcomeEmail } from "@/lib/emails/welcome";
import { buildMeetingReminderEmail } from "@/lib/emails/meeting-reminder";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";

const SAMPLE_DATE = new Date("2026-05-01T18:00:00Z"); // 11am PDT

export async function POST(req: NextRequest) {
  if (!(await isAdminSession())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { templateId } = await req.json();

  let subject: string;
  let html: string;

  switch (templateId) {
    case "meeting-confirmed": {
      ({ subject, html } = buildGuestConfirmationEmail({
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
      }));
      subject = `[TEST] ${subject}`;
      break;
    }

    case "welcome": {
      ({ subject, html } = buildWelcomeEmail({
        firstName: "John",
        meetSlug: "johna",
      }));
      subject = `[TEST] ${subject}`;
      break;
    }

    case "meeting-reminder": {
      ({ subject, html } = buildMeetingReminderEmail({
        guestName: "Sarah Chen",
        hostName: "John Abramson",
        whenLabel: "Thursday, May 1, 2026 at 11:00 AM",
        timezoneLabel: "PDT",
        durationLabel: "30 min",
        format: "video",
        meetLink: "https://meet.google.com/abc-defg-hij",
        dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
      }));
      subject = `[TEST] ${subject}`;
      break;
    }

    default:
      return NextResponse.json({ error: `Unknown templateId: ${templateId}` }, { status: 400 });
  }

  const result = await dispatch({
    kind: "email.send",
    to: ADMIN_EMAIL,
    subject,
    html,
    context: { purpose: "dev_test", templateId },
  });

  return NextResponse.json({ status: result.status, to: ADMIN_EMAIL, templateId });
}
