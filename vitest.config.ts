import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // E2E tests hit a running dev server — generous timeouts for AI responses
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // Run sequentially — tests share the same database
    sequence: { concurrent: false },
    include: ["src/__tests__/e2e/**/*.test.ts"],
  },
});
