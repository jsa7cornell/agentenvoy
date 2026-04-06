import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AgentNegotiator — Multi-Agent Research & Synthesis",
  description:
    "Put AI agents in a room together. They research independently, then a neutral Administrator synthesizes their positions.",
};

export default function NegotiateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-screen"
      style={{
        // Scoped CSS vars for negotiator UI — avoids conflicts with main app
        "--neg-bg": "#0a0a0a",
        "--neg-surface": "#141414",
        "--neg-surface-2": "#1e1e1e",
        "--neg-border": "#2a2a2a",
        "--neg-text": "#e5e5e5",
        "--neg-text-muted": "#888",
        "--neg-accent": "#f97316",
        "--neg-green": "#22c55e",
        "--neg-yellow": "#eab308",
        "--neg-red": "#ef4444",
        "--neg-blue": "#3b82f6",
        "--neg-purple": "#a855f7",
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
