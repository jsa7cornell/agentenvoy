import { describe, it, expect } from "vitest";
import { post, sendMessage, HOST_SLUG } from "./helpers";

describe("Generic Deal Room", () => {
  it("creates a new session for a generic slug", async () => {
    const { status, data } = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
    });

    expect(status).toBe(200);
    expect(data.sessionId).toBeDefined();
    expect(data.greeting).toBeDefined();
    expect(data.greeting.length).toBeGreaterThan(10);
    expect(data.host.name).toBe("Test Host");
    expect(data.link.type).toBe("generic");
  });

  it("creates a DIFFERENT session each time (no persistence)", async () => {
    const first = await post("/api/negotiate/session", { slug: HOST_SLUG });
    const second = await post("/api/negotiate/session", { slug: HOST_SLUG });

    expect(first.data.sessionId).toBeDefined();
    expect(second.data.sessionId).toBeDefined();
    expect(first.data.sessionId).not.toBe(second.data.sessionId);
  });

  it("agent responds to a guest message", async () => {
    const { data } = await post("/api/negotiate/session", { slug: HOST_SLUG });
    const msg = await sendMessage(
      data.sessionId,
      "I'm free Tuesday morning for a phone call"
    );

    expect(msg.status).toBe(200);
    expect(msg.text.length).toBeGreaterThan(10);
  });
});
