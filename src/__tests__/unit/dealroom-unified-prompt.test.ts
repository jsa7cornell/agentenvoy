/**
 * dealroomUnifiedSystemPrompt — role-aware loader tests.
 *
 * Asserts:
 *   - Both `{role:"host"}` and `{role:"guest"}` resolve cleanly (no template
 *     syntax left, no IF-ROLE blocks remain).
 *   - Each role sees its own conditional blocks; not the other's.
 *   - The `{{ROLE}}` placeholder is substituted.
 *   - Load-bearing markers from the prompt survive (institutional-memory
 *     bridge — if a future edit accidentally removes a key section, the test
 *     fires).
 *
 * Phase A.2 of the deal-room unified-agent migration.
 */

import { describe, it, expect } from "vitest";
import { dealroomUnifiedSystemPrompt } from "@/agent/runtime-prompts";

describe("dealroomUnifiedSystemPrompt — role-aware resolution", () => {
  it("resolves a host prompt with no template syntax left", () => {
    const out = dealroomUnifiedSystemPrompt({ role: "host" });
    expect(out).not.toMatch(/\{\{ROLE\}\}/);
    expect(out).not.toMatch(/<!-- IF-ROLE:/);
    expect(out).not.toMatch(/<!-- END-IF -->/);
  });

  it("resolves a guest prompt with no template syntax left", () => {
    const out = dealroomUnifiedSystemPrompt({ role: "guest" });
    expect(out).not.toMatch(/\{\{ROLE\}\}/);
    expect(out).not.toMatch(/<!-- IF-ROLE:/);
    expect(out).not.toMatch(/<!-- END-IF -->/);
  });

  it("substitutes {{ROLE}} with the active role string", () => {
    const host = dealroomUnifiedSystemPrompt({ role: "host" });
    const guest = dealroomUnifiedSystemPrompt({ role: "guest" });
    // The opening paragraph references {{ROLE}} so both outputs should contain
    // their own role string and not the other's.
    expect(host).toMatch(/identified as \*\*host\*\*/);
    expect(guest).toMatch(/identified as \*\*guest\*\*/);
    expect(host).not.toMatch(/identified as \*\*guest\*\*/);
    expect(guest).not.toMatch(/identified as \*\*host\*\*/);
  });

  it("includes host-only sections only in the host prompt", () => {
    const host = dealroomUnifiedSystemPrompt({ role: "host" });
    const guest = dealroomUnifiedSystemPrompt({ role: "guest" });

    // STEP 0 host framing — only in host prompt.
    expect(host).toMatch(/You are speaking with the host/);
    expect(guest).not.toMatch(/You are speaking with the host/);

    // Account-pref deflection — host-only per §2.6 of the proposal.
    expect(host).toMatch(/head to your dashboard chat/);
    expect(guest).not.toMatch(/head to your dashboard chat/);

    // get_matched_availability scope — guest gets the full rule; host gets the
    // "GUEST-ONLY" carve-out per 2026-04-29 §B2.
    expect(host).toMatch(/get_matched_availability is GUEST-ONLY/);
    expect(guest).not.toMatch(/get_matched_availability is GUEST-ONLY/);
  });

  it("includes guest-only sections only in the guest prompt", () => {
    const host = dealroomUnifiedSystemPrompt({ role: "host" });
    const guest = dealroomUnifiedSystemPrompt({ role: "guest" });

    // STEP 0 guest framing — only in guest prompt.
    expect(guest).toMatch(/You are speaking with the guest/);
    expect(host).not.toMatch(/You are speaking with the guest/);

    // Bilateral availability tool rules — only in guest prompt.
    expect(guest).toMatch(/get_matched_availability — bilateral grounding/);
    expect(host).not.toMatch(/get_matched_availability — bilateral grounding/);

    // Format downgrade ladder — only in guest prompt (host doesn't run progressive
    // disclosure on themselves).
    expect(guest).toMatch(/Format downgrade ladder/);
  });

  it("preserves load-bearing institutional-memory markers on both roles", () => {
    const host = dealroomUnifiedSystemPrompt({ role: "host" });
    const guest = dealroomUnifiedSystemPrompt({ role: "guest" });
    const both = [host, guest];

    // Each marker is one rule the prompt CANNOT lose without breaking a known
    // contract. If a future edit drops one, this test fires.
    const markers: { name: string; pattern: RegExp }[] = [
      { name: "OFFERABLE SLOTS rule", pattern: /## OFFERABLE SLOTS rule/ },
      { name: "DELEGATE_SPEAKER contract", pattern: /\[DELEGATE_SPEAKER\]/ },
      { name: "post-confirm patch-directly (Theme A, 2026-05-11)", pattern: /patch the GCal event directly/i },
      { name: "past-tense confirmation templates (Phase A.5 guard target)", pattern: /Got it — updated location/ },
      { name: "SPEC §2.3 invariants", pattern: /SPEC §2\.3 invariants/ },
      { name: "Day-of-week rule (mandatory)", pattern: /Day-of-week rule \(MANDATORY\)/ },
      { name: "Timezone rule (mandatory)", pattern: /Timezone rule \(MANDATORY\)/ },
      { name: "Dual-tz dual-render rule", pattern: /Dual-render every time reference/ },
      { name: "[LOCKED] semantics", pattern: /\[LOCKED\][^a-zA-Z]+semantics/ },
      { name: "GROUND TRUTH SESSION_ID", pattern: /\[SESSION_ID\]/ },
      { name: "Failure gallery (cmp1nni72-shape)", pattern: /cmp1nni72/ },
    ];

    for (const { name, pattern } of markers) {
      for (const prompt of both) {
        expect(prompt, `Missing marker: ${name}`).toMatch(pattern);
      }
    }
  });

  // 2026-05-12 — capability rules added per the deal-room post-migration
  // triage. Each marker is a load-bearing instruction added in this batch;
  // if any future prompt edit drops them, the model regresses on a known
  // production behavior.
  it("preserves the 2026-05-12 host-authority + guest-symmetry rules", () => {
    const host = dealroomUnifiedSystemPrompt({ role: "host" });
    const guest = dealroomUnifiedSystemPrompt({ role: "guest" });

    // Host can override OFFERABLE SLOTS on their own session (issue #2).
    expect(host).toMatch(/host is the authority on their own calendar/i);
    // Host "cancel" on a live-event session (agreed OR retime_proposed)
    // routes to session_request_reschedule, NOT session_cancel — that's
    // the conceptual model for un-book vs. end-thread (issue #3b).
    // 2026-05-13: widened from `agreed`-only to include `retime_proposed`
    // after feedback report on session cmp49wwuy where retime_proposed +
    // "cancel meeting" failed with contradictory prose.
    expect(host).toMatch(/cancel.*meeting.*on a session with a live event/i);
    expect(host).toMatch(/Do NOT call `session_cancel`/);

    // Guest gets session_update_time but must use OFFERABLE SLOTS (issue
    // #2 symmetry).
    expect(guest).toMatch(/Guest names a SPECIFIC different time/i);
    expect(guest).toMatch(/OFFERABLE SLOTS constraint applies to guest-side edits/i);

    // Guest can cancel a meeting — same un-book mechanics as host (issue
    // #3b symmetry).
    expect(guest).toMatch(/Guest says "cancel"/);
    expect(guest).toMatch(/un-books the slot/i);

    // The OFFERABLE SLOTS section now has the asymmetric framing — must
    // appear in both role variants.
    for (const p of [host, guest]) {
      expect(p).toMatch(/OFFERABLE SLOTS does NOT constrain HOST-DIRECTED time edits/);
    }
  });

  it("uses only placeholder names in worked examples — no real names per Rule 26", () => {
    const host = dealroomUnifiedSystemPrompt({ role: "host" });
    const guest = dealroomUnifiedSystemPrompt({ role: "guest" });

    // Rule 26 (PLAYBOOK.md): runtime prompt files MUST use placeholder names.
    // The model treats every word in these files as a live instruction. The
    // legacy dealroom-guest-composer.md violates this with "John set this up
    // as video"; the new dealroom-unified.md must NOT.
    //
    // Heuristic: scan for common real first names that have appeared in
    // legacy prompts or feedback bundles. Not exhaustive — but if any of
    // these survive, the prompt is leaking. Add more names here as new ones
    // are observed in regressions.
    const sentinelNames = ["John", "Sarah", "Bryan", "Susan", "Marcus", "Calle", "Bobby", "Larry"];
    for (const name of sentinelNames) {
      // Allow `[Name]`-style placeholders and the markdown character `Name`
      // when it appears inside square brackets.
      const real = new RegExp(`(?<!\\[)\\b${name}\\b(?!\\])`);
      expect(host, `Rule 26 violation: real name "${name}" in host prompt`).not.toMatch(real);
      expect(guest, `Rule 26 violation: real name "${name}" in guest prompt`).not.toMatch(real);
    }
  });
});
