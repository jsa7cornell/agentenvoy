/**
 * `url-in-narration-strip` postStream guard tests.
 *
 * Covers the failure mode reported 2026-05-05 (twice in one day):
 *   - FeedbackReport `cmot617ih001erafmvb6ipl4g` (Larry, AM)
 *   - FeedbackReport `cmotc57cz0018v8lwellbeziv` (Katie, PM)
 *
 * The composer in `event_action` trails the /meet/<slug>/<code> link URL
 * after its narration whenever it emits create_link / update_link. The link
 * card UI renders below and shows the same URL; the trailing line in prose
 * is redundant and visually noisy. User: "link url showing up in the message
 * - this is unnecessary b/c the event card shows up."
 *
 * Design: structural strip via postStream guard cluster-scoped to event_action.
 * Single-pass cleanup, NOT advisory retry — the composer didn't lie, it was
 * just redundant. Returns `kind: "rewrite"` so the runner replaces text in
 * place without reinvoking the LLM.
 */
import { describe, it, expect } from "vitest";
import {
  needsUrlInNarrationStrip,
  stripMeetUrlFromNarration,
  urlInNarrationStripGuard,
} from "@/agent/modules/_shared/post-stream-guards";
import type { ActionRequest } from "@/agent/actions";

const moduleContext = {
  user: { id: "u1", name: null, email: "u@e" },
  surface: "dashboard-host" as const,
};

const createLinkAction: ActionRequest = { action: "create_link", params: {} };
const updateLinkAction: ActionRequest = { action: "update_link", params: {} };

// ---------------------------------------------------------------------------
// Detector — needsUrlInNarrationStrip + stripMeetUrlFromNarration
// ---------------------------------------------------------------------------

describe("needsUrlInNarrationStrip — true positives", () => {
  it("flags Larry-shape: trailing /meet/ URL after blank line", () => {
    const text =
      "Set up a 30-min video call with Larry — offering Thursday May 7 first, then any day next week (May 11–16) if that doesn't work.\n\nhttps://agentenvoy.ai/meet/johnanderson/b4x9hy";
    expect(needsUrlInNarrationStrip(text)).toBe(true);
  });

  it("flags Katie-shape: trailing /meet/ URL after blank line", () => {
    const text =
      "Set up a 30-min video call with Katie for tomorrow, May 6. Since she's VIP, I've flagged the link to reach into protected time. Let me know any tweaks.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    expect(needsUrlInNarrationStrip(text)).toBe(true);
  });

  it("flags http://localhost dev URL with /meet/ shape", () => {
    const text = "Done.\n\nhttp://localhost:3000/meet/testhost/abc123";
    expect(needsUrlInNarrationStrip(text)).toBe(true);
  });

  it("flags URL embedded mid-sentence", () => {
    const text =
      "Your link https://agentenvoy.ai/meet/johnanderson/k6jz27 is ready.";
    expect(needsUrlInNarrationStrip(text)).toBe(true);
  });
});

describe("needsUrlInNarrationStrip — true negatives", () => {
  it("does NOT flag prose with no URL", () => {
    expect(
      needsUrlInNarrationStrip("Set up the call for tomorrow morning."),
    ).toBe(false);
  });

  it("does NOT flag a non-/meet/ URL (out of scope)", () => {
    expect(
      needsUrlInNarrationStrip(
        "Your invite is at https://google.com/calendar/event?eid=abc",
      ),
    ).toBe(false);
  });

  it("does NOT flag empty text", () => {
    expect(needsUrlInNarrationStrip("")).toBe(false);
  });

  it("does NOT flag a /meet/ URL at root only (slug, no code)", () => {
    // The bookable-link landing page (one path segment after /meet/) is a
    // different shape and out of scope for this guard.
    expect(
      needsUrlInNarrationStrip(
        "Your bookable link is at https://agentenvoy.ai/meet/johnanderson",
      ),
    ).toBe(false);
  });
});

