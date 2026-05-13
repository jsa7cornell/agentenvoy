import { expect, test } from "@playwright/test";

// Layer 1 spine-validation smoke test. Proves:
//   - @playwright/test is installed
//   - playwright.config.ts loads
//   - Chromium boots
//   - Dev server is reachable at baseURL (assumes `npm run dev` is running, per the
//     `reuseExistingServer: true` setting in playwright.config.ts)
//
// This spec exists to validate the *harness*, not the product. The product-level
// scenarios live alongside (see primary-link-guest-name.spec.ts).

test("dev server responds at the root", async ({ page }) => {
  const response = await page.goto("/");
  expect(response, "navigation to / returned no response").not.toBeNull();
  expect(response!.status(), "dev server should respond with 2xx or 3xx").toBeLessThan(400);
});
