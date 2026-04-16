/**
 * Email handler for the side-effect dispatcher.
 *
 * Wraps the AWS SESv2 SDK. Implements the four modes:
 *
 *   live       — send through SES
 *   allowlist  — send only if recipient matches EFFECT_ALLOW_EMAIL_DOMAINS
 *                (comma-separated list of domains); otherwise fall through to log
 *   log        — never contact SES; dispatcher writes a `suppressed` row
 *   dryrun     — same as log, but return a synthetic providerMessageId
 *
 * See RISK-MANAGEMENT.md §"Per-environment defaults".
 */

import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import type {
  EmailSendEffect,
  EffectMode,
  EmailSendResult,
} from "../types";

const DEFAULT_REGION = "us-west-2";
const DEFAULT_FROM = "AgentEnvoy <noreply@agentenvoy.ai>";

// Lazy-instantiated so missing creds don't explode at import time
// (important for `log`/`dryrun` environments where creds are absent by design).
let _client: SESv2Client | null = null;

function getSesClient(): SESv2Client {
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

/** Recipients are normalized to string[] for consistent handling. */
function normalizeRecipients(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

/** Domain-allowlist check. Matches on the RHS of `@`. */
function recipientAllowed(recipient: string, allowedDomains: string[]): boolean {
  const at = recipient.indexOf("@");
  if (at === -1) return false;
  const domain = recipient.slice(at + 1).toLowerCase();
  return allowedDomains.some((d) => d.toLowerCase() === domain);
}

function parseAllowDomains(): string[] {
  const raw = process.env.EFFECT_ALLOW_EMAIL_DOMAINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Thin wrapper around SESv2 SendEmail.
 * Returns the provider's MessageId. Throws on API failure.
 */
async function sendViaSes(effect: EmailSendEffect): Promise<string> {
  const toList = normalizeRecipients(effect.to);
  const from = effect.from || DEFAULT_FROM;
  const input: SendEmailCommandInput = {
    FromEmailAddress: from,
    Destination: { ToAddresses: toList },
    Content: {
      Simple: {
        Subject: { Data: effect.subject, Charset: "UTF-8" },
        Body: { Html: { Data: effect.html, Charset: "UTF-8" } },
      },
    },
    ...(effect.replyTo ? { ReplyToAddresses: [effect.replyTo] } : {}),
  };
  const result = await getSesClient().send(new SendEmailCommand(input));
  if (!result.MessageId) {
    throw new Error("SES returned no MessageId");
  }
  return result.MessageId;
}

/**
 * The mode-aware entry point called by the dispatcher.
 *
 * Returns a partial result — the dispatcher stamps `logId` and writes the
 * SideEffectLog row. The handler only decides what the terminal status is
 * and (when relevant) what external side effect happened.
 */
export interface EmailHandlerOutcome {
  status: EmailSendResult["status"];
  /** Echoed back to the dispatcher so it knows the effective mode (matters for allowlist→log fall-through). */
  effectiveMode: EffectMode;
  providerMessageId?: string;
  error?: string;
}

export async function handleEmail(
  effect: EmailSendEffect,
  mode: EffectMode,
): Promise<EmailHandlerOutcome> {
  if (mode === "off") {
    return { status: "skipped", effectiveMode: "off" };
  }

  if (mode === "log") {
    return { status: "suppressed", effectiveMode: "log" };
  }

  if (mode === "dryrun") {
    const fakeId = `dryrun-${crypto.randomUUID()}`;
    return {
      status: "dryrun",
      effectiveMode: "dryrun",
      providerMessageId: fakeId,
    };
  }

  if (mode === "allowlist") {
    const allowedDomains = parseAllowDomains();
    const recipients = normalizeRecipients(effect.to);
    // Require EVERY recipient to be on the allowlist. If any one isn't,
    // the safe default is to suppress the whole send.
    const allAllowed =
      allowedDomains.length > 0 &&
      recipients.every((r) => recipientAllowed(r, allowedDomains));
    if (!allAllowed) {
      return { status: "suppressed", effectiveMode: "log" };
    }
    // Fall through to live send for allowlisted recipients.
    try {
      const providerMessageId = await sendViaSes(effect);
      return { status: "sent", effectiveMode: "allowlist", providerMessageId };
    } catch (err) {
      return {
        status: "failed",
        effectiveMode: "allowlist",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // mode === "live"
  try {
    const providerMessageId = await sendViaSes(effect);
    return { status: "sent", effectiveMode: "live", providerMessageId };
  } catch (err) {
    return {
      status: "failed",
      effectiveMode: "live",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Human-readable target for SideEffectLog.targetSummary. */
export function summarizeEmailTarget(effect: EmailSendEffect): string {
  const to = normalizeRecipients(effect.to);
  if (to.length === 1) return to[0];
  if (to.length <= 3) return to.join(", ");
  return `${to[0]}, +${to.length - 1} more`;
}

/**
 * Exported for tests only — resets the memoized client so tests can
 * assert behavior under different env var configurations.
 */
export function __resetEmailHandlerForTests(): void {
  _client = null;
}
