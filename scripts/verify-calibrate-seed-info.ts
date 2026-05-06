/**
 * Ad-hoc verification for hotfix-2 (2026-05-05).
 *
 * Renders the seed-info text against the canonical fixture preferences (the
 * seed-defaults John saw in production: 9–5 PDT, 30-min Google Meet) and
 * prints both messages to stdout so a human reviewer can eyeball the
 * formatting that will land as the FIRST Envoy ChannelMessage.
 *
 * Run: `npx tsx scripts/verify-calibrate-seed-info.ts`
 *
 * No DB writes, no network, no secrets.
 */
import { buildCalibrateSeedInfoText } from "../src/lib/onboarding/calibrate-seed-info-text";
import { CALIBRATE_FIRST_TIME_OPENER_TEXT } from "../src/lib/onboarding/calibrate-opener-text";

const FIXTURES = [
  {
    label: "Canonical seed-defaults (9–5 PDT, 30-min Google Meet)",
    inputs: {
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1020,
      defaultDuration: 30,
      videoProvider: "google_meet",
      timezone: "America/Los_Angeles",
    },
  },
  {
    label: "Eastern, Zoom, 25-min, half-hour bounds",
    inputs: {
      businessHoursStartMinutes: 510, // 8:30am
      businessHoursEndMinutes: 1050, // 5:30pm
      defaultDuration: 25,
      videoProvider: "zoom",
      timezone: "America/New_York",
    },
  },
  {
    label: "Missing timezone (graceful degrade — no 🌍 bullet)",
    inputs: {
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1020,
      defaultDuration: 30,
      videoProvider: "google_meet",
      timezone: null,
    },
  },
];

for (const f of FIXTURES) {
  console.log("=".repeat(72));
  console.log(`# ${f.label}`);
  console.log("=".repeat(72));
  console.log("\n--- Message 1: subkind=calibrate-seed-info ---\n");
  console.log(buildCalibrateSeedInfoText(f.inputs));
  console.log("\n--- Message 2: subkind=calibrate-opener ---\n");
  console.log(CALIBRATE_FIRST_TIME_OPENER_TEXT);
  console.log("\n");
}
