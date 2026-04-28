/**
 * Helpers for invoking the native OS share sheet on a meeting/invite link.
 *
 * Used by the Event Links card, the chat MeetLinkCard, and the thread-panel
 * info bar. Keeping the title/text shape in one place prevents drift between
 * surfaces — the share-sheet preview should read as a friendly invite, never
 * leak internal vocabulary like "Primary link".
 */

export interface ShareInviteOptions {
  url: string;
  /** Per-event invite topic (e.g. "Coffee chat"). Used when the host is
   *  forwarding a link tied to one specific meeting. */
  topic?: string;
  /** Friendly bucket name when there's no specific topic but the link is
   *  more than the generic primary (e.g. "Office Hours"). Ignored if
   *  `topic` is provided. */
  bucket?: string;
}

export interface SharePayload {
  title: string;
  text: string;
  url: string;
}

export function buildShareInvite({ url, topic, bucket }: ShareInviteOptions): SharePayload {
  if (topic && topic.trim()) {
    const t = topic.trim();
    return {
      title: `Book time — ${t}`,
      text: `Find a time for ${t}:`,
      url,
    };
  }
  if (bucket && bucket.trim()) {
    const b = bucket.trim();
    return {
      title: b,
      text: `Find a time during ${b}:`,
      url,
    };
  }
  return {
    title: "Book time with me",
    text: "Find a time that works:",
    url,
  };
}

export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export async function shareInvite(
  opts: ShareInviteOptions,
): Promise<"shared" | "unsupported" | "aborted"> {
  if (!canNativeShare()) return "unsupported";
  try {
    await navigator.share(buildShareInvite(opts));
    return "shared";
  } catch {
    // AbortError = user dismissed the sheet. Treat all rejections as aborts.
    return "aborted";
  }
}
