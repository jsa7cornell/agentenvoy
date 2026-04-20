import { describe, it, expect } from "vitest";
import { rollupAttendeeStatus } from "@/lib/attendee-rollup";

const HOST = "host@example.com";

describe("rollupAttendeeStatus", () => {
  it("returns null when there are no attendees", () => {
    expect(rollupAttendeeStatus(undefined, HOST)).toBeNull();
    expect(rollupAttendeeStatus(null, HOST)).toBeNull();
    expect(rollupAttendeeStatus([], HOST)).toBeNull();
  });

  it("returns null when only the host is present (self flag)", () => {
    expect(
      rollupAttendeeStatus(
        [{ email: HOST, self: true, responseStatus: "accepted" }],
        HOST,
      ),
    ).toBeNull();
  });

  it("returns null when only the host is present (email match)", () => {
    expect(
      rollupAttendeeStatus(
        [{ email: HOST, responseStatus: "accepted" }],
        HOST,
      ),
    ).toBeNull();
  });

  it("returns accepted when any non-host accepted", () => {
    expect(
      rollupAttendeeStatus(
        [
          { email: HOST, self: true, responseStatus: "accepted" },
          { email: "a@x.com", responseStatus: "accepted" },
          { email: "b@x.com", responseStatus: "needsAction" },
        ],
        HOST,
      ),
    ).toBe("accepted");
  });

  it("returns declined when all non-host attendees declined", () => {
    expect(
      rollupAttendeeStatus(
        [
          { email: HOST, self: true, responseStatus: "accepted" },
          { email: "a@x.com", responseStatus: "declined" },
          { email: "b@x.com", responseStatus: "declined" },
        ],
        HOST,
      ),
    ).toBe("declined");
  });

  it("returns pending with needsAction/tentative mix (no acceptance, not all declined)", () => {
    expect(
      rollupAttendeeStatus(
        [
          { email: "a@x.com", responseStatus: "needsAction" },
          { email: "b@x.com", responseStatus: "tentative" },
          { email: "c@x.com", responseStatus: "declined" },
        ],
        HOST,
      ),
    ).toBe("pending");
  });

  it("accepted wins over declined majority", () => {
    expect(
      rollupAttendeeStatus(
        [
          { email: "a@x.com", responseStatus: "accepted" },
          { email: "b@x.com", responseStatus: "declined" },
          { email: "c@x.com", responseStatus: "declined" },
        ],
        HOST,
      ),
    ).toBe("accepted");
  });
});
