"use client";

/**
 * CelebrationBanner — fired when calendars first match in a session.
 *
 * Renders a one-shot animated banner above the matching calendar to mark the
 * moment a guest's OAuth-connected calendar produces its first bilateral
 * matches. Reuses the existing `justMatched` empty→non-empty transition
 * detected in deal-room.tsx (same trigger as <MatchPulse>), but unlike the
 * pulse-ring this is a content card with a checkmark, headline, confetti
 * burst, glow, and sparkles.
 *
 * Per design: no close affordance — banner lingers as the "we made your
 * matches smarter" callout until the user navigates away or refreshes.
 *
 * Reduced-motion: all animations are no-op'd in globals.css; the banner
 * still renders statically with full content.
 */
interface CelebrationBannerProps {
  matchCount: number;
  firstMatchDayLabel?: string; // e.g. "Fri Apr 24" — optional; omitted gracefully
}

const CONFETTI = [
  { color: "#6ee7b7", round: true,  tx: 200,  ty: -90, rot: 280,  size: 8 },
  { color: "#a78bfa", round: false, tx: 320,  ty: -40, rot: -180, size: 8 },
  { color: "#10b981", round: true,  tx: 380,  ty:  60, rot: 360,  size: 8 },
  { color: "#fbbf24", round: false, tx: 440,  ty: -70, rot: -220, size: 8 },
  { color: "#34d399", round: true,  tx: 520,  ty:  30, rot: 180,  size: 8 },
  { color: "#7c3aed", round: false, tx: 580,  ty: -100,rot: -300, size: 6 },
  { color: "#6ee7b7", round: true,  tx: 260,  ty:  70, rot: 200,  size: 6 },
  { color: "#f472b6", round: false, tx: 480,  ty:  90, rot: -160, size: 8 },
  { color: "#a78bfa", round: true,  tx: 150,  ty:  80, rot: 240,  size: 8 },
  { color: "#34d399", round: false, tx: 600,  ty: -30, rot: -260, size: 7 },
];

const SPARKLES: Array<{ top: string; left: string; delay: string; color: string }> = [
  { top: "20%", left: "22%", delay: "0.8s", color: "#6ee7b7" },
  { top: "70%", left: "30%", delay: "1.1s", color: "#a78bfa" },
  { top: "35%", left: "78%", delay: "0.9s", color: "#6ee7b7" },
  { top: "75%", left: "88%", delay: "1.4s", color: "#a78bfa" },
  { top: "25%", left: "60%", delay: "1.6s", color: "#6ee7b7" },
];

export function CelebrationBanner({ matchCount, firstMatchDayLabel }: CelebrationBannerProps) {
  const matchPhrase = (() => {
    if (matchCount <= 0) return "Your matches just got smarter";
    const dayBit = firstMatchDayLabel ? ` on ${firstMatchDayLabel}` : "";
    if (matchCount === 1) return `1 window${dayBit} works for both of you`;
    return `${matchCount} windows${dayBit} work for both of you`;
  })();

  return (
    <div className="mb-3 perspective-1000">
      <div
        className="celebration-banner relative flex items-center gap-4 overflow-hidden rounded-2xl border border-indigo-300 dark:border-indigo-700 bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-950/60 dark:to-violet-950/60 px-5 py-5 shadow-sm"
        role="status"
        aria-live="polite"
      >
        {/* Aurora sweep */}
        <div
          className="celebration-aurora pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(120deg, transparent 0%, rgba(110,231,183,0.4) 45%, rgba(167,139,250,0.3) 55%, transparent 100%)",
            transform: "translateX(-100%)",
          }}
        />
        {/* Radial glow */}
        <div
          className="celebration-glow pointer-events-none absolute"
          style={{
            top: "50%",
            left: "8%",
            transform: "translateY(-50%)",
            width: 120,
            height: 120,
            background: "radial-gradient(circle, rgba(110,231,183,0.4), transparent 60%)",
            borderRadius: "50%",
          }}
        />
        {/* Confetti + sparkles */}
        <div className="pointer-events-none absolute inset-0 z-[1] overflow-visible">
          {CONFETTI.map((c, i) => (
            <span
              key={`c${i}`}
              className="celebration-confetti absolute"
              style={
                {
                  top: "50%",
                  left: "14%",
                  width: c.size,
                  height: c.size,
                  background: c.color,
                  borderRadius: c.round ? "50%" : "0",
                  ["--tx" as string]: `${c.tx}px`,
                  ["--ty" as string]: `${c.ty}px`,
                  ["--rot" as string]: `${c.rot}deg`,
                } as React.CSSProperties
              }
            />
          ))}
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

        {/* Checkmark */}
        <div className="relative z-[2] h-12 w-12 flex-shrink-0">
          <div
            className="celebration-check-bg absolute inset-0 rounded-full"
            style={{
              background: "linear-gradient(135deg, #6ee7b7, #10b981)",
              boxShadow: "0 0 0 0 rgba(110,231,183,0.6), 0 0 32px rgba(16,185,129,0.6)",
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path
                className="celebration-check-path"
                d="M5 12 L10 17 L19 7"
                stroke="#052e1f"
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* Copy */}
        <div className="relative z-[2] flex-1">
          <div className="celebration-head text-base font-semibold text-indigo-900 dark:text-indigo-100">
            Calendar connected — your matches just got smarter
          </div>
          <div className="celebration-sub mt-1 text-[13px] text-indigo-800 dark:text-indigo-200">
            <strong className="font-semibold text-emerald-700 dark:text-emerald-300">
              {matchPhrase}
            </strong>
            . Pick one below.
          </div>
        </div>
      </div>
    </div>
  );
}
