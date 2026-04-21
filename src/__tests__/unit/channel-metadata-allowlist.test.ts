/**
 * filterMetadataForGuest / mergeChannelMetadata / parseChannelMessageMetadata.
 *
 * Enforces the PII boundary: guest bundles must NOT carry promptContext or
 * overriddenNarration (host-internal fields). If this allowlist drifts,
 * guests see data they shouldn't. See proposals/2026-04-21 §5.3.
 */

import { describe, it, expect } from "vitest";
import {
  filterMetadataForGuest,
  mergeChannelMetadata,
  parseChannelMessageMetadata,
  GUEST_METADATA_ALLOWLIST,
} from "@/lib/channel/metadata-schema";

describe("GUEST_METADATA_ALLOWLIST", () => {
  it("permits only the keys guests are allowed to see", () => {
    expect(GUEST_METADATA_ALLOWLIST.has("kind")).toBe(true);
    expect(GUEST_METADATA_ALLOWLIST.has("threadId")).toBe(true);
    expect(GUEST_METADATA_ALLOWLIST.has("sessionId")).toBe(true);
    expect(GUEST_METADATA_ALLOWLIST.has("linkCode")).toBe(true);
    expect(GUEST_METADATA_ALLOWLIST.has("actions")).toBe(true);
    expect(GUEST_METADATA_ALLOWLIST.has("actionResults")).toBe(true);
    // Explicit denies — regressions here are disclosure incidents.
    expect(GUEST_METADATA_ALLOWLIST.has("promptContext")).toBe(false);
    expect(GUEST_METADATA_ALLOWLIST.has("overriddenNarration")).toBe(false);
    expect(GUEST_METADATA_ALLOWLIST.has("delegateSpeaker")).toBe(false);
  });
});

describe("filterMetadataForGuest", () => {
  it("strips host-only keys", () => {
    const hostMeta = parseChannelMessageMetadata({
      kind: "envoy-turn",
      sessionId: "sess_1",
      actions: [{ action: "x", params: {} }],
      actionResults: [{ action: "x", success: true, message: "ok" }],
      promptContext: {
        systemPrompt: "You are Envoy, a helper for host Jane Doe...",
        modelId: "claude-sonnet-4-6",
      },
      overriddenNarration: "secret",
      delegateSpeaker: { kind: "host-note" },
    });
    const guestMeta = filterMetadataForGuest(hostMeta);
    expect(guestMeta.promptContext).toBeUndefined();
    expect(guestMeta.overriddenNarration).toBeUndefined();
    expect(guestMeta.delegateSpeaker).toBeUndefined();
    expect(guestMeta.kind).toBe("envoy-turn");
    expect(guestMeta.sessionId).toBe("sess_1");
    expect(guestMeta.actions).toHaveLength(1);
    expect(guestMeta.actionResults).toHaveLength(1);
  });

  it("is an identity on empty / null input", () => {
    expect(filterMetadataForGuest(parseChannelMessageMetadata(null))).toEqual({});
    expect(filterMetadataForGuest(parseChannelMessageMetadata({}))).toEqual({});
  });
});

describe("mergeChannelMetadata", () => {
  it("preserves existing keys while adding new ones", () => {
    const existing = { overriddenNarration: "custom", kind: "envoy-turn" };
    const merged = mergeChannelMetadata(existing, {
      actions: [{ action: "create_link", params: {} }],
    });
    expect(merged.overriddenNarration).toBe("custom");
    expect(merged.kind).toBe("envoy-turn");
    expect(merged.actions).toHaveLength(1);
  });

  it("additions override collisions", () => {
    const merged = mergeChannelMetadata(
      { kind: "old" },
      { kind: "new" },
    );
    expect(merged.kind).toBe("new");
  });

  it("handles null / malformed existing gracefully", () => {
    const merged = mergeChannelMetadata(null, { sessionId: "s1" });
    expect(merged.sessionId).toBe("s1");
  });
});

describe("parseChannelMessageMetadata", () => {
  it("returns {} for garbage input", () => {
    expect(parseChannelMessageMetadata("not json")).toEqual({});
    expect(parseChannelMessageMetadata(42)).toEqual({});
  });

  it("validates action shape", () => {
    const parsed = parseChannelMessageMetadata({
      actions: [{ action: "x", params: { foo: 1 } }],
    });
    expect(parsed.actions?.[0].action).toBe("x");
  });
});
