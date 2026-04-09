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
      },
      borderColor: {
        DEFAULT: "var(--border)",
        secondary: "var(--border-secondary)",
      },
    },
  },
  plugins: [],
};
export default config;
