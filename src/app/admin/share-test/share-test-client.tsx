"use client";

/**
 * Client-side playground for the mobile Web Share API and fallbacks.
 * Lets you try `navigator.share` (with and without files) and the
 * deep-link / clipboard / QR fallbacks side-by-side.
 */

import { useEffect, useState } from "react";

type ShareResult =
  | { kind: "idle" }
  | { kind: "ok"; method: string; at: number }
  | { kind: "err"; method: string; message: string; at: number };

const SAMPLE_URL = "https://agentenvoy.ai/jsa7cornell";
const SAMPLE_TITLE = "Book time with John";
const SAMPLE_TEXT = "Pick a time that works — I'll handle the back-and-forth.";

export function ShareTestClient() {
  const [url, setUrl] = useState(SAMPLE_URL);
  const [title, setTitle] = useState(SAMPLE_TITLE);
  const [text, setText] = useState(SAMPLE_TEXT);
  const [result, setResult] = useState<ShareResult>({ kind: "idle" });
  const [support, setSupport] = useState<{
    share: boolean;
    canShareFiles: boolean;
    clipboard: boolean;
    ua: string;
  } | null>(null);

  useEffect(() => {
    const nav = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
    };
    let canShareFiles = false;
    if (typeof nav.canShare === "function") {
      try {
        const probe = new File(["probe"], "probe.txt", { type: "text/plain" });
        canShareFiles = nav.canShare({ files: [probe] });
      } catch {
        canShareFiles = false;
      }
    }
    setSupport({
      share: typeof nav.share === "function",
      canShareFiles,
      clipboard: !!navigator.clipboard?.writeText,
      ua: navigator.userAgent,
    });
  }, []);

  function record(method: string, ok: boolean, message?: string) {
    setResult(
      ok
        ? { kind: "ok", method, at: Date.now() }
        : { kind: "err", method, message: message ?? "unknown error", at: Date.now() },
    );
  }

  async function tryNativeShare() {
    try {
      await navigator.share({ title, text, url });
      record("navigator.share", true);
    } catch (e) {
      const err = e as DOMException;
      // AbortError = user dismissed the sheet — not really a failure.
      record("navigator.share", false, `${err.name}: ${err.message}`);
    }
  }

  async function tryNativeShareWithFile() {
    try {
      // Generate a tiny PNG (1x1 violet pixel) so we can attach a file.
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      const file = new File([bytes], "invite.png", { type: "image/png" });
      await navigator.share({ title, text, url, files: [file] });
      record("navigator.share + file", true);
    } catch (e) {
      const err = e as DOMException;
      record("navigator.share + file", false, `${err.name}: ${err.message}`);
    }
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(url);
      record("clipboard.writeText", true);
    } catch (e) {
      const err = e as Error;
      record("clipboard.writeText", false, err.message);
    }
  }

  function openDeepLink(scheme: "sms" | "mailto" | "whatsapp" | "telegram") {
    const body = `${text} ${url}`;
    let href = "";
    switch (scheme) {
      case "sms":
        href = `sms:?&body=${encodeURIComponent(body)}`;
        break;
      case "mailto":
        href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
        break;
      case "whatsapp":
        href = `https://wa.me/?text=${encodeURIComponent(body)}`;
        break;
      case "telegram":
        href = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
        break;
    }
    window.location.href = href;
    record(`deeplink:${scheme}`, true);
  }

  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold mb-3 text-zinc-100">Share payload</h2>
        <div className="grid gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-violet-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-violet-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Text</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-violet-600 focus:outline-none"
            />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold mb-1 text-zinc-100">Native share sheet</h2>
        <p className="text-xs text-zinc-500 mb-3">
          Opens the OS share sheet on iOS Safari / Android Chrome. Requires HTTPS and a user gesture.
          Most desktop browsers and many in-app webviews don&apos;t support it — fall through to the
          options below.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={tryNativeShare}
            disabled={!support?.share}
            className="rounded bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            navigator.share()
          </button>
          <button
            onClick={tryNativeShareWithFile}
            disabled={!support?.canShareFiles}
            className="rounded bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            navigator.share() + 1×1 PNG
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold mb-1 text-zinc-100">Fallback channels</h2>
        <p className="text-xs text-zinc-500 mb-3">
          For browsers without the Web Share API, or if you want a richer custom sheet.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={copyToClipboard}
            disabled={!support?.clipboard}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 hover:border-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Copy link
          </button>
          <button
            onClick={() => openDeepLink("sms")}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 hover:border-violet-600"
          >
            SMS
          </button>
          <button
            onClick={() => openDeepLink("mailto")}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 hover:border-violet-600"
          >
            Email
          </button>
          <button
            onClick={() => openDeepLink("whatsapp")}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 hover:border-violet-600"
          >
            WhatsApp
          </button>
          <button
            onClick={() => openDeepLink("telegram")}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 hover:border-violet-600"
          >
            Telegram
          </button>
        </div>
        <div className="mt-4 flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrSrc}
            alt="QR code for the share URL"
            className="rounded bg-white p-1"
            width={120}
            height={120}
          />
          <p className="text-xs text-zinc-500 leading-relaxed">
            QR fallback (rendered via api.qrserver.com — swap for an inline QR lib in production).
            Useful on desktop where there&apos;s no share sheet at all.
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold mb-2 text-zinc-100">Result</h2>
        {result.kind === "idle" && (
          <p className="text-xs text-zinc-500">No action yet — click a button above.</p>
        )}
        {result.kind === "ok" && (
          <p className="text-xs text-emerald-400">
            ✓ {result.method} resolved at {new Date(result.at).toLocaleTimeString()}
          </p>
        )}
        {result.kind === "err" && (
          <p className="text-xs text-rose-400">
            ✗ {result.method} — {result.message}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold mb-2 text-zinc-100">Capability detection</h2>
        {!support ? (
          <p className="text-xs text-zinc-500">Detecting…</p>
        ) : (
          <ul className="text-xs space-y-1 text-zinc-400">
            <li>
              <code className="text-zinc-300">navigator.share</code>:{" "}
              <span className={support.share ? "text-emerald-400" : "text-rose-400"}>
                {support.share ? "supported" : "not available"}
              </span>
            </li>
            <li>
              <code className="text-zinc-300">canShare(&#123; files &#125;)</code>:{" "}
              <span className={support.canShareFiles ? "text-emerald-400" : "text-rose-400"}>
                {support.canShareFiles ? "supported" : "not available"}
              </span>
            </li>
            <li>
              <code className="text-zinc-300">clipboard.writeText</code>:{" "}
              <span className={support.clipboard ? "text-emerald-400" : "text-rose-400"}>
                {support.clipboard ? "supported" : "not available"}
              </span>
            </li>
            <li className="break-all">
              <code className="text-zinc-300">userAgent</code>:{" "}
              <span className="text-zinc-500">{support.ua}</span>
            </li>
          </ul>
        )}
      </section>
    </div>
  );
}
