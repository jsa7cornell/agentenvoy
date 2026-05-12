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
import {
  renderActivityVocabMarkdown,
  renderNaturalWindowsMarkdown,
} from "@/lib/activity-vocab";

const cwd = process.cwd();

/**
 * Build-time substitution for canonical vocabulary.
 *
 * Replaces `{{ACTIVITY_VOCAB_TABLE}}` and `{{ACTIVITY_NATURAL_WINDOWS}}` in
 * playbook .md files with markdown rendered from `app/src/lib/activity-vocab.ts`.
 * Single source of truth — adding a new activity is a one-file change.
 *
 * Adding a new placeholder: extend this function. Adding a new playbook that
 * needs substitution: route the readFileSync result through this function in
 * the loader (see calendarEventComposer below as the canonical example).
 */
function applySubstitutions(markdown: string): string {
  return markdown
    .replace(/\{\{ACTIVITY_VOCAB_TABLE\}\}/g, renderActivityVocabMarkdown())
    .replace(/\{\{ACTIVITY_NATURAL_WINDOWS\}\}/g, renderNaturalWindowsMarkdown());
}

// ── Fragments (shared building blocks) ────────────────────────────────────
export function voicePlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/fragments/voice.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load fragments/voice.md: ${err}`);
  }
}
export function groundTruthPlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/fragments/ground-truth.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load fragments/ground-truth.md: ${err}`);
  }
}

// ── Classifiers ────────────────────────────────────────────────────────────
export function hostClassifierPlaybook(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/classifiers/host-classifier.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load classifiers/host-classifier.md: ${err}`);
  }
}
// NOTE: guest classifier (intent-classifier.md) deleted in PR2. No export.

// ── Composers (dashboard chat) ─────────────────────────────────────────────
export function calendarEventComposer(): string {
  try {
    // Substitution applies the canonical activity vocabulary (vocab table,
    // natural windows). The readFileSync call uses a literal string per the
    // Vercel file-tracing invariant at the top of this file.
    return applySubstitutions(
      readFileSync(join(cwd, "src/agent/runtime-prompts/composers/calendar-event-composer.md"), "utf-8"),
    );
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/calendar-event-composer.md: ${err}`);
  }
}
export function inquireComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/composers/inquire-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/inquire-composer.md: ${err}`);
  }
}
export function profileComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/composers/profile-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/profile-composer.md: ${err}`);
  }
}
export function calendarRuleComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/composers/calendar-rule-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/calendar-rule-composer.md: ${err}`);
  }
}

// ── Composers (deal-room) ──────────────────────────────────────────────────
export function dealroomGuestComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/composers/dealroom-guest-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/dealroom-guest-composer.md: ${err}`);
  }
}
export function dealroomHostComposer(): string {
  try {
    return readFileSync(join(cwd, "src/agent/runtime-prompts/composers/dealroom-host-composer.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/dealroom-host-composer.md: ${err}`);
  }
}

// negotiation.md deleted in PR3 — content merged into dealroom-guest-composer.md
// as the "## Negotiation Strategy" section. There is no longer a separate
// negotiationPlaybook() loader.

// ── Unified agent (collapse classifier + composer, 2026-05-06) ────────────
export function unifiedAgentSystemPrompt(): string {
  try {
    const raw = readFileSync(join(cwd, "src/agent/runtime-prompts/composers/unified-agent.md"), "utf-8");
    // Apply `{{ACTIVITY_VOCAB_TABLE}}` and other build-time substitutions so
    // the canonical vocab from `lib/activity-vocab.ts` is the single source.
    return applySubstitutions(raw);
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/unified-agent.md: ${err}`);
  }
}

// ── Unified deal-room agent (Phase A.2, 2026-05-11) ────────────────────────
/**
 * Load the unified deal-room system prompt with role-aware sections resolved.
 *
 * The on-disk markdown carries `{{ROLE}}` placeholder + `<!-- IF-ROLE: host -->`
 * / `<!-- IF-ROLE: guest -->` conditional blocks. This loader substitutes the
 * role string and strips the inactive blocks, returning a single prompt the
 * model sees with no template syntax left.
 *
 * `role` is set per-request by the runner based on whether the host or guest
 * is the speaker on this turn (derived from NextAuth session vs. negotiation
 * session's hostId).
 *
 * Phase A.2 of the deal-room migration. See
 * `proposals/2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer*`
 * §2.4 (one prompt with role awareness — decided 2026-05-11).
 */
export function dealroomUnifiedSystemPrompt(opts: { role: "host" | "guest" }): string {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, "src/agent/runtime-prompts/composers/dealroom-unified.md"), "utf-8");
  } catch (err) {
    throw new Error(`[runtime-prompts/index] failed to load composers/dealroom-unified.md: ${err}`);
  }
  return resolveRoleConditionals(applySubstitutions(raw), opts.role);
}

/**
 * Strip `<!-- IF-ROLE: <other> -->...<!-- END-IF -->` blocks and replace the
 * `{{ROLE}}` placeholder with the active role string.
 *
 * Block syntax (HTML-comment so the markdown still renders cleanly when viewed):
 *
 *     <!-- IF-ROLE: host -->
 *     ...host-only content...
 *     <!-- END-IF -->
 *
 * Same for guest. Non-matching blocks are removed entirely (including the
 * surrounding markers + trailing newline). Matching blocks are preserved with
 * the markers removed. `{{ROLE}}` is then replaced inline with the role string.
 */
function resolveRoleConditionals(markdown: string, role: "host" | "guest"): string {
  const other = role === "host" ? "guest" : "host";
  // 1. Strip inactive blocks (greedy across lines, non-greedy within).
  //    The trailing `\n?` consumes the newline after END-IF so the resolved
  //    prompt doesn't leave double blank lines where blocks used to be.
  const inactiveBlock = new RegExp(
    `<!-- IF-ROLE: ${other} -->[\\s\\S]*?<!-- END-IF -->\\n?`,
    "g",
  );
  let out = markdown.replace(inactiveBlock, "");
  // 2. Unwrap active blocks (keep their content, drop the markers + the
  //    newlines immediately after the opening marker and before the closing).
  const activeOpen = new RegExp(`<!-- IF-ROLE: ${role} -->\\n?`, "g");
  const activeClose = /<!-- END-IF -->\n?/g;
  out = out.replace(activeOpen, "").replace(activeClose, "");
  // 3. Substitute the {{ROLE}} placeholder.
  out = out.replace(/\{\{ROLE\}\}/g, role);
  return out;
}

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
    throw new Error(`[runtime-prompts/index] failed to load proposal-synthesizer/playbooks/administrator.md: ${err}`);
  }
}


