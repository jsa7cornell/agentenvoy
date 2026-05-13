import { defineConfig, devices } from "@playwright/test";

// AgentEnvoy Playwright config — Layer 1 of the production-verification proposal
// (proposals/2026-05-13_claude-production-verification-infra_..._decided-2026-05-13.md).
//
// Conventions:
// - Script is `npm run test:e2e:browser` (NOT `test:e2e` — that's the existing vitest
//   HTTP suite from the 2026-04-19 integration-test-harness proposal). See B1 in the
//   review.
// - `reuseExistingServer: true` always — assume `npm run dev` is running. This avoids
//   30s+ Next.js cold-boot per test session and keeps Playwright out of pre-commit.
//   See P3 in the review.
// - Seeding is API-only. No direct Prisma writes from test code. See B3 / T1.
// - Verification driver = Playwright MCP. Claude-Preview is for visual review only;
//   Claude-in-Chrome is out of the verification harness. See N5.

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
