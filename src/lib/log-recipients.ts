/**
 * Recipients for operational / log emails: route-error alerts, daily
 * ops digests, schema-health alarms, dev-stats summaries.
 *
 * Separate from ADMIN_EMAIL (admin-auth.ts) on purpose: ADMIN_EMAIL
 * gates admin-only page access and must stay a single authenticated
 * user. LOG_RECIPIENTS is just "who else should see the heartbeat"
 * and can include teammates without granting admin rights.
 *
 * Override in the environment with `LOG_RECIPIENTS` as a comma-
 * separated list. Whitespace is trimmed; empty entries are dropped.
 */
const DEFAULT_LOG_RECIPIENTS = [
  "jsa7cornell@gmail.com",
  "hbryanjones@gmail.com",
];

export function getLogRecipients(): string[] {
  const raw = process.env.LOG_RECIPIENTS;
  if (!raw) return [...DEFAULT_LOG_RECIPIENTS];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_LOG_RECIPIENTS];
}
