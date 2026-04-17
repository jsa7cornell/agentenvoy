import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",

        // Semantic surface tokens
        surface: {
          DEFAULT: "var(--surface)",
          secondary: "var(--surface-secondary)",
          tertiary: "var(--surface-tertiary)",
          inset: "var(--surface-inset)",
        },

        // Semantic text tokens
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        muted: "var(--text-muted)",
        inverted: "var(--text-inverted)",

        // Accent tokens
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          surface: "var(--accent-surface)",
        },
        accent2: "var(--accent-2)",
        accent3: "var(--accent-3)",
      },
      borderColor: {
        DEFAULT: "var(--border)",
        secondary: "var(--border-secondary)",
      },
      animation: {
        "pulse-ring": "pulse-ring 2s infinite",
        "flow-line": "flow-line 2s infinite linear",
        "fade-up": "fade-up 0.3s ease",
        "typing-bounce": "typing-bounce 1.2s infinite",
      },
      boxShadow: {
        "accent-glow": "0 4px 14px var(--accent-glow), 0 0 0 1px rgba(255,255,255,0.08) inset",
        "accent-glow-lg": "0 12px 36px var(--accent-glow), 0 0 0 1px rgba(255,255,255,0.12) inset",
      },
    },
  },
  plugins: [],
};
export default config;
