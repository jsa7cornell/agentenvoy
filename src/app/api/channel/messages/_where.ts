// Always include onboarding rows regardless of the session window — once a
// post-calibration ChannelSession opens, its startedAt is more recent than the
// onboarding turns, which would otherwise drop them from the feed and leave
// the user staring at an empty channel after calibration completes.
//
// Lives in a sibling module (not route.ts) because Next.js App Router only
// permits HTTP-verb exports from route files.
export function buildChannelMessagesWhere(channelId: string, sessionStart: Date) {
  return {
    channelId,
    OR: [
      { createdAt: { gte: sessionStart } },
      { metadata: { path: ["kind"], equals: "onboarding" } },
    ],
  };
}
