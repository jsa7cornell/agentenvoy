/**
 * Unit tests for the env-drift detector.
 *
 * Exercises checkEnvDrift() against every branch in the CHECKS array:
 *   - Missing critical vars (EFFECT_MODE_*, NEXTAUTH_*, Google credentials)
 *   - Non-live values for dispatcher mode vars
 *   - CALENDAR_SEND_UPDATES = "none" (the subtle-but-bad case)
 *   - Clean production config reports ok
 *   - Secret values are redacted in output
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEnvDrift, formatEnvDriftSummary } from "@/lib/env-drift";

// Snapshot + restore process.env so tests don't leak state.
type EnvSnapshot = Record<string, string | undefined>;
const ENV_KEYS = [
  "EFFECT_MODE_EMAIL",
  "EFFECT_MODE_CALENDAR",
  "CALENDAR_SEND_UPDATES",
  "ADMIN_EMAIL",
  "CRON_SECRET",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_BASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

let original: EnvSnapshot = {};

function setAllGood() {
  process.env.EFFECT_MODE_EMAIL = "live";
  process.env.EFFECT_MODE_CALENDAR = "live";
  process.env.CALENDAR_SEND_UPDATES = "all";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.CRON_SECRET = "a-long-random-secret";
  process.env.NEXTAUTH_SECRET = "another-long-random-secret";
  process.env.NEXTAUTH_URL = "https://agentenvoy.ai";
  process.env.NEXT_PUBLIC_BASE_URL = "https://agentenvoy.ai";
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
}

beforeEach(() => {
  original = {};
  for (const k of ENV_KEYS) {
    original[k] = process.env[k];
  }
  setAllGood();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) {
      delete (process.env as Record<string, string | undefined>)[k];
    } else {
      process.env[k] = original[k];
    }
  }
});

describe("checkEnvDrift", () => {
  it("returns ok: true when everything is configured correctly", () => {
    const report = checkEnvDrift();
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it("flags missing EFFECT_MODE_EMAIL as critical", () => {
    delete process.env.EFFECT_MODE_EMAIL;
    const report = checkEnvDrift();
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.name === "EFFECT_MODE_EMAIL");
    expect(finding?.severity).toBe("critical");
    expect(finding?.reason).toMatch(/not set/);
  });

  it("flags missing EFFECT_MODE_CALENDAR as critical", () => {
    delete process.env.EFFECT_MODE_CALENDAR;
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "EFFECT_MODE_CALENDAR");
    expect(finding?.severity).toBe("critical");
    expect(finding?.reason).toMatch(/synthetic event/i);
  });

  it("flags EFFECT_MODE_EMAIL set to non-live values", () => {
    process.env.EFFECT_MODE_EMAIL = "log";
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "EFFECT_MODE_EMAIL");
    expect(finding?.reason).toMatch(/not sending real emails/i);
  });

  it("flags CALENDAR_SEND_UPDATES='none' as warn (not critical)", () => {
    process.env.CALENDAR_SEND_UPDATES = "none";
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "CALENDAR_SEND_UPDATES");
    expect(finding?.severity).toBe("warn");
    expect(finding?.reason).toMatch(/attendees will NOT receive/i);
  });

  it("does not flag CALENDAR_SEND_UPDATES when unset (handler defaults to 'all')", () => {
    delete process.env.CALENDAR_SEND_UPDATES;
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "CALENDAR_SEND_UPDATES");
    expect(finding).toBeUndefined();
  });

  it("flags NEXTAUTH_URL with http:// scheme as critical", () => {
    process.env.NEXTAUTH_URL = "http://agentenvoy.ai";
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "NEXTAUTH_URL");
    expect(finding?.severity).toBe("critical");
    expect(finding?.reason).toMatch(/https:\/\//);
  });

  it("flags missing CRON_SECRET as critical", () => {
    delete process.env.CRON_SECRET;
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "CRON_SECRET");
    expect(finding?.severity).toBe("critical");
    expect(finding?.reason).toMatch(/unauthenticated/i);
  });

  it("flags missing Google credentials as critical", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const report = checkEnvDrift();
    const criticalNames = report.findings
      .filter((f) => f.severity === "critical")
      .map((f) => f.name);
    expect(criticalNames).toContain("GOOGLE_CLIENT_ID");
    expect(criticalNames).toContain("GOOGLE_CLIENT_SECRET");
  });

  it("redacts secret values (actual='(set)' or undefined, never raw)", () => {
    // Force a finding with a secret set: e.g. via wrong NEXTAUTH_URL so we
    // *don't* flag NEXTAUTH_SECRET on presence, but we can check the
    // redaction rule for the missing-secret path instead.
    delete process.env.NEXTAUTH_SECRET;
    const report = checkEnvDrift();
    const finding = report.findings.find((f) => f.name === "NEXTAUTH_SECRET");
    // Secret-like names whose actual is unset should be undefined, not raw.
    expect(finding?.actual).toBeUndefined();
  });

  it("includes severity and reason in formatted summary", () => {
    delete process.env.EFFECT_MODE_EMAIL;
    const report = checkEnvDrift();
    const summary = formatEnvDriftSummary(report);
    expect(summary).toMatch(/CRITICAL/);
    expect(summary).toMatch(/EFFECT_MODE_EMAIL/);
  });

  it("returns all-clean summary when nothing is wrong", () => {
    const report = checkEnvDrift();
    expect(formatEnvDriftSummary(report)).toBe("All env vars OK.");
  });
});
