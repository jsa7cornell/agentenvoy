/**
 * Email sender — AWS SES wrapper.
 *
 * Replaces Resend. Uses SESv2 via the AWS SDK.
 *
 * Environment-aware behavior:
 *   - NODE_ENV !== "production": logs the email payload to console, does not send.
 *     This prevents dev and preview deploys from sending real emails.
 *   - NODE_ENV === "production": sends via SES.
 *
 * To force a real send in non-production (e.g., for staging smoke tests),
 * set MAILER_FORCE_SEND=true.
 */

import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";

const DEFAULT_REGION = "us-west-2";
const DEFAULT_FROM = "AgentEnvoy <noreply@agentenvoy.ai>";

export interface SendMailParams {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}

export interface SendMailResult {
  sent: boolean;
  messageId?: string;
  mocked?: boolean;
  error?: string;
}

let _client: SESv2Client | null = null;

function getClient(): SESv2Client {
  if (_client) return _client;

  const region = process.env.AWS_SES_REGION || DEFAULT_REGION;
  const accessKeyId = process.env.AWS_SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SES_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "SES credentials missing: set AWS_SES_ACCESS_KEY_ID and AWS_SES_SECRET_ACCESS_KEY",
    );
  }

  _client = new SESv2Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

/**
 * Send an email via SES. Non-blocking: callers should not depend on this
 * succeeding. Logs errors, never throws.
 */
export async function sendMail(params: SendMailParams): Promise<SendMailResult> {
  const toList = Array.isArray(params.to) ? params.to : [params.to];
  const from = params.from || DEFAULT_FROM;

  const isProd = process.env.NODE_ENV === "production";
  const forceSend = process.env.MAILER_FORCE_SEND === "true";

  if (!isProd && !forceSend) {
    console.log("[mailer:mock] would send email", {
      from,
      to: toList,
      subject: params.subject,
      htmlLength: params.html.length,
    });
    return { sent: true, mocked: true };
  }

  const input: SendEmailCommandInput = {
    FromEmailAddress: from,
    Destination: { ToAddresses: toList },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: params.html, Charset: "UTF-8" },
        },
      },
    },
    ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
  };

  try {
    const result = await getClient().send(new SendEmailCommand(input));
    return { sent: true, messageId: result.MessageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mailer] SES send failed:", message);
    return { sent: false, error: message };
  }
}
