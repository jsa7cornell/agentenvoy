/**
 * Canonical playbook loader.
 *
 * PLAYBOOK Rule 19c — all readFileSync calls for .md files go through this
 * module. Direct `readFileSync(*.md)` imports in other files are a Rule 19c
 * violation and will fail the `playbook-rule-19` CI job.
 *
 * PR2 of the 2026-04-27 chat-decisioning-layer-redesign.
 *
 * ── Vercel file-tracing invariant ─────────────────────────────────────────
 * Vercel's @vercel/nft bundler traces files via STATIC ANALYSIS. It detects
 * `readFileSync(join(cwd, "literal/string"))` patterns in the AST; it
 * cannot follow a dynamic variable through a wrapper function.
 *
 * Each exported function therefore calls readFileSync with a STATIC STRING
 * LITERAL directly in the call — this is load-bearing for deployment. The
 * pattern looks redundant (literal path appears twice: in the join arg and
 * in the error message) but it is intentional. Do NOT consolidate the path
 * into a variable — that would break tracing again.
 *
 * When adding a new playbook export, put the literal path string directly
 * inside `readFileSync(join(cwd, "...your/path/here..."))`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const cwd = process.cwd();

// ── Fragments (shared building blocks) ────────────────────────────────────
export function voicePlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/fragments/voice.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load fragments/voice.md: ${err}`);
  }
}
export function groundTruthPlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/fragments/ground-truth.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load fragments/ground-truth.md: ${err}`);
  }
}

// ── Classifiers ────────────────────────────────────────────────────────────
export function hostClassifierPlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/classifiers/host-classifier.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load classifiers/host-classifier.md: ${err}`);
  }
}
// NOTE: guest classifier (intent-classifier.md) deleted in PR2. No export.

// ── Composers (dashboard chat) ─────────────────────────────────────────────
export function calendarEventComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/composers/calendar-event-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load composers/calendar-event-composer.md: ${err}`);
  }
}
export function inquireComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/composers/inquire-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load composers/inquire-composer.md: ${err}`);
  }
}
export function profileComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/composers/profile-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load composers/profile-composer.md: ${err}`);
  }
}
export function calendarRuleComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/composers/calendar-rule-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load composers/calendar-rule-composer.md: ${err}`);
  }
}

// ── Composers (deal-room) ──────────────────────────────────────────────────
export function dealroomGuestComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/composers/dealroom-guest-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load composers/dealroom-guest-composer.md: ${err}`);
  }
}
export function dealroomHostComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/playbooks/composers/dealroom-host-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load composers/dealroom-host-composer.md: ${err}`);
  }
}

// negotiation.md deleted in PR3 — content merged into dealroom-guest-composer.md
// as the "## Negotiation Strategy" section. There is no longer a separate
// negotiationPlaybook() loader.

// ── Multi-agent proposal synthesizer (separate feature — /api/negotiator/synthesize) ─
// NOTE: this is NOT the deal-room negotiator. It's the system prompt for the
// agent that compares competing AI-agent research outputs and emits a JSON
// synthesis. Lives in `src/lib/proposal-synthesizer/` for historical reasons
// (predates the playbooks/ tree). Untouched by PR3 — see composers/MERGE-AUDIT.md.
//
// MUST keep the literal path inline per the file-tracing invariant (top of
// file). Routing this through `loadPlaybook()` would re-introduce the prod
// outage hotfixed in `498277b`.
export function administratorPlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/lib/proposal-synthesizer/playbooks/administrator.md"), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load proposal-synthesizer/playbooks/administrator.md: ${err}`);
  }
}

// ── Dynamic loader (dispatch-handler uses variable playbookRelativePath) ───
// NOTE: dynamic paths cannot be statically traced by @vercel/nft. The files
// loaded here (profile-composer.md, calendar-rule-composer.md) are traced via
// the static exports above — keep their named exports in sync with whatever
// paths dispatch-handler.ts may request at runtime.
export function loadPlaybook(relativePath: string): string {
  try {
    return readFileSync(join(cwd, relativePath), "utf-8");
  } catch (err) {
    throw new Error(`[playbooks/index] failed to load ${relativePath}: ${err}`);
  }
}
