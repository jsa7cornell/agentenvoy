import { beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks must be hoisted above the import under test.
const findUniqueMock = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

const dispatchMock = vi.fn();
const hasDispatchedForMock = vi.fn();
vi.mock("@/lib/side-effects/dispatcher", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  hasDispatchedFor: (...args: unknown[]) => hasDispatchedForMock(...args),
}));

import { buildWelcomeEmail, dispatchWelcomeEmailOnce } from "@/lib/emails/welcome";

describe("buildWelcomeEmail", () => {
  it("returns a subject and html body", () => {
    const { subject, html } = buildWelcomeEmail({ firstName: "John", meetSlug: "johna" });
    expect(subject).toBeTruthy();
    expect(typeof subject).toBe("string");
    expect(html).toContain("<div");
  });

  it("addresses the user by first name when provided", () => {
    const { html } = buildWelcomeEmail({ firstName: "Sarah", meetSlug: "sarah" });
    expect(html).toContain("Hi Sarah");
  });

  it("falls back to a generic greeting when name is missing", () => {
    const { html } = buildWelcomeEmail({ firstName: null, meetSlug: "mystery" });
    expect(html).toContain("Hi there");
  });

  it("includes the meet link in visible body text", () => {
    const { html } = buildWelcomeEmail({ firstName: "John", meetSlug: "johna" });
    expect(html).toContain("agentenvoy.ai/meet/johna");
  });

  it("points the meet link at an absolute URL", () => {
    const { html } = buildWelcomeEmail({ firstName: "John", meetSlug: "johna" });
    expect(html).toMatch(/href="https?:\/\/[^"]+\/meet\/johna"/);
  });

  it("mentions the dashboard, Today's Insight, and FAQ", () => {
    const { html } = buildWelcomeEmail({ firstName: "John", meetSlug: "johna" });
    expect(html).toContain("dashboard");
    expect(html).toContain("Today's Insight");
    expect(html).toContain("FAQ");
  });

  it("escapes HTML-unsafe characters in the first name", () => {
    const { html } = buildWelcomeEmail({ firstName: "<script>alert(1)</script>", meetSlug: "ok" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("stays under the 200-word body target", () => {
    const { html } = buildWelcomeEmail({ firstName: "John", meetSlug: "johna" });
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const wordCount = text.split(" ").filter(Boolean).length;
    expect(wordCount).toBeLessThan(200);
  });
});

describe("dispatchWelcomeEmailOnce", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    dispatchMock.mockReset();
    hasDispatchedForMock.mockReset();
    // Default: no prior dispatch. Tests that exercise the gate override this.
    hasDispatchedForMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue({ status: "suppressed", mode: "log", logId: "log_123", kind: "email.send" });
  });

  it("dispatches once when the gate reports no prior send", async () => {
    findUniqueMock.mockResolvedValue({
      email: "john@example.com",
      name: "John Abramson",
      meetSlug: "johna",
    });
    const result = await dispatchWelcomeEmailOnce("user_1");
    expect(result).toEqual({ dispatched: true });
    expect(hasDispatchedForMock).toHaveBeenCalledWith({
      kind: "email.send",
      userId: "user_1",
      purpose: "welcome",
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const effect = dispatchMock.mock.calls[0][0];
    expect(effect.kind).toBe("email.send");
    expect(effect.to).toBe("john@example.com");
    expect(effect.context).toMatchObject({ userId: "user_1", purpose: "welcome" });
  });

  it("skips dispatch when the gate reports a prior send", async () => {
    hasDispatchedForMock.mockResolvedValue(true);
    const result = await dispatchWelcomeEmailOnce("user_1");
    expect(result).toEqual({ dispatched: false, reason: "already_sent" });
    expect(dispatchMock).not.toHaveBeenCalled();
    // Short-circuits before even loading the user — the gate is the only
    // read needed when it's already been sent.
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("calling twice in a row only dispatches once (gate becomes true after first call)", async () => {
    // Gate is false first time, true second time — simulates the SideEffectLog
    // row being written between calls.
    hasDispatchedForMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    findUniqueMock.mockResolvedValue({
      email: "john@example.com",
      name: "John",
      meetSlug: "johna",
    });
    await dispatchWelcomeEmailOnce("user_1");
    await dispatchWelcomeEmailOnce("user_1");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when user has no email", async () => {
    findUniqueMock.mockResolvedValue({
      email: null,
      name: "Ghost",
      meetSlug: "ghost",
    });
    const result = await dispatchWelcomeEmailOnce("user_1");
    expect(result).toEqual({ dispatched: false, reason: "missing_email" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips dispatch when meetSlug is missing", async () => {
    findUniqueMock.mockResolvedValue({
      email: "john@example.com",
      name: "John",
      meetSlug: null,
    });
    const result = await dispatchWelcomeEmailOnce("user_1");
    expect(result).toEqual({ dispatched: false, reason: "missing_slug" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
