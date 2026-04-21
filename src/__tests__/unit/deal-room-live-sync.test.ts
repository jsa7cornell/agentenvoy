import { describe, expect, it } from "vitest";
import {
  isTempId,
  mergePollResult,
  type LiveSyncMessage,
} from "@/lib/deal-room-live-sync";

describe("isTempId", () => {
  it("accepts Date.now()-style numeric timestamps", () => {
    const now = Date.now().toString();
    expect(isTempId(now)).toBe(true);
    expect(isTempId((Date.now() + 1).toString())).toBe(true);
  });

  it("rejects greeting / error / directive sentinels", () => {
    expect(isTempId("greeting")).toBe(false);
    expect(isTempId("error-1700000000000")).toBe(false);
    expect(isTempId("directive-1700000000000")).toBe(false);
  });

  it("rejects CUID-style server ids", () => {
    expect(isTempId("clrr8xjxv0000qpt7abcdefgh")).toBe(false);
    expect(isTempId("cmo909lkz0009qpt71hd74e89")).toBe(false);
  });

  it("rejects numeric strings that aren't plausible ms timestamps", () => {
    expect(isTempId("0")).toBe(false);
    expect(isTempId("123")).toBe(false);
    expect(isTempId("1699999999999")).toBe(false); // just below cutoff
  });

  it("rejects empty / malformed", () => {
    expect(isTempId("")).toBe(false);
    expect(isTempId("12a34")).toBe(false);
    expect(isTempId("-1700000000001")).toBe(false); // sign breaks /^\d+$/
  });
});

describe("mergePollResult", () => {
  const tempId = () => String(Date.now() + Math.floor(Math.random() * 1000));

  it("swaps a temp-id local row for a content-matched server row in place", () => {
    const tempUserId = tempId();
    const tempAssistantId = tempId();
    const local: LiveSyncMessage[] = [
      { id: "greeting", role: "administrator", content: "hi" },
      { id: tempUserId, role: "guest", content: "hello there" },
      { id: tempAssistantId, role: "administrator", content: "hi back" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-greeting", role: "administrator", content: "hi", createdAt: "2026-04-21T12:00:00.000Z" },
      { id: "srv-user", role: "guest", content: "hello there", createdAt: "2026-04-21T12:00:05.000Z" },
      { id: "srv-admin", role: "administrator", content: "hi back", createdAt: "2026-04-21T12:00:06.000Z" },
    ];

    const merged = mergePollResult(local, server);

    // Greeting's local id "greeting" is NOT a temp id, so it does NOT
    // content-match the server's "srv-greeting" row — that row appends.
    // The two temp-id rows get swapped in place. Expected: 4 total
    // (greeting local, greeting server, swapped user, swapped admin).
    expect(merged).toHaveLength(4);
    const userRow = merged.find((m) => m.role === "guest");
    expect(userRow?.id).toBe("srv-user");
    expect(userRow?.content).toBe("hello there");
    const adminRow = merged.find((m) => m.role === "administrator" && m.content === "hi back");
    expect(adminRow?.id).toBe("srv-admin");
    // The original temp ids should be gone.
    expect(merged.find((m) => m.id === tempUserId)).toBeUndefined();
    expect(merged.find((m) => m.id === tempAssistantId)).toBeUndefined();
  });

  it("preserves local order when swapping temp ids", () => {
    const tempA = tempId();
    const tempB = String(Number(tempA) + 1);
    const local: LiveSyncMessage[] = [
      { id: tempA, role: "guest", content: "first" },
      { id: tempB, role: "administrator", content: "second" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-a", role: "guest", content: "first", createdAt: new Date().toISOString() },
      { id: "srv-b", role: "administrator", content: "second", createdAt: new Date().toISOString() },
    ];
    const merged = mergePollResult(local, server);
    expect(merged.map((m) => m.id)).toEqual(["srv-a", "srv-b"]);
  });

  it("dedupes by server id when the row is already present", () => {
    const local: LiveSyncMessage[] = [
      { id: "srv-1", role: "guest", content: "x", createdAt: "2026-04-21T12:00:00.000Z" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-1", role: "guest", content: "x", createdAt: "2026-04-21T12:00:00.000Z" },
    ];
    const merged = mergePollResult(local, server);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("srv-1");
  });

  it("appends new server messages that have no local counterpart", () => {
    const local: LiveSyncMessage[] = [
      { id: "greeting", role: "administrator", content: "welcome" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-new", role: "guest", content: "incoming from remote", createdAt: new Date().toISOString() },
    ];
    const merged = mergePollResult(local, server);
    expect(merged).toHaveLength(2);
    expect(merged[1].id).toBe("srv-new");
    expect(merged[1].content).toBe("incoming from remote");
  });

  it("does NOT swap when content differs (even same role + close time)", () => {
    const tempIdStr = tempId();
    const local: LiveSyncMessage[] = [
      { id: tempIdStr, role: "guest", content: "hello", createdAt: "2026-04-21T12:00:00.000Z" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-x", role: "guest", content: "hi", createdAt: "2026-04-21T12:00:01.000Z" },
    ];
    const merged = mergePollResult(local, server);
    // No swap — temp row stays, server row appends.
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(tempIdStr);
    expect(merged[1].id).toBe("srv-x");
  });

  it("does NOT swap when timestamps differ by more than 5s", () => {
    const tempIdStr = tempId();
    const local: LiveSyncMessage[] = [
      { id: tempIdStr, role: "guest", content: "hello", createdAt: "2026-04-21T12:00:00.000Z" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-x", role: "guest", content: "hello", createdAt: "2026-04-21T12:00:10.000Z" },
    ];
    const merged = mergePollResult(local, server);
    expect(merged).toHaveLength(2);
  });

  it("treats two temp-id rows across back-to-back polls as preliminary vs authoritative", () => {
    // Guest sends a message → optimistic temp bubble in local state.
    // Poll #1 arrives mid-stream before stream closes — temp-id bubble
    // content-matches the server row; swap happens in place.
    const userTemp = tempId();
    const local: LiveSyncMessage[] = [
      { id: userTemp, role: "guest", content: "one" },
    ];
    const poll1: LiveSyncMessage[] = [
      { id: "srv-user-1", role: "guest", content: "one", createdAt: new Date().toISOString() },
    ];
    const afterPoll1 = mergePollResult(local, poll1);
    expect(afterPoll1).toHaveLength(1);
    expect(afterPoll1[0].id).toBe("srv-user-1");

    // Poll #2 — same server row still there; id dedup keeps it at 1.
    const afterPoll2 = mergePollResult(afterPoll1, poll1);
    expect(afterPoll2).toHaveLength(1);
    expect(afterPoll2[0].id).toBe("srv-user-1");
  });

  it("accepts a content match without createdAt on the local side", () => {
    // The optimistic user bubble in handleSend doesn't stamp createdAt.
    const userTemp = tempId();
    const local: LiveSyncMessage[] = [
      { id: userTemp, role: "guest", content: "no timestamp here" },
    ];
    const server: LiveSyncMessage[] = [
      { id: "srv-u", role: "guest", content: "no timestamp here", createdAt: new Date().toISOString() },
    ];
    const merged = mergePollResult(local, server);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("srv-u");
  });
});
