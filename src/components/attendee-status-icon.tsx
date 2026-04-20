import type { AttendeeRollup } from "@/lib/attendee-rollup";

/**
 * Small person-shaped indicator rendered on calendar tiles to show the
 * rolled-up RSVP state of non-host attendees.
 *
 *   accepted  — filled body, emerald tint (≥1 other confirmed human)
 *   declined  — outline body with a strike-through slash, red tint
 *   pending   — outline body only, muted color (nobody accepted or declined yet)
 *
 * Pass `rollup={null}` (or omit) for solo events — the component returns
 * null so the caller can render unconditionally.
 */
export function AttendeeStatusIcon({
  rollup,
  size = 10,
  className = "",
}: {
  rollup: AttendeeRollup | null | undefined;
  size?: number;
  className?: string;
}) {
  if (!rollup) return null;

  const label =
    rollup === "accepted"
      ? "Guest accepted"
      : rollup === "declined"
        ? "Guest declined"
        : "Awaiting guest RSVP";

  const color =
    rollup === "accepted"
      ? "text-emerald-500"
      : rollup === "declined"
        ? "text-red-500"
        : "text-muted";

  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`${color} ${className}`}
      role="img"
      aria-label={label}
    >
      {/* head */}
      <circle
        cx="8"
        cy="5.5"
        r="2.5"
        fill={rollup === "accepted" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* torso / shoulders arc */}
      <path
        d="M3 14 a5 5 0 0 1 10 0"
        fill={rollup === "accepted" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* strike-through for declined */}
      {rollup === "declined" && (
        <line
          x1="2"
          y1="14"
          x2="14"
          y2="2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
