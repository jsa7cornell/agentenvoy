/**
 * Deterministic builder for the FIRST Envoy ChannelMessage in the recalibrate
 * first-time arc — a first-person presentation of the four Google-seed bullets
 * the host saw flash in `<PostureBubble>`. Persisted by
 * `/api/onboarding/calibrate-opener` so the bullets survive `hasRealChat`
 * flipping (which unmounts `<FirstRunWelcome>`) and survive a reload.
 *
 * Mirrors the four fields, format, copy, and emoji set rendered by the
 * `PostureBubble` React component in `src/components/feed.tsx` — John
 * explicitly loves those bullets; this is a move-not-redesign.
 *
 * Markdown bold (`**…**`) is supported by feed.tsx's `renderMarkdown` (verified
 * 2026-05-05 hotfix-2). The bullet lines are flat text with leading emoji so
 * they survive the simple split-on-newline rendering used by chat bubbles.
 */
import { shortTimezoneLabel } from "@/lib/timezone";

export interface CalibrateSeedInfoInputs {
  businessHoursStartMinutes: number;
  businessHoursEndMinutes: number;
  defaultDuration: number;
  videoProvider: string;
  timezone: string | null;
}

const VIDEO_PROVIDER_DISPLAY: Record<string, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  webex: "Webex",
  teams: "Microsoft Teams",
  phone: "phone",
  in_person: "in-person",
};

function formatBizMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 || h === 24 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0
    ? `${h12}${suffix}`
    : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
}

export function buildCalibrateSeedInfoText(
  inputs: CalibrateSeedInfoInputs,
): string {
  const bizRange = `${formatBizMinutes(inputs.businessHoursStartMinutes)}–${formatBizMinutes(inputs.businessHoursEndMinutes)}`;
  const tzLabel = inputs.timezone ? shortTimezoneLabel(inputs.timezone) : "";
  const provider =
    VIDEO_PROVIDER_DISPLAY[inputs.videoProvider] ?? inputs.videoProvider;

  const lines: string[] = [
    "I've pulled in your calendar — here's how I'm set up by default:",
    "",
    `⏰ **Business hours:** ${bizRange}`,
  ];
  if (tzLabel) {
    lines.push(`🌍 **Timezone:** ${tzLabel}`);
  }
  lines.push(
    `⏱️ **Default meetings:** ${inputs.defaultDuration}-minute ${provider}`,
    `📅 **Reading from:** your primary calendar`,
    "",
    "All customizable any time.",
  );
  return lines.join("\n");
}
