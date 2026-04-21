/**
 * Read-only SES health probe for /api/admin/smoke.
 *
 * Lives in handlers/ because that's the blessed directory for SES SDK
 * imports (see .eslintrc no-restricted-imports). This probe only calls
 * GetAccountCommand — it never sends mail, so it does not belong behind
 * the dispatcher (which is for mutating side effects).
 */

import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";

export interface SesAccountProbeResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  sending_enabled?: boolean;
  max_send_rate?: number;
  sent_last_24h?: number;
  max_24h?: number;
  [key: string]: unknown;
}

export async function probeSesAccount(): Promise<SesAccountProbeResult> {
  const start = Date.now();
  const keyId = process.env.AWS_SES_ACCESS_KEY_ID;
  const secret = process.env.AWS_SES_SECRET_ACCESS_KEY;
  if (!keyId || !secret) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      detail: "SES credentials not set — skipping live check",
    };
  }
  try {
    const client = new SESv2Client({
      region: process.env.AWS_SES_REGION ?? "us-west-2",
      credentials: { accessKeyId: keyId, secretAccessKey: secret },
    });
    const account = await client.send(new GetAccountCommand({}));
    return {
      ok: true,
      latencyMs: Date.now() - start,
      sending_enabled: account.SendingEnabled ?? false,
      max_send_rate: account.SendQuota?.MaxSendRate,
      sent_last_24h: account.SendQuota?.SentLast24Hours,
      max_24h: account.SendQuota?.Max24HourSend,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
