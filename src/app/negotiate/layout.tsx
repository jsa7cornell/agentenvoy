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
        // Scoped CSS vars for negotiator UI — light mode
        "--neg-bg": "#f9fafb",
        "--neg-surface": "#ffffff",
        "--neg-surface-2": "#f3f4f6",
        "--neg-border": "#d1d5db",
        "--neg-text": "#111827",
        "--neg-text-muted": "#6b7280",
        "--neg-accent": "#ea580c",
        "--neg-green": "#16a34a",
        "--neg-yellow": "#ca8a04",
        "--neg-red": "#dc2626",
        "--neg-blue": "#2563eb",
        "--neg-purple": "#9333ea",
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
