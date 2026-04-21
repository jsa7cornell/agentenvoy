/**
 * Unit tests for `src/lib/external-agent-meta.ts` — the conservative regex
 * set that backs Stage 3 V4 mode-aware meta-narration suppression.
 *
 * Guarded contract:
 *   (a) Known meta-narration phrases from the Danny report (cmo909lkz) + §7
 *       of the decided proposal are detected.
 *   (b) Ordinary Envoy dialog — proposals, confirmations, location notes,
 *       reschedule prompts — is NOT detected. The regex must be narrow
 *       enough that non-meta Envoy responses never get swept into V4
 *       suppression.
 *   (c) `agentIdentityFrom` returns stable primer keys: the
 *       `delegateSpeaker.name` when present, "unknown-agent" otherwise.
 */
import { describe, it, expect } from "vitest";
import {
  isExternalAgentMetaNarration,
  agentIdentityFrom,
} from "@/lib/external-agent-meta";

describe("isExternalAgentMetaNarration — V4 suppression regex", () => {
  describe("positive — meta-narration phrases to strip", () => {
    const positives: Array<[string, string]> = [
      [
        "Danny-report exact phrase",
        "The message above is from another AI agent scheduling on Danny's behalf — noted.",
      ],
      [
        "variant with lowercase ai agent",
        "This message is from another ai agent, noted.",
      ],
      [
        "scheduling on someone's behalf framing",
        "Ah — scheduling on Danny's behalf. Got it.",
      ],
      [
        "this is an AI agent declaration",
        "This is an AI agent posting on the shared channel.",
      ],
      [
        "this is another AI agent variant",
        "Noting that this is another AI agent speaking up.",
      ],
    ];
    for (const [label, content] of positives) {
      it(label, () => {
        expect(isExternalAgentMetaNarration(content)).toBe(true);
      });
    }
  });

  describe("negative — ordinary Envoy prose must NOT match", () => {
    const negatives: Array<[string, string]> = [
      [
        "simple proposal",
        "How about Tuesday at 3pm Pacific — does that work?",
      ],
      [
        "confirmation line",
        "Locked in for Tuesday 3:00pm. You'll get a calendar invite shortly.",
      ],
      [
        "reschedule offer",
        "Happy to move this — let me know a better window.",
      ],
      [
        "location note",
        "John mentioned he'll be in Baja through April 20 if that changes anything.",
      ],
      [
        "generic 'agent' mention without AI framing",
        "I'll check with my agent and get back to you.",
      ],
      [
        "word 'behalf' without scheduling context",
        "On behalf of the team, thanks for the patience!",
      ],
      [
        "empty string",
        "",
      ],
    ];
    for (const [label, content] of negatives) {
      it(label, () => {
        expect(isExternalAgentMetaNarration(content)).toBe(false);
      });
    }
  });
});

describe("agentIdentityFrom — primer key derivation", () => {
  it("returns delegateSpeaker.name when present", () => {
    expect(
      agentIdentityFrom({ delegateSpeaker: { name: "Danny Bot" } }),
    ).toBe("Danny Bot");
  });

  it("trims whitespace from the name", () => {
    expect(
      agentIdentityFrom({ delegateSpeaker: { name: "  Danny Bot  " } }),
    ).toBe("Danny Bot");
  });

  it("falls back to unknown-agent when name is missing", () => {
    expect(agentIdentityFrom({ delegateSpeaker: {} })).toBe("unknown-agent");
  });

  it("falls back when delegateSpeaker is null", () => {
    expect(agentIdentityFrom({ delegateSpeaker: null })).toBe("unknown-agent");
  });

  it("falls back when metadata is null", () => {
    expect(agentIdentityFrom(null)).toBe("unknown-agent");
  });

  it("falls back when metadata is undefined", () => {
    expect(agentIdentityFrom(undefined)).toBe("unknown-agent");
  });

  it("falls back when name is empty string", () => {
    expect(agentIdentityFrom({ delegateSpeaker: { name: "" } })).toBe(
      "unknown-agent",
    );
  });
});
