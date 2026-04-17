/**
 * POST /api/dev/send-test-email
 *
 * Dev-only endpoint. Accepts an email template ID and dispatches a real test
 * email to ADMIN_EMAIL (defaults to jsa7cornell@gmail.com). Blocked in
 * production — this is purely for the /dev/emails preview tool.
 */

import { NextRequest, NextResponse } from "next/server";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { buildGuestConfirmationEmail } from "@/lib/emails/guest-confirmation";
import { buildWelcomeEmail } from "@/lib/emails/welcome";
import { buildMeetingReminderEmail } from "@/lib/emails/meeting-reminder";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";

// Sample data used for all test sends
const SAMPLE_DATE = new Date("2026-05-01T18:00:00Z"); // 11am PDT

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
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
