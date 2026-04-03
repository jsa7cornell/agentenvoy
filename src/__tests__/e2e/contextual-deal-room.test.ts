import { describe, it, expect } from "vitest";
import { post, sendMessage, HOST_SLUG, CTX_CODE } from "./helpers";

describe("Contextual Deal Room", () => {
  it("creates a session with contextual link context", async () => {
    const { status, data } = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: CTX_CODE,
    });

    expect(status).toBe(200);
    expect(data.sessionId).toBeDefined();
    expect(data.greeting).toBeDefined();
    expect(data.host.name).toBe("Test Host");
    expect(data.link.type).toBe("contextual");
    expect(data.link.topic).toBe("Q2 Roadmap Review");
    expect(data.link.inviteeName).toBe("Sarah Chen");
  });

  it("resumes the SAME session on subsequent requests", async () => {
    // First request creates the session (or resumes from prior test)
    const first = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: CTX_CODE,
    });
    const sessionId = first.data.sessionId;

    // Second request should resume
    const second = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: CTX_CODE,
    });

    expect(second.data.sessionId).toBe(sessionId);
    expect(second.data.resumed).toBe(true);
    expect(second.data.messages).toBeDefined();
    expect(second.data.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves message history across resumes", async () => {
    // Get current session
    const initial = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: CTX_CODE,
    });
    const sessionId = initial.data.sessionId;

    // Send a guest message
    await sendMessage(sessionId, "How about Wednesday at 2pm?");

    // Resume — should include all messages
    const resumed = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: CTX_CODE,
    });

    expect(resumed.data.sessionId).toBe(sessionId);
    expect(resumed.data.resumed).toBe(true);

    const messages = resumed.data.messages;
    // Should have: greeting + guest message + agent response (at minimum)
    expect(messages.length).toBeGreaterThanOrEqual(3);

    // Check roles are present
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("administrator");
    expect(roles).toContain("guest");
  });
});
