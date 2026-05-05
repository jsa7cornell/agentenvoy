/**
 * JSON-lines stream-parser for the channel-chat response protocol.
 *
 * Protocol: each line of the HTTP response body is one JSON frame:
 *   {"type":"status","stage":"scanning-calendar","copy":"Reading\u2026","seq":1}
 *   {"type":"text","content":"Set up a 45-min video call with Josh\u2026"}
 *
 * Server-side emission: `src/app/api/channel/chat/route.ts`.
 * Proposal: 2026-04-21_envoy-progress-reasoning-narration.
 *
 * Robustness guarantees (§2.4):
 *   - Partial lines buffered until `\n` arrives.
 *   - Garbage lines (JSON parse error, missing `type`) are logged + ignored,
 *     never thrown.
 *   - Duplicate `seq` renders twice (cosmetic).
 *   - Out-of-order `seq` renders in arrival order (`seq` is advisory).
 *   - Only one `type:"text"` frame is expected per response, but if the
 *     server emits multiple the last one wins.
 */

export type ChannelChatFrame =
  | {
      type: "status";
      stage: string;
      copy: string;
      seq?: number;
      /** Optional action kind for `executing` stage — used by consumers that care. */
      action?: string;
    }
  | { type: "text"; content: string }
  | {
      /** Chitchat reaction — emoji placed on the host's message bubble.
       *  Client patches the message in-place; no new envoy bubble is added.
       *  Proposal: chitchat tier. */
      type: "reaction";
      emoji: string;
      messageId: string | null;
    }
  | {
      /** Clarifier turn from the chat intent router when kind === "unclear".
       *  Client renders the `text` as an envoy bubble with `quickReplies`
       *  as pill buttons beneath. Clicking a reply re-submits the original
       *  utterance with `userIntentHint` populated, bypassing the classifier.
       *
       *  Proposal: 2026-04-21_dashboard-chat-intent-router §2.6.
       *
       *  Stale-client degrade: old bundles that don't recognize `clarifier`
       *  drop the whole frame — user sees no response and has to retype.
       *  Documented degrade mode (N8 fold). */
      type: "clarifier";
      text: string;
      quickReplies: Array<{
        label: string;
        // PR-E: "event_action" replaces "schedule" as the cluster hint name.
        // "schedule" kept for stale-client compatibility.
        intent: "event_action" | "inquire" | "schedule";
      }>;
    };

export interface ParsedFrames {
  /** Fully-parsed frames extracted during this call. */
  frames: ChannelChatFrame[];
  /** Number of lines skipped as garbage (for debug / telemetry). */
  skipped: number;
}

/**
 * Stateful parser: feed it chunks of response text, receive whatever complete
 * JSON frames are available. Partial trailing lines stay in the buffer until
 * the next chunk completes them (or `flush()` is called).
 */
export class ChannelChatStreamParser {
  private buffer = "";

  feed(chunk: string): ParsedFrames {
    this.buffer += chunk;
    const out: ChannelChatFrame[] = [];
    let skipped = 0;

    // Process only complete lines (up to the last newline). Everything after
    // the last newline remains in the buffer for the next feed().
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const line = raw.trim();
      if (!line) continue;
      const frame = parseFrame(line);
      if (frame) out.push(frame);
      else skipped++;
    }

    return { frames: out, skipped };
  }

  /**
   * Flush any remaining bytes as a final line (if the server closes without
   * a trailing newline). Returns whatever frames come out of the last chunk.
   */
  flush(): ParsedFrames {
    const line = this.buffer.trim();
    this.buffer = "";
    if (!line) return { frames: [], skipped: 0 };
    const frame = parseFrame(line);
    return frame
      ? { frames: [frame], skipped: 0 }
      : { frames: [], skipped: 1 };
  }
}

function parseFrame(line: string): ChannelChatFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (type === "status") {
    const stage = typeof obj.stage === "string" ? obj.stage : null;
    const copy = typeof obj.copy === "string" ? obj.copy : null;
    if (!stage || !copy) return null;
    const frame: ChannelChatFrame = { type: "status", stage, copy };
    if (typeof obj.seq === "number") frame.seq = obj.seq;
    if (typeof obj.action === "string") frame.action = obj.action;
    return frame;
  }
  if (type === "text") {
    const content = typeof obj.content === "string" ? obj.content : "";
    return { type: "text", content };
  }
  if (type === "clarifier") {
    const text = typeof obj.text === "string" ? obj.text : "";
    if (!text) return null;
    const rawReplies = Array.isArray(obj.quickReplies) ? obj.quickReplies : [];
    const quickReplies = rawReplies
      .map((r) => {
        if (!r || typeof r !== "object") return null;
        const item = r as { label?: unknown; intent?: unknown };
        const label = typeof item.label === "string" ? item.label : "";
        // PR-E: accept "event_action" (new cluster name) and "schedule" (legacy compat).
        const intent =
          item.intent === "event_action" ||
          item.intent === "inquire" ||
          item.intent === "schedule"
            ? (item.intent as "event_action" | "inquire" | "schedule")
            : null;
        if (!label || !intent) return null;
        return { label, intent };
      })
      .filter(
        (r): r is { label: string; intent: "event_action" | "inquire" | "schedule" } =>
          r !== null,
      );
    return { type: "clarifier", text, quickReplies };
  }
  if (type === "reaction") {
    const emoji = typeof obj.emoji === "string" ? obj.emoji : "👍";
    const messageId = typeof obj.messageId === "string" ? obj.messageId : null;
    return { type: "reaction", emoji, messageId };
  }
  return null;
}
