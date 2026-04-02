export function LogoIcon({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Bubble A */}
      <rect x="2" y="8" width="46" height="34" rx="10" fill="currentColor" opacity="0.9" />
      <polygon points="14,42 10,54 24,42" fill="currentColor" opacity="0.9" />
      {/* Bubble B */}
      <rect x="32" y="26" width="46" height="34" rx="10" fill="currentColor" opacity="0.4" />
      <polygon points="64,60 68,72 54,60" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

export function LogoFull({ height = 32, className = "" }: { height?: number; className?: string }) {
  const width = (height / 72) * 420;
  return (
    <svg
      viewBox="0 0 420 72"
      width={width}
      height={height}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Bubble A */}
      <rect x="2" y="8" width="42" height="32" rx="9" fill="currentColor" opacity="0.9" />
      <polygon points="12,40 8,50 22,40" fill="currentColor" opacity="0.9" />
      {/* Bubble B */}
      <rect x="28" y="22" width="42" height="32" rx="9" fill="currentColor" opacity="0.4" />
      <polygon points="58,54 62,64 48,54" fill="currentColor" opacity="0.4" />
      {/* Text */}
      <text
        x="84"
        y="49"
        fill="currentColor"
        fontFamily="var(--font-geist-sans), -apple-system, system-ui, sans-serif"
        fontSize="36"
        fontWeight="600"
        letterSpacing="-0.5"
      >
        AgentEnvoy
        <tspan fill="currentColor" opacity="0.4" fontWeight="300">
          .ai
        </tspan>
      </text>
    </svg>
  );
}
