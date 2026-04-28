/**
 * Canonical playbook loader.
 *
 * PLAYBOOK Rule 19c — all readFileSync calls for .md files go through this
 * module. Direct `readFileSync(*.md)` imports in other files are a Rule 19c
 * violation and will fail the `playbook-rule-19` CI job.
 *
 * PR2 of the 2026-04-27 chat-decisioning-layer-redesign.
 */
import { readFileSync } from "fs";
import { join } from "path";

function load(relPath: string): string {
  try {
    return readFileSync(join(process.cwd(), relPath), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load ${relPath}: ${err}`);
  }
}

// ── Fragments (shared building blocks) ────────────────────────────────────
export function voicePlaybook(): string {
  return load("src/agent/playbooks/fragments/voice.md");
}
export function groundTruthPlaybook(): string {
  return load("src/agent/playbooks/fragments/ground-truth.md");
}

// ── Classifiers ────────────────────────────────────────────────────────────
export function hostClassifierPlaybook(): string {
  return load("src/agent/playbooks/classifiers/host-classifier.md");
}
// NOTE: guest classifier (intent-classifier.md) deleted in PR2. No export.

// ── Composers (dashboard chat) ─────────────────────────────────────────────
export function calendarEventComposer(): string {
  return load("src/agent/playbooks/composers/calendar-event-composer.md");
}
export function inquireComposer(): string {
  return load("src/agent/playbooks/composers/inquire-composer.md");
}
export function profileComposer(): string {
  return load("src/agent/playbooks/composers/profile-composer.md");
}
export function calendarRuleComposer(): string {
  return load("src/agent/playbooks/composers/calendar-rule-composer.md");
}

// ── Composers (deal-room) ──────────────────────────────────────────────────
export function dealroomGuestComposer(): string {
  return load("src/agent/playbooks/composers/dealroom-guest-composer.md");
}
export function dealroomHostComposer(): string {
  return load("src/agent/playbooks/composers/dealroom-host-composer.md");
}

// negotiation.md deleted in PR3 — content merged into dealroom-guest-composer.md
// as the "## Negotiation Strategy" section. There is no longer a separate
// negotiationPlaybook() loader. Call sites composed `negotiation + dealroom`;
// they should now load the guest composer alone.

// ── Multi-agent proposal synthesizer (separate feature — /api/negotiator/synthesize) ─
// NOTE: this is NOT the deal-room negotiator. It's the system prompt for the
// agent that compares competing AI-agent research outputs and emits a JSON
// synthesis. Lives in `src/lib/negotiator/` for historical reasons (predates
// the playbooks/ tree). Untouched by PR3 — see composers/MERGE-AUDIT.md.
export function administratorPlaybook(): string {
  return load("src/lib/negotiator/playbooks/administrator.md");
}

// ── Dynamic loader (dispatch-handler uses variable playbookRelativePath) ───
export function loadPlaybook(relativePath: string): string {
  return load(relativePath);
}
