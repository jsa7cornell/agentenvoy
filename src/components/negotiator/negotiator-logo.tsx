"use client";

// Animated negotiator logo — two chat bubbles from the AgentEnvoy logo.
// Modes:
//   "idle"        — static
//   "debating"    — bubbles alternate highlight, pulse toward each other (agents talking)
//   "synthesizing"— both bubbles orbit slowly around center (administrator thinking)
//   "complete"    — both bubbles glow steady green

type LogoMode = "idle" | "debating" | "synthesizing" | "complete";

interface NegotiatorLogoProps {
  mode: LogoMode;
  size?: number;
  className?: string;
}

export function NegotiatorLogo({ mode, size = 40, className = "" }: NegotiatorLogoProps) {
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {mode === "debating" && (
        <>
          {/* Bubble A pulses bright — agent speaking */}
          <rect x="2" y="8" width="46" height="34" rx="10" fill="var(--neg-accent)" opacity="0.95">
            <animate attributeName="opacity" values="0.95;0.35;0.95" dur="1.4s" repeatCount="indefinite" />
          </rect>
          <polygon points="14,42 10,54 24,42" fill="var(--neg-accent)" opacity="0.95">
            <animate attributeName="opacity" values="0.95;0.35;0.95" dur="1.4s" repeatCount="indefinite" />
          </polygon>
          {/* Bubble B pulses offset — other agent responding */}
          <rect x="32" y="26" width="46" height="34" rx="10" fill="var(--neg-accent)" opacity="0.35">
            <animate attributeName="opacity" values="0.35;0.95;0.35" dur="1.4s" repeatCount="indefinite" />
          </rect>
          <polygon points="64,60 68,72 54,60" fill="var(--neg-accent)" opacity="0.35">
            <animate attributeName="opacity" values="0.35;0.95;0.35" dur="1.4s" repeatCount="indefinite" />
          </polygon>
        </>
      )}

      {mode === "synthesizing" && (
        <>
          {/* Both bubbles rotate around center, like orbiting */}
          <g style={{ transformOrigin: "40px 40px" }}>
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 40 40"
              to="360 40 40"
              dur="2.4s"
              repeatCount="indefinite"
            />
            <rect x="2" y="8" width="46" height="34" rx="10" fill="var(--neg-purple)" opacity="0.8" />
            <polygon points="14,42 10,54 24,42" fill="var(--neg-purple)" opacity="0.8" />
            <rect x="32" y="26" width="46" height="34" rx="10" fill="var(--neg-purple)" opacity="0.4" />
            <polygon points="64,60 68,72 54,60" fill="var(--neg-purple)" opacity="0.4" />
          </g>
        </>
      )}

      {mode === "complete" && (
        <>
          {/* Both bubbles steady, glow accent */}
          <rect x="2" y="8" width="46" height="34" rx="10" fill="var(--neg-green)" opacity="0.9" />
          <polygon points="14,42 10,54 24,42" fill="var(--neg-green)" opacity="0.9" />
          <rect x="32" y="26" width="46" height="34" rx="10" fill="var(--neg-green)" opacity="0.5" />
          <polygon points="64,60 68,72 54,60" fill="var(--neg-green)" opacity="0.5" />
        </>
      )}

      {mode === "idle" && (
        <>
          <rect x="2" y="8" width="46" height="34" rx="10" fill="currentColor" opacity="0.9" />
          <polygon points="14,42 10,54 24,42" fill="currentColor" opacity="0.9" />
          <rect x="32" y="26" width="46" height="34" rx="10" fill="currentColor" opacity="0.4" />
          <polygon points="64,60 68,72 54,60" fill="currentColor" opacity="0.4" />
        </>
      )}
    </svg>
  );
}
