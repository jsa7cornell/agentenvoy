"use client";

/**
 * WelcomeCelebration — fired at the end of the Tune-preferences sub-path
 * of onboarding.
 *
 * Visual contract: mockups/mobile-v2.html §1 Frame 5 + desktop-v2.html §2.
 * Sparkles + gradient headline + standard-link card with Copy + "→ Back to
 * chat" next-step CTA. Lighter than the guest-side calendar-connect
 * celebration (`celebration-banner.tsx` + `previews/post-onboard-welcome.html`)
 * — this is a host-side moment that drops into the Tune-preferences chat
 * thread alongside the existing flow-completion bubble.
 *
 * The seed-everything default path does NOT trigger this: the welcome itself
 * carries the celebratory tone via the 🎉 H1 + seeded-posture readback +
 * standalone link card. The Tune-preferences sub-path is the only entry
 * point that ends here, and only when the user actively chose to walk the
 * three-question flow.
 *
 * Animations re-use the `celebration-*` classes defined in globals.css and
 * already wired to `prefers-reduced-motion`.
 *
 * Tokens: surface tokens flip automatically across light/dark via
 * `bg-surface` + `border-border`. The gradient backdrop and gradient
 * headline use raw alpha-channel colors per DESIGN.md §2 — they read
 * correctly in both modes (alpha tints layer over `--surface`).
 *
 * Per CODEBASE-CLEANUP item 21 + PROJECT-PLAN Phase 1 PR 4.
 */

import { useState } from "react";

interface WelcomeCelebrationProps {
  /** Host's first name. Falls back to "you" if null/empty. */
  firstName: string | null;
  /** Host's primary link slug (e.g. "john" → agentenvoy.ai/meet/john).
   *  When null, the link card is omitted gracefully. */
  meetSlug: string | null;
  /** Fires when the host taps "Back to chat" — caller dismisses the flow. */
  onDismiss: () => void;
  /** §1n item 4: tap a follow-up chip ("learn more" / "create a meeting").
   *  Caller should dismiss the flow AND auto-submit the seed as a chat turn
   *  (same code path as typing + enter). Omit to suppress the chips. */
  onPostFlowSeed?: (seed: string) => void;
}

const SPARKLES: Array<{ top: string; left: string; delay: string; color: string }> = [
  { top: "18%", left: "16%", delay: "0.6s", color: "#6ee7b7" },
  { top: "72%", left: "22%", delay: "0.9s", color: "#a78bfa" },
  { top: "26%", left: "82%", delay: "1.1s", color: "#6ee7b7" },
  { top: "78%", left: "86%", delay: "1.3s", color: "#a78bfa" },
];

export function WelcomeCelebration({
  firstName,
  meetSlug,
  onDismiss,
  onPostFlowSeed,
}: WelcomeCelebrationProps) {
  const [copied, setCopied] = useState(false);
  const meetUrl = meetSlug ? `agentenvoy.ai/meet/${meetSlug}` : null;
  const headline = firstName ? `You're all set, ${firstName}.` : "You're all set.";

  const copyLink = () => {
    if (!meetUrl) return;
    navigator.clipboard.writeText(`https://${meetUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="celebration-banner relative self-stretch flex flex-col items-center gap-2.5 rounded-2xl border px-4 py-5 text-center overflow-hidden mt-1.5"
      style={{
        background:
          "linear-gradient(135deg, rgba(16,185,129,0.18) 0%, rgba(99,102,241,0.18) 100%)",
        borderColor: "rgba(110,231,183,0.4)",
      }}
      role="status"
      aria-live="polite"
    >
      {/* Radial glow — same animation token as celebration-banner */}
      <div
        className="celebration-glow pointer-events-none absolute"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 160,
          height: 160,
          background:
            "radial-gradient(circle, rgba(110,231,183,0.35), transparent 60%)",
          borderRadius: "50%",
        }}
      />
      {/* Sparkles */}
      <div className="pointer-events-none absolute inset-0 z-[1] overflow-visible">
        {SPARKLES.map((s, i) => (
          <span
            key={`s${i}`}
            className="celebration-sparkle absolute"
            style={{
              top: s.top,
              left: s.left,
              width: 4,
              height: 4,
              background: s.color,
              borderRadius: "50%",
              boxShadow: `0 0 6px ${s.color}`,
              animationDelay: s.delay,
            }}
          />
        ))}
      </div>

      {/* Emoji burst */}
      <div className="celebration-head relative z-[2] text-2xl" aria-hidden="true">
        ✨🎉✨
      </div>

      {/* Gradient headline — emerald → foreground → purple sweep so it
          reads cleanly in both modes; alpha tints + the white/dark middle
          stop give us parity without a `dark:` flip. */}
      <h2
        className="celebration-head relative z-[2] text-base font-semibold m-0 dark:bg-[linear-gradient(90deg,#6ee7b7,#ffffff_60%,#a78bfa)] bg-[linear-gradient(90deg,#047857,#0a0a0f,#4f46e5)]"
        style={{
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {headline}
      </h2>

      {/* Sub-copy */}
      <p className="celebration-sub relative z-[2] text-[12px] text-secondary m-0 leading-snug max-w-[28ch]">
        Share this link and people can book time with you.
        <br />
        I&rsquo;ll handle the rest.
      </p>

      {/* Standard-link card — surface tokens flip across modes */}
      {meetUrl && (
        <div className="celebration-sub relative z-[2] w-full bg-surface border border-border rounded-xl px-3 py-2 flex items-center gap-2">
          <code className="font-mono text-[11px] text-primary truncate flex-1 text-left">
            {meetUrl}
          </code>
          <button
            type="button"
            onClick={copyLink}
            className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold rounded-md transition flex-shrink-0"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {/* Next-step CTA — dismisses the flow back to chat */}
      <button
        type="button"
        onClick={onDismiss}
        className="celebration-sub relative z-[2] text-[12px] text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer mt-0.5"
      >
        → Back to chat
      </button>

      {/* §1n item 4 follow-up chips — give the host a clear next move
          instead of dumping them into a blank chat. */}
      {onPostFlowSeed && (
        <div className="celebration-sub relative z-[2] flex flex-wrap justify-center gap-2 mt-0.5">
          <button
            type="button"
            onClick={() =>
              onPostFlowSeed(
                "Tell me what you can do — show me your most useful features like office hours, group events, and specialty invite links.",
              )
            }
            className="text-[11px] px-3 py-1.5 rounded-full border border-secondary/60 hover:border-purple-500/60 hover:bg-purple-500/5 text-primary transition"
          >
            Learn more
          </button>
          <button
            type="button"
            onClick={() =>
              onPostFlowSeed(
                "Help me coordinate a meeting — let's find a time and set up an invite.",
              )
            }
            className="text-[11px] px-3 py-1.5 rounded-full bg-purple-600 hover:bg-purple-500 text-white font-medium transition"
          >
            Create a meeting
          </button>
        </div>
      )}
    </div>
  );
}
