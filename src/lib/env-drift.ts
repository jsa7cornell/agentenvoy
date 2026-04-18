/**
 * Env-drift detector — catches the class of outage where prod is missing a
 * critical environment variable or has it set to a non-production value.
 *
 * Context: 2026-04-17 we took prod-adjacent features down twice in one day
 * because `EFFECT_MODE_EMAIL` and `EFFECT_MODE_CALENDAR` were never set in
 * Vercel production. The dispatcher falls back to safe defaults (log /
 * dryrun) when missing — great for preview, silent failure in prod. This
 * module codifies "what prod needs" so a daily sweep can notice drift.
 *
 * Complements:
 *   - The boot-time alert in `dispatcher.ts` (fires on first dispatch with
 *     a bad mode — high-fidelity but only covers dispatcher env vars).
 *   - The schema-drift detector (`schema-drift.ts`) which handles
 *     Prisma-schema-vs-Supabase drift.
 *
 * Output is intentionally small — if you'd add a check here, prefer adding
 * it to the `CHECKS` array with a self-contained predicate.
 */

export interface EnvDriftFinding {
  name: string;
  expected: string;
  actual: string | undefined;
  severity: "critical" | "warn";
  reason: string;
}

export interface EnvDriftReport {
  ok: boolean;
  checkedAt: string;
  findings: EnvDriftFinding[];
}

interface Check {
  name: string;
  /** Human-readable description of the expected state in prod. */
  expected: string;
  severity: "critical" | "warn";
  /** Returns an explanation if the value is wrong, null if OK. */
  validate: (value: string | undefined) => string | null;
}

const CHECKS: Check[] = [
  {
    name: "EFFECT_MODE_EMAIL",
    expected: "live",
    severity: "critical",
    validate: (v) => {
      if (!v) return "not set — dispatcher defaults to `log`, no real emails sent";
      if (v.toLowerCase() !== "live")
        return `set to "${v}" — not sending real emails`;
      return null;
    },
  },
  {
    name: "EFFECT_MODE_CALENDAR",
    expected: "live",
    severity: "critical",
    validate: (v) => {
      if (!v) return "not set — dispatcher defaults to `dryrun`, every confirmed meeting creates a synthetic event";
      if (v.toLowerCase() !== "live")
        return `set to "${v}" — no real GCal events being created`;
      return null;
    },
  },
  {
    name: "CALENDAR_SEND_UPDATES",
    expected: "all or externalOnly",
    severity: "warn",
    validate: (v) => {
      if (!v) return null; // defaults to "all" in the handler
      const lc = v.toLowerCase();
      if (lc === "all" || lc === "externalonly") return null;
      if (lc === "none")
        return `set to "none" — attendees will NOT receive calendar invites on confirm`;
      return `unexpected value "${v}"`;
    },
  },
  {
    name: "ADMIN_EMAIL",
    expected: "present",
    severity: "warn",
    validate: (v) => (v ? null : "not set — admin alerts fall back to a hardcoded default"),
  },
  {
    name: "CRON_SECRET",
    expected: "present",
    severity: "critical",
    validate: (v) =>
      !v ? "not set — cron endpoints are unauthenticated in production" : null,
  },
  {
    name: "NEXTAUTH_SECRET",
    expected: "present",
    severity: "critical",
    validate: (v) => (v ? null : "not set — sessions cannot be signed"),
  },
  {
    name: "NEXTAUTH_URL",
    expected: "https://agentenvoy.ai",
    severity: "critical",
    validate: (v) => {
      if (!v) return "not set — OAuth redirects will use request-derived URLs";
      if (!v.startsWith("https://"))
        return `set to "${v}" — must be https:// in production`;
      return null;
    },
  },
  {
    name: "NEXT_PUBLIC_BASE_URL",
    expected: "https://agentenvoy.ai",
    severity: "warn",
    validate: (v) => {
      if (!v) return "not set — deal-room URLs in emails will use a fallback";
      if (!v.startsWith("https://")) return `set to "${v}" — must be https:// in production`;
      return null;
    },
  },
  {
    name: "GOOGLE_CLIENT_ID",
    expected: "present",
    severity: "critical",
    validate: (v) => (v ? null : "not set — Google OAuth will not work"),
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    expected: "present",
    severity: "critical",
    validate: (v) => (v ? null : "not set — Google OAuth will not work"),
  },
];

/**
 * Run every check against current process.env. Only returns findings when
 * something is off — a clean report has `ok: true` and an empty `findings` array.
 */
export function checkEnvDrift(): EnvDriftReport {
  const findings: EnvDriftFinding[] = [];
  for (const check of CHECKS) {
    const actual = process.env[check.name];
    const reason = check.validate(actual);
    if (reason) {
      findings.push({
        name: check.name,
        expected: check.expected,
        // Mask secrets — never include actual values for *_SECRET vars, just presence.
        actual: check.name.toUpperCase().includes("SECRET") || check.name.toUpperCase().includes("CLIENT_ID")
          ? actual
            ? "(set)"
            : undefined
          : actual,
        severity: check.severity,
        reason,
      });
    }
  }
  return {
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
    findings,
  };
}

/** Human-readable summary of an env-drift report. */
export function formatEnvDriftSummary(report: EnvDriftReport): string {
  if (report.ok) return "All env vars OK.";
  const lines: string[] = [`${report.findings.length} env-var issue(s):`];
  for (const f of report.findings) {
    lines.push(
      `  [${f.severity.toUpperCase()}] ${f.name} expected ${f.expected} — ${f.reason}`
    );
  }
  return lines.join("\n");
}
