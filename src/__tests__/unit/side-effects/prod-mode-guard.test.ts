/**
 * Unit tests for the dispatcher's production boot-guard.
 *
 * The guard alerts (via RouteError + console.error) when a critical effect
 * kind resolves to a non-live mode while NODE_ENV=production. Throttled to
 * once per kind per process. Tests verify:
 *   - No alert in non-production environments.
 *   - No alert when mode is "live" or "allowlist".
 *   - Alert fires when mode is log/dryrun/off in production.
 *   - Only one alert per kind per process lifetime.
 *   - Non-critical kinds (calendar.delete_event) don't alert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logRouteErrorMock = vi.fn();
vi.mock("@/lib/route-error", () => ({
  logRouteError: logRouteErrorMock,
}));

// Avoid Prisma import side-effects during this test. We don't exercise
// dispatch() here — only the exported guard helper.
vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import {
  alertIfProdModeMisconfigured,
  __resetProdModeAlertsForTests,
} from "@/lib/side-effects/dispatcher";

const originalNodeEnv = process.env.NODE_ENV;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logRouteErrorMock.mockReset();
  __resetProdModeAlertsForTests();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  setNodeEnv(originalNodeEnv);
});

function setNodeEnv(v: string | undefined) {
  // Use the setter rather than defineProperty — vitest's process.env proxy
  // only accepts plain assignment. For "unset", delete the key entirely.
  if (v === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  } else {
    (process.env as Record<string, string>).NODE_ENV = v;
  }
}

describe("alertIfProdModeMisconfigured", () => {
  it("is a no-op when NODE_ENV is not production", () => {
    setNodeEnv("development");
    alertIfProdModeMisconfigured("calendar.create_event", "dryrun");
    expect(logRouteErrorMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("is a no-op in production when mode is live", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("calendar.create_event", "live");
    expect(logRouteErrorMock).not.toHaveBeenCalled();
  });

  it("is a no-op in production when mode is allowlist", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("email.send", "allowlist");
    expect(logRouteErrorMock).not.toHaveBeenCalled();
  });

  it("fires once in production when calendar.create_event resolves to dryrun", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("calendar.create_event", "dryrun");

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const msg = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toMatch(/CRITICAL/);
    expect(msg).toMatch(/calendar\.create_event/);
    expect(msg).toMatch(/EFFECT_MODE_CALENDAR=live/);
  });

  it("fires in production when email.send resolves to log", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("email.send", "log");
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const msg = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toMatch(/EFFECT_MODE_EMAIL/);
  });

  it("throttles repeat calls for the same kind to a single alert", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("calendar.create_event", "dryrun");
    alertIfProdModeMisconfigured("calendar.create_event", "dryrun");
    alertIfProdModeMisconfigured("calendar.create_event", "log");
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it("fires independently for different kinds", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("calendar.create_event", "dryrun");
    alertIfProdModeMisconfigured("email.send", "log");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT alert for calendar.delete_event (intentionally omitted from critical list)", () => {
    setNodeEnv("production");
    alertIfProdModeMisconfigured("calendar.delete_event", "log");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(logRouteErrorMock).not.toHaveBeenCalled();
  });
});
