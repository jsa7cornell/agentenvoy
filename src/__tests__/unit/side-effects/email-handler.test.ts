/**
 * Unit tests for the email handler — mode routing behavior.
 *
 * Exercises `handleEmail` directly with mocked SES. Verifies the per-mode
 * contract laid out in handlers/README.md.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Mock the SESv2 SDK so tests never hit AWS.
const sesSendMock = vi.fn();
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = sesSendMock;
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

import {
  handleEmail,
  summarizeEmailTarget,
  __resetEmailHandlerForTests,
} from "@/lib/side-effects/handlers/email";
import type { EmailSendEffect } from "@/lib/side-effects/types";

const baseEffect: EmailSendEffect = {
  kind: "email.send",
  to: "guest@example.com",
  subject: "Meeting Confirmed",
  html: "<p>ok</p>",
};

beforeEach(() => {
  sesSendMock.mockReset();
  __resetEmailHandlerForTests();
  process.env.AWS_SES_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.AWS_SES_SECRET_ACCESS_KEY = "secret_TEST";
  process.env.AWS_SES_REGION = "us-west-2";
  delete process.env.EFFECT_ALLOW_EMAIL_DOMAINS;
});

afterEach(() => {
  delete process.env.AWS_SES_ACCESS_KEY_ID;
  delete process.env.AWS_SES_SECRET_ACCESS_KEY;
  delete process.env.AWS_SES_REGION;
});

describe("handleEmail", () => {
  describe("mode: off", () => {
    it("returns skipped and does not call SES", async () => {
      const outcome = await handleEmail(baseEffect, "off");
      expect(outcome.status).toBe("skipped");
      expect(outcome.effectiveMode).toBe("off");
      expect(sesSendMock).not.toHaveBeenCalled();
    });
  });

  describe("mode: log", () => {
    it("returns suppressed and does not call SES", async () => {
      const outcome = await handleEmail(baseEffect, "log");
      expect(outcome.status).toBe("suppressed");
      expect(outcome.effectiveMode).toBe("log");
      expect(sesSendMock).not.toHaveBeenCalled();
    });
  });

  describe("mode: dryrun", () => {
    it("returns dryrun with a synthetic providerMessageId", async () => {
      const outcome = await handleEmail(baseEffect, "dryrun");
      expect(outcome.status).toBe("dryrun");
      expect(outcome.effectiveMode).toBe("dryrun");
      expect(outcome.providerMessageId).toMatch(/^dryrun-/);
      expect(sesSendMock).not.toHaveBeenCalled();
    });
  });

  describe("mode: live", () => {
    it("sends via SES and returns sent with the provider message ID", async () => {
      sesSendMock.mockResolvedValueOnce({ MessageId: "ses-abc-123" });
      const outcome = await handleEmail(baseEffect, "live");
      expect(sesSendMock).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("sent");
      expect(outcome.effectiveMode).toBe("live");
      expect(outcome.providerMessageId).toBe("ses-abc-123");
    });

    it("returns failed when SES throws", async () => {
      sesSendMock.mockRejectedValueOnce(new Error("boom"));
      const outcome = await handleEmail(baseEffect, "live");
      expect(outcome.status).toBe("failed");
      expect(outcome.effectiveMode).toBe("live");
      expect(outcome.error).toBe("boom");
    });
  });

  describe("mode: allowlist", () => {
    it("sends when recipient is on the allowlist", async () => {
      process.env.EFFECT_ALLOW_EMAIL_DOMAINS = "agentenvoy.dev, example.com";
      sesSendMock.mockResolvedValueOnce({ MessageId: "ses-allow-1" });
      const outcome = await handleEmail(baseEffect, "allowlist");
      expect(outcome.status).toBe("sent");
      expect(outcome.effectiveMode).toBe("allowlist");
      expect(outcome.providerMessageId).toBe("ses-allow-1");
    });

    it("falls through to log when recipient is off the allowlist", async () => {
      process.env.EFFECT_ALLOW_EMAIL_DOMAINS = "agentenvoy.dev";
      const outcome = await handleEmail(baseEffect, "allowlist");
      expect(outcome.status).toBe("suppressed");
      expect(outcome.effectiveMode).toBe("log");
      expect(sesSendMock).not.toHaveBeenCalled();
    });

    it("suppresses if even one of multiple recipients is off the allowlist", async () => {
      process.env.EFFECT_ALLOW_EMAIL_DOMAINS = "agentenvoy.dev";
      const outcome = await handleEmail(
        {
          ...baseEffect,
          to: ["ok@agentenvoy.dev", "bad@untrusted.com"],
        },
        "allowlist",
      );
      expect(outcome.status).toBe("suppressed");
      expect(sesSendMock).not.toHaveBeenCalled();
    });

    it("suppresses when allowlist env var is empty", async () => {
      // EFFECT_ALLOW_EMAIL_DOMAINS unset — safe default = suppress.
      const outcome = await handleEmail(baseEffect, "allowlist");
      expect(outcome.status).toBe("suppressed");
      expect(sesSendMock).not.toHaveBeenCalled();
    });
  });
});

describe("summarizeEmailTarget", () => {
  it("returns single recipient as-is", () => {
    expect(summarizeEmailTarget(baseEffect)).toBe("guest@example.com");
  });

  it("joins up to three recipients", () => {
    expect(
      summarizeEmailTarget({ ...baseEffect, to: ["a@x.com", "b@x.com", "c@x.com"] }),
    ).toBe("a@x.com, b@x.com, c@x.com");
  });

  it("truncates past three recipients", () => {
    expect(
      summarizeEmailTarget({
        ...baseEffect,
        to: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
      }),
    ).toBe("a@x.com, +4 more");
  });
});
