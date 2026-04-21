import { describe, it, expect } from "vitest";
import { ChannelChatStreamParser } from "@/lib/channel-chat-stream";

describe("ChannelChatStreamParser", () => {
  it("parses complete single-line frames", () => {
    const p = new ChannelChatStreamParser();
    const { frames } = p.feed(
      '{"type":"status","stage":"scanning-calendar","copy":"Reading\u2026","seq":1}\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "status", stage: "scanning-calendar", seq: 1 });
  });

  it("buffers partial lines until a newline arrives", () => {
    const p = new ChannelChatStreamParser();
    const a = p.feed('{"type":"status","stage":"scor');
    expect(a.frames).toHaveLength(0);
    const b = p.feed('ing","copy":"Scoring\u2026","seq":2}\n');
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]).toMatchObject({ type: "status", stage: "scoring" });
  });

  it("skips garbage frames without throwing", () => {
    const p = new ChannelChatStreamParser();
    const { frames, skipped } = p.feed(
      "not-json-at-all\n" +
        '{"type":"status","stage":"thinking","copy":"Thinking\u2026"}\n' +
        '{"no-type":"here"}\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "status", stage: "thinking" });
    expect(skipped).toBe(2);
  });

  it("skips frames missing required fields", () => {
    const p = new ChannelChatStreamParser();
    const { frames, skipped } = p.feed(
      '{"type":"status","copy":"no stage"}\n' +
        '{"type":"status","stage":"only-stage"}\n',
    );
    expect(frames).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  it("renders duplicate seq as two separate frames (cosmetic, no dedup)", () => {
    const p = new ChannelChatStreamParser();
    const { frames } = p.feed(
      '{"type":"status","stage":"thinking","copy":"A","seq":3}\n' +
        '{"type":"status","stage":"thinking","copy":"A","seq":3}\n',
    );
    expect(frames).toHaveLength(2);
  });

  it("preserves arrival order for out-of-order seq", () => {
    const p = new ChannelChatStreamParser();
    const { frames } = p.feed(
      '{"type":"status","stage":"a","copy":"1","seq":5}\n' +
        '{"type":"status","stage":"b","copy":"2","seq":1}\n' +
        '{"type":"status","stage":"c","copy":"3","seq":3}\n',
    );
    expect(frames.map((f) => f.type === "status" && f.stage)).toEqual(["a", "b", "c"]);
  });

  it("renders text frame with empty content as empty string", () => {
    const p = new ChannelChatStreamParser();
    const { frames } = p.feed('{"type":"text"}\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: "text", content: "" });
  });

  it("ignores unknown frame types", () => {
    const p = new ChannelChatStreamParser();
    const { frames, skipped } = p.feed('{"type":"meta","version":2}\n');
    expect(frames).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("parses clarifier frame with schedule+inquire quick-replies", () => {
    const p = new ChannelChatStreamParser();
    const line =
      '{"type":"clarifier","text":"Did you mean to schedule or inquire?","quickReplies":[{"label":"Book it","intent":"schedule"},{"label":"My defaults","intent":"inquire"}]}\n';
    const { frames } = p.feed(line);
    expect(frames).toHaveLength(1);
    const f = frames[0];
    expect(f.type).toBe("clarifier");
    if (f.type === "clarifier") {
      expect(f.text).toBe("Did you mean to schedule or inquire?");
      expect(f.quickReplies).toEqual([
        { label: "Book it", intent: "schedule" },
        { label: "My defaults", intent: "inquire" },
      ]);
    }
  });

  it("drops stub-tier quick-replies in clarifier frames", () => {
    const p = new ChannelChatStreamParser();
    const line =
      '{"type":"clarifier","text":"?","quickReplies":[{"label":"Profile","intent":"profile"},{"label":"Rule","intent":"rule"},{"label":"Book","intent":"schedule"}]}\n';
    const { frames } = p.feed(line);
    expect(frames).toHaveLength(1);
    const f = frames[0];
    if (f.type === "clarifier") {
      expect(f.quickReplies).toEqual([{ label: "Book", intent: "schedule" }]);
    }
  });

  it("skips clarifier frame with empty text", () => {
    const p = new ChannelChatStreamParser();
    const { frames, skipped } = p.feed(
      '{"type":"clarifier","text":"","quickReplies":[]}\n',
    );
    expect(frames).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("flush() consumes a trailing line without newline", () => {
    const p = new ChannelChatStreamParser();
    p.feed('{"type":"status","stage":"x","copy":"y"}');
    const { frames } = p.flush();
    expect(frames).toHaveLength(1);
  });

  it("handles empty lines between frames", () => {
    const p = new ChannelChatStreamParser();
    const { frames } = p.feed(
      '{"type":"status","stage":"a","copy":"1"}\n\n' +
        '{"type":"status","stage":"b","copy":"2"}\n',
    );
    expect(frames).toHaveLength(2);
  });

  it("handles frames split across many small chunks", () => {
    const p = new ChannelChatStreamParser();
    const full = '{"type":"status","stage":"scanning-calendar","copy":"Reading\u2026","seq":1}\n';
    let frames: unknown[] = [];
    for (const ch of full) {
      const r = p.feed(ch);
      frames = frames.concat(r.frames);
    }
    expect(frames).toHaveLength(1);
  });
});
