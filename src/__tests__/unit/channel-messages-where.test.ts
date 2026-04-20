import { describe, it, expect } from "vitest";
import { buildChannelMessagesWhere } from "@/app/api/channel/messages/_where";

describe("buildChannelMessagesWhere", () => {
  it("includes recent rows in the session window", () => {
    const start = new Date("2026-04-19T00:00:00Z");
    const where = buildChannelMessagesWhere("ch_1", start);
    expect(where.channelId).toBe("ch_1");
    expect(where.OR).toContainEqual({ createdAt: { gte: start } });
  });

  it("always pulls in onboarding rows regardless of the window", () => {
    const where = buildChannelMessagesWhere("ch_1", new Date());
    expect(where.OR).toContainEqual({
      metadata: { path: ["kind"], equals: "onboarding" },
    });
  });
});
