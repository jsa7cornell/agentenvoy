import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Guards the action-emission reliability fix (proposal 2026-04-18). If the
// playbook drifts back toward two formats or reintroduces create_thread, the
// silent-card-failure regression returns. This test fails loudly before that
// ships.
describe("channel.md playbook", () => {
  const playbook = readFileSync(
    join(process.cwd(), "src", "agent", "playbooks", "channel.md"),
    "utf-8"
  );

  it("exists and is non-trivial", () => {
    expect(playbook.length).toBeGreaterThan(1000);
  });

  it("shows the create_link action in [ACTION] format", () => {
    expect(playbook).toMatch(/\[ACTION\]\{"action":"create_link"/);
  });

  it("does NOT reference the retired create_thread action", () => {
    expect(playbook).not.toMatch(/create_thread/);
  });

  it("does NOT reference the retired agentenvoy-action fence format", () => {
    expect(playbook).not.toMatch(/agentenvoy-action/);
  });

  it("does NOT prescribe the 'ready to share' trigger phrase", () => {
    expect(playbook).not.toMatch(/ready to share/i);
  });

  it("instructs emission in the single [ACTION] format", () => {
    expect(playbook).toMatch(/\[ACTION\]\{\.\.\.\}\[\/ACTION\]/);
  });
});
