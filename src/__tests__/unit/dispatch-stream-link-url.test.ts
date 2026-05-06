/**
 * Link-URL resolution policy for dispatch-stream (2026-05-06).
 *
 * Background: 23239b8 broadened the dispatcher's `linkUrls` filter so it
 * appended `data.url` (not just `data.linkUrl`) to the envoy turn's
 * displayText. That made `MeetLinkCard` render for `create_link` turns
 * (which return `data.url`) — but it also meant the URL appeared TWICE
 * in the chat bubble: once as a trailing line in `msg.content`, and
 * once as the card graphic underneath.
 *
 * The 2026-05-06 fix: persist link URL into `metadata.linkUrl` instead;
 * `feed.tsx` reads from metadata first (regex fallback for legacy rows).
 * The displayText append is narrowed back to `data.linkUrl` only — that
 * preserves the legacy text-share behavior for `update_availability_rule`
 * (bookable case) where the URL is the visible payload of the turn.
 *
 * The strip guard `b0064ca` (`url-in-narration-strip`) remains intact as
 * defense-in-depth against composer-prose URL regressions.
 */
import { describe, it, expect } from "vitest";
import {
  resolveLinkUrlsForTurn,
  type LinkUrlResolverActionResult,
} from "@/agent/modules/_shared/dispatch-stream";

const CREATE_LINK_URL = "https://agentenvoy.ai/meet/johnanderson/b4x9hy";
const BOOKABLE_LINK_URL = "https://agentenvoy.ai/meet/johnanderson/office-hours";

describe("resolveLinkUrlsForTurn — create_link (data.url)", () => {
  it("regression test for the 2026-05-05 bug: data.url is persisted to metadata.linkUrl but NOT appended to displayText", () => {
    const actionResults: LinkUrlResolverActionResult[] = [
      { success: true, data: { url: CREATE_LINK_URL } },
    ];
    const composerProse = "Set up a 30-min video call with Larry.";
    const { displayText, linkUrl } = resolveLinkUrlsForTurn(actionResults, composerProse);

    expect(linkUrl).toBe(CREATE_LINK_URL);
    expect(displayText).toBe(composerProse);
    expect(displayText).not.toContain(CREATE_LINK_URL);
  });
});

describe("resolveLinkUrlsForTurn — back-compat (data.linkUrl)", () => {
  it("update_availability_rule's data.linkUrl IS appended to displayText AND persisted to metadata", () => {
    const actionResults: LinkUrlResolverActionResult[] = [
      { success: true, data: { linkUrl: BOOKABLE_LINK_URL } },
    ];
    const composerProse = "Updated your office-hours bookable link.";
    const { displayText, linkUrl } = resolveLinkUrlsForTurn(actionResults, composerProse);

    expect(linkUrl).toBe(BOOKABLE_LINK_URL);
    expect(displayText).toContain(BOOKABLE_LINK_URL);
    expect(displayText.startsWith(composerProse)).toBe(true);
  });
});

describe("resolveLinkUrlsForTurn — no URL emitted", () => {
  it("returns displayText unchanged and linkUrl undefined when no successful action result carries a URL", () => {
    const actionResults: LinkUrlResolverActionResult[] = [
      { success: true, data: { sessionId: "abc" } as { url?: unknown; linkUrl?: unknown } },
      { success: false, data: { url: "should-be-ignored-failed-action" } },
    ];
    const composerProse = "Done.";
    const { displayText, linkUrl } = resolveLinkUrlsForTurn(actionResults, composerProse);

    expect(linkUrl).toBeUndefined();
    expect(displayText).toBe(composerProse);
  });

  it("returns displayText unchanged when actionResults is empty", () => {
    const composerProse = "Acknowledged.";
    const { displayText, linkUrl } = resolveLinkUrlsForTurn([], composerProse);
    expect(linkUrl).toBeUndefined();
    expect(displayText).toBe(composerProse);
  });
});

describe("resolveLinkUrlsForTurn — both data.linkUrl and data.url present", () => {
  it("prefers data.linkUrl as the canonical URL", () => {
    const actionResults: LinkUrlResolverActionResult[] = [
      {
        success: true,
        data: { linkUrl: BOOKABLE_LINK_URL, url: "https://example.com/other" },
      },
    ];
    const { displayText, linkUrl } = resolveLinkUrlsForTurn(actionResults, "ok");
    expect(linkUrl).toBe(BOOKABLE_LINK_URL);
    expect(displayText).toContain(BOOKABLE_LINK_URL);
    expect(displayText).not.toContain("https://example.com/other");
  });
});
