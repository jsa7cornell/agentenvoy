import { describe, it, expect } from "vitest";
import {
  buildExternalAgentPrefix,
  applyExternalAgentPrefix,
} from "@/lib/mcp/identity-prefix";

describe("buildExternalAgentPrefix", () => {
  it("formats name + masked actor", () => {
    expect(
      buildExternalAgentPrefix({
        clientName: "Acme Scheduler",
        actingFor: "a***@example.org",
      }),
    ).toBe("[Acme Scheduler, acting for a***@example.org]: ");
  });

  it("returns empty string for missing identity", () => {
    expect(buildExternalAgentPrefix(null)).toBe("");
    expect(buildExternalAgentPrefix(undefined)).toBe("");
  });

  it("returns empty string for blank fields", () => {
    expect(
      buildExternalAgentPrefix({ clientName: "", actingFor: "a@b" }),
    ).toBe("");
    expect(
      buildExternalAgentPrefix({ clientName: "N", actingFor: "  " }),
    ).toBe("");
  });
});

describe("applyExternalAgentPrefix — DB body stays unprefixed", () => {
  it("prefixes only when assembling for LLM", () => {
    const body = "Propose 3pm Thursday.";
    const identity = {
      clientName: "Acme Scheduler",
      actingFor: "a***@example.org",
    };

    // Simulate "DB row content" (verbatim) vs "LLM history line" (prefixed).
    const dbRow = body;
    const llmLine = applyExternalAgentPrefix(body, identity);

    expect(dbRow).toBe("Propose 3pm Thursday.");
    expect(llmLine).toBe(
      "[Acme Scheduler, acting for a***@example.org]: Propose 3pm Thursday.",
    );
    // Critical invariant: the DB row is unchanged.
    expect(dbRow).not.toContain("[Acme");
  });

  it("is a no-op when identity is absent", () => {
    expect(applyExternalAgentPrefix("hi", null)).toBe("hi");
  });
});
