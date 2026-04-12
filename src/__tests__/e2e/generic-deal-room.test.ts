import { describe, it, expect } from "vitest";
import { post, sendMessage, HOST_SLUG } from "./helpers";

describe("Generic Deal Room", () => {
  it("creates a new session with auto-contextual code for a generic slug", async () => {
    const { status, data } = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
    });

    expect(status).toBe(200);
    expect(data.sessionId).toBeDefined();
    expect(data.greeting).toBeDefined();
    expect(data.greeting.length).toBeGreaterThan(10);
    expect(data.host.name).toBe("Test Host");
    expect(data.code).toBeDefined(); // auto-generated contextual code
    expect(data.link.type).toBe("contextual"); // auto-upgraded from generic
  });

  it("creates a DIFFERENT session each time (each guest gets own link)", async () => {
    const first = await post("/api/negotiate/session", { slug: HOST_SLUG });
    const second = await post("/api/negotiate/session", { slug: HOST_SLUG });

    expect(first.data.sessionId).toBeDefined();
    expect(second.data.sessionId).toBeDefined();
    expect(first.data.sessionId).not.toBe(second.data.sessionId);
    // Each gets a unique code
    expect(first.data.code).not.toBe(second.data.code);
  });

  it("resumes session when using the auto-generated code", async () => {
    const { data: created } = await post("/api/negotiate/session", { slug: HOST_SLUG });
    expect(created.code).toBeDefined();

    // Re-visit with the generated code — should resume
    const { data: resumed } = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: created.code,
    });

    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.resumed).toBe(true);
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
