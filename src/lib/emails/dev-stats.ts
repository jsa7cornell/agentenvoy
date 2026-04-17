/**
 * Dev-stats daily digest — one-recipient transactional email to the creator.
 *
 * Not a generic "digest system." Deliberately single-recipient. Numbers over
 * prose; no narrative. The point is a glanceable "is the product alive?"
 * signal every morning. Anything that needs charts or alerting moves to
 * /admin/failures or (eventually) a real observability tool — not this.
 *
 * Fires from the Vercel cron at /api/cron/dev-stats through dispatch().
 */

export interface DevStatsRow {
  label: string;
  value: number;
}

export interface DevStatsFormatBreakdown {
  format: string;
  count: number;
}

export interface DevStatsFailure {
  kind: string;
  count: number;
}

export interface DevStatsParams {
  /** Window end (inclusive, usually "now"). */
  windowEnd: Date;
  /** Window start (exclusive). 24h before windowEnd for the daily cadence. */
  windowStart: Date;
  newUsers: number;
  sessionsCreated: number;
  sessionsConfirmed: number;
  sessionsCancelled: number;
  sessionsExpired: number;
  sessionsEscalated: number;
  formatBreakdown: DevStatsFormatBreakdown[];
  failures: DevStatsFailure[];
  totalFailures: number;
}

export function buildDevStatsEmail(p: DevStatsParams): { subject: string; html: string } {
  const dateLabel = p.windowEnd.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
  const subject = `AgentEnvoy daily · ${dateLabel}`;

  const coreRows: DevStatsRow[] = [
    { label: "New users", value: p.newUsers },
    { label: "Sessions created", value: p.sessionsCreated },
    { label: "Sessions confirmed", value: p.sessionsConfirmed },
    { label: "Sessions cancelled", value: p.sessionsCancelled },
    { label: "Sessions expired", value: p.sessionsExpired },
    { label: "Sessions escalated", value: p.sessionsEscalated },
  ];

  const coreRowsHtml = coreRows.map(statRow).join("");

  const formatRowsHtml = p.formatBreakdown.length
    ? p.formatBreakdown
        .map((f) => statRow({ label: `  ${f.format}`, value: f.count }))
        .join("")
    : `<tr><td colspan="2" style="padding: 6px 0; color: #999; font-size: 13px;">(none)</td></tr>`;

  const failuresHtml = p.totalFailures === 0
    ? `<p style="margin: 0; color: #22a45e; font-size: 14px;">✓ No failed side effects in the window.</p>`
    : `
        <p style="margin: 0 0 8px 0; color: #c0392b; font-weight: 600; font-size: 14px;">⚠ ${p.totalFailures} failed side effect${p.totalFailures === 1 ? "" : "s"}</p>
        <table style="border-collapse: collapse; width: 100%;">
          ${p.failures.map((f) => statRow({ label: `  ${f.kind}`, value: f.count })).join("")}
        </table>
      `;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 28px 24px; color: #1a1a2e;">
      <p style="margin: 0 0 4px 0; font-size: 12px; color: #6c5ce7; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;">AgentEnvoy · Daily</p>
      <h1 style="font-size: 20px; font-weight: 700; margin: 0 0 4px 0;">${escapeHtml(dateLabel)}</h1>
      <p style="margin: 0 0 24px 0; font-size: 13px; color: #666;">
        ${escapeHtml(fmtRange(p.windowStart, p.windowEnd))}
      </p>

      <section style="margin: 0 0 24px 0;">
        <h2 style="font-size: 13px; font-weight: 600; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.05em; color: #3a3a52;">Activity</h2>
        <table style="border-collapse: collapse; width: 100%;">
          ${coreRowsHtml}
        </table>
      </section>

      <section style="margin: 0 0 24px 0;">
        <h2 style="font-size: 13px; font-weight: 600; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.05em; color: #3a3a52;">Agreed meeting formats</h2>
        <table style="border-collapse: collapse; width: 100%;">
          ${formatRowsHtml}
        </table>
      </section>

      <section style="margin: 0 0 20px 0;">
        <h2 style="font-size: 13px; font-weight: 600; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.05em; color: #3a3a52;">Side effects</h2>
        ${failuresHtml}
      </section>

      <p style="margin: 24px 0 0 0; text-align: center; font-size: 12px; color: #999;">
        Sent by the AgentEnvoy harness · <a href="https://agentenvoy.ai/admin/failures" style="color: #6c5ce7; text-decoration: none;">/admin/failures</a> · <a href="https://agentenvoy.ai/dev/side-effects" style="color: #6c5ce7; text-decoration: none;">/dev/side-effects</a>
      </p>
    </div>
  `;

  return { subject, html };
}

function statRow({ label, value }: DevStatsRow): string {
  return `
    <tr>
      <td style="padding: 6px 0; font-size: 14px; color: #3a3a52; border-bottom: 1px solid #f0eef7;">${escapeHtml(label)}</td>
      <td style="padding: 6px 0; font-size: 14px; font-weight: 600; text-align: right; border-bottom: 1px solid #f0eef7;">${value}</td>
    </tr>
  `;
}

function fmtRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    });
  return `${fmt(start)} → ${fmt(end)} PT`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
