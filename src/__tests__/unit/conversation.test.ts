import { describe, it, expect } from "vitest";
import { sanitizeHistory, roleSummary } from "@/lib/conversation";
import { stripActionBlocks } from "@/agent/actions";

// ─── sanitizeHistory ─────────────────────────────────────────────────────────

describe("sanitizeHistory", () => {
  it("maps envoy/assistant to assistant, everything else to user", () => {
    const raw = [
      { role: "user", content: "Hello" },
      { role: "envoy", content: "Hi there" },
      { role: "guest", content: "I'm available Tuesday" },
      { role: "administrator", content: "Let me check" },
    ];
    const { messages } = sanitizeHistory(raw);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("filters out system and host_note messages", () => {
    const raw = [
      { role: "user", content: "Archive my sessions" },
      { role: "system", content: "✓ Archived 3 sessions" },
      { role: "envoy", content: "Done!" },
      { role: "host_note", content: "Internal note" },
    ];
    const { messages } = sanitizeHistory(raw, ["envoy", "assistant"]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Archive my sessions" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Done!" });
  });

  it("merges consecutive same-role messages", () => {
    const raw = [
      { role: "user", content: "Hello" },
      { role: "envoy", content: "Hi" },
      { role: "system", content: "✓ Action done" }, // filtered out
      { role: "envoy", content: "What else?" }, // would be consecutive with "Hi"
    ];
    const { messages, warnings } = sanitizeHistory(raw, ["envoy", "assistant"]);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("Hi\nWhat else?");
    expect(warnings.some((w) => w.includes("Merged"))).toBe(true);
  });

  it("drops empty messages and warns", () => {
    const raw = [
      { role: "user", content: "Hello" },
      { role: "envoy", content: "" },
      { role: "envoy", content: "   " },
      { role: "envoy", content: "Real response" },
    ];
    const { messages, warnings } = sanitizeHistory(raw, ["envoy", "assistant"]);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("Real response");
    expect(warnings.filter((w) => w.includes("Dropped empty")).length).toBe(2);
  });

  it("prepends user turn if history starts with assistant", () => {
    const raw = [
      { role: "envoy", content: "Welcome!" },
      { role: "user", content: "Thanks" },
    ];
    const { messages, warnings } = sanitizeHistory(raw, ["envoy", "assistant"]);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("(conversation started)");
    expect(messages[1].role).toBe("assistant");
    expect(warnings.some((w) => w.includes("started with"))).toBe(true);
  });

  it("handles the production crash scenario: system messages between envoy turns", () => {
    // This was the exact bug: action results saved as system messages
    // caused consecutive assistant turns after filtering
    const raw = [
      { role: "user", content: "Archive my Bryan meeting" },
      { role: "envoy", content: 'I\'ll archive that.' },
      { role: "system", content: '✓ Archived "Bryan"' },
      { role: "user", content: "How is my day looking?" },
      { role: "envoy", content: "You have 3 meetings today." },
      { role: "system", content: "✓ Updated status" },
      { role: "envoy", content: "Anything else?" },
    ];
    const { messages } = sanitizeHistory(raw, ["envoy", "assistant"]);
    // Verify alternating pattern
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
    // The two envoy messages after the second system message should be merged
    expect(messages[messages.length - 1].content).toContain("Anything else?");
  });

  it("handles empty history", () => {
    const { messages, warnings } = sanitizeHistory([]);
    expect(messages).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("handles all-system history (everything filtered)", () => {
    const raw = [
      { role: "system", content: "Action result" },
      { role: "host_note", content: "Note" },
    ];
    const { messages } = sanitizeHistory(raw);
    expect(messages).toHaveLength(0);
  });

  it("uses custom assistantRoles", () => {
    const raw = [
      { role: "user", content: "Hi" },
      { role: "coordinator", content: "Hello" },
    ];
    const { messages } = sanitizeHistory(raw, ["coordinator"]);
    expect(messages[1].role).toBe("assistant");
  });
});

// ─── roleSummary ─────────────────────────────────────────────────────────────

describe("roleSummary", () => {
  it("joins roles with commas", () => {
    const msgs = [{ role: "user" }, { role: "assistant" }, { role: "user" }];
    expect(roleSummary(msgs)).toBe("user,assistant,user");
  });

  it("handles empty array", () => {
    expect(roleSummary([])).toBe("");
  });
});

// ─── Integration: strip + empty fallback ─────────────────────────────────────

describe("action strip produces empty text", () => {
  it("stripActionBlocks returns empty for action-only text", () => {
    // This is the scenario that caused empty Envoy bubbles
    const text =
      '[ACTION]{"action":"archive_bulk","params":{"filter":"unconfirmed"}}[/ACTION]';
    const stripped = stripActionBlocks(text);
    expect(stripped).toBe("");
  });

  it("stripActionBlocks preserves text around action blocks", () => {
    const text =
      'I\'ll archive those now. [ACTION]{"action":"archive_bulk","params":{"filter":"unconfirmed"}}[/ACTION] Done.';
    const stripped = stripActionBlocks(text);
    expect(stripped).toBe("I'll archive those now.Done.");
  });
});
