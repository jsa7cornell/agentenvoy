import { describe, it, expect } from "vitest";
import { post, get, API_KEY } from "./helpers";

describe("Host API (Bearer token auth)", () => {
  it("creates a contextual link", async () => {
    const { status, data } = await post(
      "/api/negotiate/create",
      {
        inviteeName: "API Test Guest",
        inviteeEmail: "apiguest@test.com",
        topic: "API Test Meeting",
        rules: { format: "video", duration: 45 },
      },
      { bearer: API_KEY }
    );

    expect(status).toBe(200);
    expect(data.link).toBeDefined();
    expect(data.link.type).toBe("contextual");
    expect(data.link.code).toBeDefined();
    expect(data.link.contextualUrl).toContain(data.link.code);
    expect(data.link.inviteeName).toBe("API Test Guest");
    expect(data.link.topic).toBe("API Test Meeting");
  });

  it("rejects create without auth", async () => {
    const { status } = await post("/api/negotiate/create", {
      inviteeName: "No Auth",
    });
    expect(status).toBe(401);
  });

  it("lists sessions", async () => {
    const { status, data } = await get("/api/negotiate/sessions", {
      bearer: API_KEY,
    });

    expect(status).toBe(200);
    expect(data.sessions).toBeDefined();
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it("configures preferences via prompt", async () => {
    const { status, data } = await post(
      "/api/agent/configure",
      { prompt: "I prefer 30-minute phone calls in the morning, never on Fridays" },
      { bearer: API_KEY }
    );

    expect(status).toBe(200);
    expect(data.preferences).toBeDefined();
  });

  it("saves a host directive", async () => {
    const { status, data } = await post(
      "/api/negotiate/directive",
      { content: "Always confirm timezone before proposing times" },
      { bearer: API_KEY }
    );

    expect(status).toBe(200);
    expect(data.status).toBe("saved");
    expect(data.directiveCount).toBeGreaterThanOrEqual(1);
  });

  it("rejects directive without auth", async () => {
    const { status } = await post("/api/negotiate/directive", {
      content: "Should fail",
    });
    expect(status).toBe(401);
  });
});
