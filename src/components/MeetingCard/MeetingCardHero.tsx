"use client";

/**
 * MeetingCardHero — the visual header of the MeetingCard.
 *
 * R5 changes:
 *  - Hero shows just "✓ Confirmed" — no "you're all set" headline, no personal name.
 *  - TZ abbreviation in parens, not chip: "Tue, May 13 · 9:30 AM (PDT)"
 *  - Cross-TZ secondary line: "[avatar] 12:30 PM (EDT) for Sarah" — collapses when same TZ.
 *  - ⋯ button floats top-right (positioned by parent card container).
 *  - `headline` prop still accepted for special cases (e.g. "Moved to Thursday").
 *
 * Confirmed/skipped: full gradient hero with icon + eyebrow + when-block.
 * Proposal/matched/confirming: slim accent stripe (3px) at the top of the card.
 *
 * Visual spec: previews/event-card-FINAL-portfolio.html (confirmed states)
 */

import type { MeetingCardProps, MeetingCardState } from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format date as "Tue, May 13 · 9:30 AM" — no TZ (appended separately in parens).
 */
function formatTimeParts(date: Date, tz: string): { datePart: string; timePart: string } {
  // 2026-05-10 hotfix: try/catch for invalid TZ — Intl.DateTimeFormat throws
  // RangeError on empty string or unrecognized IANA zone. Better to render
  // browser-local than crash the whole card.
  const opts = (timeZone: string | undefined): Intl.DateTimeFormatOptions => ({
    timeZone: timeZone || undefined,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const tOpts = (timeZone: string | undefined): Intl.DateTimeFormatOptions => ({
    timeZone: timeZone || undefined,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  try {
    return {
      datePart: date.toLocaleString("en-US", opts(tz)),
      timePart: date.toLocaleString("en-US", tOpts(tz)),
    };
  } catch {
    return {
      datePart: date.toLocaleString("en-US", opts(undefined)),
      timePart: date.toLocaleString("en-US", tOpts(undefined)),
    };
  }
}

function tzAbbr(tz: string): string {
  // 2026-05-10 hotfix: try/catch for invalid TZ — Intl.DateTimeFormat throws
  // RangeError on empty string. Return the raw input as last-resort label.
  if (!tz) return "";
  try {
    const date = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

// ── Accent stripe (proposal / matched / confirming) ───────────────────────────

function AccentStripe({ state }: { state: MeetingCardState }) {
  if (state === "proposal") {
    return (
      <div
        className="h-[3px] w-full"
        style={{ background: "linear-gradient(90deg, #4f46e5, #6366f1)" }}
      />
    );
  }
  if (state === "matched") {
    return (
      <div
        className="h-[3px] w-full"
        style={{ background: "linear-gradient(90deg, #0ea5e9, #6366f1)" }}
      />
    );
  }
  if (state === "confirming") {
    return (
      <div
        className="h-[3px] w-full overflow-hidden"
        style={{
          background: "linear-gradient(90deg, #6366f1, #a855f7, #6366f1)",
          backgroundSize: "200% 100%",
          animation: "confirming-sweep 1.2s linear infinite",
        }}
      >
        <style>{`@keyframes confirming-sweep{0%{background-position:100% 0}100%{background-position:-100% 0}}`}</style>
      </div>
    );
  }
  return null;
}

// ── Confirming eyebrow ────────────────────────────────────────────────────────

export function ConfirmingEyebrow() {
  return (
    <div className="px-[22px] pt-3 pb-1 text-[10.5px] font-bold tracking-[0.12em] uppercase text-indigo-600">
      Confirming…
    </div>
  );
}

// ── Full hero (confirmed / skipped) ──────────────────────────────────────────

function FullHero(props: MeetingCardProps) {
  const { state, viewerRole, host, guest, when, headline, series } = props;
  const isSkipped = state === "skipped";

  const gradientStyle = isSkipped
    ? "linear-gradient(140deg, #b45309 0%, #92400e 60%, #78350f 100%)"
    : "linear-gradient(140deg, #10b981 0%, #059669 60%, #047857 100%)";

  // `headline` prop for special cases (e.g. "Moved to Thursday") — no default headline per R5.
  const headlineText = headline ?? null;

  // TZ in parens (R5 Rule 3)
  const { datePart, timePart } = formatTimeParts(when.time, when.tz);
  const primaryTzAbbr = tzAbbr(when.tz);

  const showOtherTz = !!when.otherTz && when.otherTz !== when.tz;
  const otherTimeParts = showOtherTz ? formatTimeParts(when.time, when.otherTz!) : null;
  const otherTzAbbrStr = showOtherTz ? tzAbbr(when.otherTz!) : null;

  // The "other party" from the viewer's perspective
  const otherParty = viewerRole === "guest" ? host : guest;
  // 2026-05-10 hotfix: defensive against empty firstName.
  const otherInitial = (otherParty.firstName?.[0] ?? "?").toUpperCase();

  // 2026-05-13 cmp451sli fix: the prior label "Confirmed by {otherParty}" was
  // role-symmetric but semantically wrong from the guest's perspective. In our
  // flow the GUEST always presses the confirm button via the picker — the host
  // is never the confirming party. From the host's perspective, "Confirmed by
  // Suzie" is correct. From the guest's, "Confirmed by John" reads as "John
  // confirmed this" — which isn't what happened. The guest filed cmp451sli
  // expecting to see her own name. The cleaner role-aware framing:
  //   - host viewer  → "Confirmed by {guest}" (who actually pressed confirm)
  //   - guest viewer → "Confirmed with {host}" (different prep — describes the
  //     meeting relation, not the action attribution)
  // When firstName is missing, fall back to bare "Confirmed".
  const confirmedLabel = (() => {
    if (!otherParty.firstName) return "Confirmed";
    return viewerRole === "guest"
      ? `Confirmed with ${otherParty.firstName}`
      : `Confirmed by ${otherParty.firstName}`;
  })();

  // R5: eyebrow only — no "you're all set" / no name.
  const eyebrow = series
    ? `${isSkipped ? "Skipped" : confirmedLabel} · session ${series.position} of ${series.total}`
    : isSkipped
    ? "Skipped"
    : confirmedLabel;

  return (
    <div
      className="text-white px-[22px] pt-[14px] pb-3 relative overflow-hidden"
      style={{ background: gradientStyle }}
    >
      {/* Radial highlight overlay */}
      <div
        className="pointer-events-none absolute"
        style={{
          top: "-40%",
          right: "-20%",
          width: 240,
          height: 240,
          background:
            "radial-gradient(circle, rgba(255,255,255,.18) 0%, transparent 60%)",
        }}
      />

      {/* Check / Skip glyph + eyebrow (+ optional headline) */}
      <div className="flex items-center gap-[14px] relative z-10">
        {/* Icon circle */}
        <div
          className="w-[42px] h-[42px] rounded-full bg-white flex items-center justify-center text-[21px] font-bold flex-shrink-0"
          style={{
            color: isSkipped ? "#b45309" : "#059669",
            boxShadow:
              "0 6px 16px rgba(0,0,0,.18), 0 0 0 4px rgba(255,255,255,.18)",
            animation: "pulse-check 2.4s ease-in-out infinite",
          }}
        >
          {isSkipped ? "⤫" : "✓"}
          <style>{`@keyframes pulse-check{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}`}</style>
        </div>

        <div>
          {/* Eyebrow — "Confirmed" or "Confirmed · session N of M" */}
          <div
            className="text-[10.5px] font-bold tracking-[0.12em] uppercase mb-[2px]"
            style={{ color: "rgba(255,255,255,.85)" }}
          >
            {eyebrow}
          </div>
          {/* Optional override headline only — R5 drops the default "You're all set" */}
          {headlineText && (
            <div className="text-[20px] font-bold tracking-[-0.012em] leading-[1.15]">
              {headlineText}
            </div>
          )}
        </div>
      </div>

      {/* When block — TZ in parens per R5 Rule 3 */}
      <div
        className="mt-[10px] pt-[10px] relative z-10"
        style={{ borderTop: "1px solid rgba(255,255,255,.18)" }}
      >
        {/* Primary line: "Tue, May 13 · 9:30 AM (PDT)" */}
        <div className="flex items-baseline gap-[6px] flex-wrap">
          <span className="text-[18px] font-semibold text-white">
            {datePart} · {timePart} ({primaryTzAbbr})
          </span>
          <span
            className="text-[13px] font-medium"
            style={{ color: "rgba(255,255,255,.85)" }}
          >
            {when.durationMin} min
          </span>
        </div>

        {/* Secondary TZ line — "9:30 AM (EDT) for Sarah [avatar]" */}
        {showOtherTz && otherTimeParts && (
          <div
            className="mt-[6px] text-[12px] font-medium flex items-center gap-[6px]"
            style={{ color: "rgba(255,255,255,.78)" }}
          >
            {/* Other party mini avatar */}
            <div
              className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9.5px] font-bold flex-shrink-0"
              style={{
                background: "rgba(255,255,255,.22)",
                color: "#fff",
                border: "1.5px solid rgba(255,255,255,.4)",
              }}
            >
              {otherInitial}
            </div>
            <span>
              {otherTimeParts.timePart} ({otherTzAbbrStr}) for{" "}
              <b className="text-white font-semibold">{otherParty.firstName}</b>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MeetingCardHero(props: MeetingCardProps) {
  const { state } = props;

  if (state === "confirmed" || state === "skipped") {
    return <FullHero {...props} />;
  }

  // proposal / matched / confirming: accent stripe only
  return (
    <>
      <AccentStripe state={state} />
      {state === "confirming" && <ConfirmingEyebrow />}
    </>
  );
}
