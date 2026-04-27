import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    include: ["src/__tests__/unit/**/*.test.ts"],
  },
  // tsconfig has `jsx: "preserve"` for Next.js — Vite's Oxc transformer
  // refuses to parse `.tsx` files in that mode unless we override the JSX
  // handling at the bundler level. Picker-registry tests import component
  // identity references from `availability-calendar.tsx` for byte-equivalence
  // assertions; this override lets vitest transform JSX so those imports
  // resolve. Test-only — production build still goes through the Next.js
  // SWC pipeline with `jsx: preserve`.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
