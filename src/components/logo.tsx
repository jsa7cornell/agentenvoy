"use client";

import { useId } from "react";

/**
 * LogoIcon — twin-bubble mark with dual-gradient "energy transfer" treatment.
 * Back bubble: indigo → cyan (cool, muted). Front bubble: indigo → purple (warm, bold).
 * viewBox is 96×80 (1.2:1). `size` sets the height in px.
 */
export function LogoIcon({ size = 32, className = "" }: { size?: number; className?: string }) {
  const uid = useId();
  const back = `${uid}-back`;
  const front = `${uid}-front`;
  const width = size * (96 / 80);
  return (
    <svg
      viewBox="0 0 96 80"
      width={width}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={back} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
        <linearGradient id={front} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      {/* Back bubble (cool gradient, muted) */}
      <path
        d="M40 18 H84 Q92 18 92 26 V54 Q92 62 84 62 H62 L54 70 L54 62 H40 Q32 62 32 54 V26 Q32 18 40 18 Z"
        fill={`url(#${back})`}
        opacity="0.5"
      />
      {/* Front bubble (warm gradient, bold) */}
      <path
        d="M12 6 H50 Q58 6 58 14 V36 Q58 44 50 44 H26 L18 52 L18 44 H12 Q4 44 4 36 V14 Q4 6 12 6 Z"
        fill={`url(#${front})`}
      />
    </svg>
  );
}

/**
 * LogoFull — icon + "AgentEnvoy.ai" wordmark, flex-aligned.
 * `height` is the icon height in px; text sizes proportionally.
 */
export function LogoFull({ height = 32, className = "" }: { height?: number; className?: string }) {
  const fontSize = height * 0.62;
  return (
    <span
      className={`inline-flex items-center gap-2 leading-none ${className}`}
      style={{ height }}
    >
      <LogoIcon size={height} />
      <span
        className="font-bold tracking-tight"
        style={{ fontSize, letterSpacing: "-0.015em" }}
      >
        AgentEnvoy
        <span className="font-light opacity-50">.ai</span>
      </span>
    </span>
  );
}
