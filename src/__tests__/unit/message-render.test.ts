import { describe, it, expect } from "vitest";
import { stripRendererOnlyBlocks } from "@/lib/message-render";

describe("stripRendererOnlyBlocks", () => {
  it("strips a DELEGATE_SPEAKER tag inline with prose", () => {
    const input =
      'The message above is from another AI agent scheduling on Danny\'s behalf — noted.\n\n[DELEGATE_SPEAKER]{"kind":"ai_agent"}[/DELEGATE_SPEAKER]\n\n3 PM ET / 12 PM PT works — that\'s John\'s preferred slot.';
    const out = stripRendererOnlyBlocks(input);
    expect(out).not.toContain("[DELEGATE_SPEAKER]");
    expect(out).toContain("The message above is from another AI agent");
    expect(out).toContain("3 PM ET / 12 PM PT works");
  });

  it("strips an ACTION block mid-stream (collapses surrounding whitespace)", () => {
    // Matches the original server-side regex behavior: the leading/trailing
    // `\s*` in the strip pattern intentionally consumes surrounding spaces
    // and newlines so a block on its own line doesn't leave a blank gap.
    const input =
      'Setting that up now.\n[ACTION]{"action":"create_link","params":{}}[/ACTION]\nOffering tonight 5:15 PM.';
    expect(stripRendererOnlyBlocks(input)).toBe(
      "Setting that up now.Offering tonight 5:15 PM.",
    );
  });

  it("strips a STATUS_UPDATE block (collapses surrounding whitespace)", () => {
    const input =
      'Confirmed.\n[STATUS_UPDATE]{"status":"agreed","label":"Locked in"}[/STATUS_UPDATE]\nSee you then.';
    expect(stripRendererOnlyBlocks(input)).toBe("Confirmed.See you then.");
  });

  it("strips multiple blocks in one message", () => {
    const input =
      'Hi! [DELEGATE_SPEAKER]{"kind":"ai_agent"}[/DELEGATE_SPEAKER] Booking. [ACTION]{"action":"create_link"}[/ACTION] Done.';
    // Whitespace collapses same as server-side stripper.
    expect(stripRendererOnlyBlocks(input)).toBe("Hi!Booking.Done.");
  });

  it("hides a partial (unclosed) tag until the closer streams in", () => {
    // 2026-05-11 — strip mid-stream partial blocks so raw JSON doesn't
    // flash as a chat bubble before the closing tag arrives. Once the
    // next chunk delivers `[/TAG]`, the complete-block strip in the
    // first pass handles it.
    const input = 'Hi! [DELEGATE_SPEAKER]{"kind":"ai_age';
    expect(stripRendererOnlyBlocks(input)).toBe("Hi!");
  });

  it("hides a trailing partial ACTION block (the JSON-flash repro)", () => {
    // Production-observed shape (John, 2026-05-11): mid-stream the LLM
    // has emitted `[ACTION]{"action":"update_location",...` but the
    // closer hasn't landed yet — the raw JSON flashed as a bubble.
    const input = 'Got it — updated location to San Jose.\n[ACTION]{"action":"update_location","params":{';
    expect(stripRendererOnlyBlocks(input)).toBe("Got it — updated location to San Jose.");
  });

  it("is a no-op on clean text", () => {
    const input = "Hey Danny, 3 PM EDT works.";
    expect(stripRendererOnlyBlocks(input)).toBe(input);
  });

  it("handles a JSON payload containing newlines (the .* vs [\\s\\S] divergence)", () => {
    // The original server-side regex used `.*?` without `s` flag — embedded
    // newlines in the JSON payload would leak through. The shared helper
    // uses `[\s\S]*?` so multiline payloads strip cleanly.
    const input =
      'Hi!\n[DELEGATE_SPEAKER]{\n  "kind":"ai_agent",\n  "name":"OpenClaw"\n}[/DELEGATE_SPEAKER]\nOK.';
    expect(stripRendererOnlyBlocks(input)).toBe("Hi!OK.");
  });
});