describe("stripMeetUrlFromNarration", () => {
  it("strips trailing URL line plus the leading blank line — Larry-shape", () => {
    const text =
      "Set up a 30-min video call with Larry — offering Thursday May 7 first, then any day next week (May 11–16) if that doesn't work.\n\nhttps://agentenvoy.ai/meet/johnanderson/b4x9hy";
    const result = stripMeetUrlFromNarration(text);
    expect(result).toBe(
      "Set up a 30-min video call with Larry — offering Thursday May 7 first, then any day next week (May 11–16) if that doesn't work.",
    );
  });

  it("strips trailing URL line — Katie-shape", () => {
    const text =
      "Set up a 30-min video call with Katie for tomorrow, May 6. Since she's VIP, I've flagged the link to reach into protected time. Let me know any tweaks.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    const result = stripMeetUrlFromNarration(text);
    expect(result).toBe(
      "Set up a 30-min video call with Katie for tomorrow, May 6. Since she's VIP, I've flagged the link to reach into protected time. Let me know any tweaks.",
    );
  });

  it("strips trailing URL line with single newline (no blank line)", () => {
    const text = "Done.\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    expect(stripMeetUrlFromNarration(text)).toBe("Done.");
  });

  it("strips just the URL token mid-sentence; preserves sentence", () => {
    const text =
      "Your link https://agentenvoy.ai/meet/johnanderson/k6jz27 is ready.";
    expect(stripMeetUrlFromNarration(text)).toBe("Your link is ready.");
  });

  it("strips multiple /meet/ URLs in one response", () => {
    const text =
      "Set up two calls.\n\nhttps://agentenvoy.ai/meet/johnanderson/aaa111\nhttps://agentenvoy.ai/meet/johnanderson/bbb222";
    const result = stripMeetUrlFromNarration(text);
    expect(result).not.toMatch(/agentenvoy\.ai\/meet\//);
  });

  it("does NOT touch non-/meet/ URLs", () => {
    const text =
      "See https://google.com/calendar for context.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    const result = stripMeetUrlFromNarration(text);
    expect(result).toContain("https://google.com/calendar");
    expect(result).not.toContain("/meet/johnanderson/k6jz27");
  });
});

// ---------------------------------------------------------------------------
// Guard wrapper — gated on link-emitting action this turn
// ---------------------------------------------------------------------------

describe("urlInNarrationStripGuard — fires (rewrite)", () => {
  it("rewrites Larry-shape when create_link is among parsedActions", () => {
    const text =
      "Set up a 30-min video call with Larry — offering Thursday May 7 first, then any day next week (May 11–16) if that doesn't work.\n\nhttps://agentenvoy.ai/meet/johnanderson/b4x9hy";
    const result = urlInNarrationStripGuard.check({
      text,
      parsedActions: [createLinkAction],
      moduleContext,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("rewrite");
    if (result?.kind === "rewrite") {
      expect(result.text).not.toContain("/meet/johnanderson/b4x9hy");
      expect(result.text).toContain("Set up a 30-min video call with Larry");
    }
    expect(result?.flaggedReason).toMatch(/url-in-narration/);
  });

  it("rewrites Katie-shape when create_link is among parsedActions", () => {
    const text =
      "Set up a 30-min video call with Katie for tomorrow, May 6. Since she's VIP, I've flagged the link to reach into protected time. Let me know any tweaks.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    const result = urlInNarrationStripGuard.check({
      text,
      parsedActions: [createLinkAction],
      moduleContext,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("rewrite");
    if (result?.kind === "rewrite") {
      expect(result.text).not.toContain("/meet/johnanderson/k6jz27");
    }
  });

  it("rewrites when update_link is the emitting action", () => {
    const text = "Updated.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    const result = urlInNarrationStripGuard.check({
      text,
      parsedActions: [updateLinkAction],
      moduleContext,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("rewrite");
  });

  it("rewrites when create_link is one of several emitted actions", () => {
    const text =
      "Set it up.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    const result = urlInNarrationStripGuard.check({
      text,
      parsedActions: [
        { action: "save_guest_info", params: {} },
        createLinkAction,
      ],
      moduleContext,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("rewrite");
  });
});

describe("urlInNarrationStripGuard — does NOT fire", () => {
  it("does NOT fire when prose has no URL", () => {
    expect(
      urlInNarrationStripGuard.check({
        text: "Set up the call for tomorrow morning.",
        parsedActions: [createLinkAction],
        moduleContext,
      }),
    ).toBeNull();
  });

  it("does NOT fire when no link-emitting action ran (parsedActions: [])", () => {
    // The URL might be informational (e.g. "your existing link is at...").
    const text =
      "Your existing link is at https://agentenvoy.ai/meet/johnanderson/k6jz27";
    expect(
      urlInNarrationStripGuard.check({
        text,
        parsedActions: [],
        moduleContext,
      }),
    ).toBeNull();
  });

  it("does NOT fire when actions emitted but none are link-emitting", () => {
    const text = "Done.\n\nhttps://agentenvoy.ai/meet/johnanderson/k6jz27";
    expect(
      urlInNarrationStripGuard.check({
        text,
        parsedActions: [{ action: "save_guest_info", params: {} }],
        moduleContext,
      }),
    ).toBeNull();
  });

  it("does NOT fire on non-/meet/ URLs even with create_link", () => {
    const text =
      "Created. See https://google.com/calendar/event?eid=abc for the invite.";
    expect(
      urlInNarrationStripGuard.check({
        text,
        parsedActions: [createLinkAction],
        moduleContext,
      }),
    ).toBeNull();
  });

  it("has a stable name", () => {
    expect(urlInNarrationStripGuard.name).toBe("url-in-narration-strip");
  });
});
