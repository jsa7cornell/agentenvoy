import { describe, it, expect } from "vitest";
import { post, HOST_SLUG } from "./helpers";

describe("Edge Cases", () => {
  it("returns 404 for invalid contextual code", async () => {
    const { status, data } = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code: "nonexistent-code-xyz",
    });

    expect(status).toBe(404);
    expect(data.error).toBe("Link not found");
  });

  it("returns 404 for invalid slug", async () => {
    const { status, data } = await post("/api/negotiate/session", {
      slug: "nobody-exists-here",
    });

    expect(status).toBe(404);
    expect(data.error).toBe("User not found");
  });

  it("returns 400 for missing slug", async () => {
    const { status, data } = await post("/api/negotiate/session", {});

    expect(status).toBe(400);
    expect(data.error).toBe("Missing slug");
  });

  it("rapid resume returns same session (no duplicates)", async () => {
    // Create a fresh contextual link
    const link = await post(
      "/api/negotiate/create",
      { inviteeName: "Rapid Tester", topic: "Rapid Test" },
      { bearer: "ae_test_key_e2e" }
    );
    const code = link.data.link.code;

    // First request creates the session
    const first = await post("/api/negotiate/session", {
      slug: HOST_SLUG,
      code,
    });
    const sessionId = first.data.sessionId;

    // Fire 3 rapid requests in parallel
    const results = await Promise.all([
      post("/api/negotiate/session", { slug: HOST_SLUG, code }),
      post("/api/negotiate/session", { slug: HOST_SLUG, code }),
      post("/api/negotiate/session", { slug: HOST_SLUG, code }),
    ]);

    // All should return the same session
    for (const r of results) {
      expect(r.data.sessionId).toBe(sessionId);
      expect(r.data.resumed).toBe(true);
    }
  });
});
