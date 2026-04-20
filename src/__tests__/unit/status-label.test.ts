import { describe, it, expect } from "vitest";
import { displayStatusLabel } from "@/lib/status-label";

describe("displayStatusLabel", () => {
  it("returns null when session is pre-engagement (no guest email/name, status active)", () => {
    expect(
      displayStatusLabel({
        status: "active",
        statusLabel: "Waiting for Bob",
        guestEmail: null,
        guestName: null,
      })
    ).toBeNull();
  });

  it("returns the label once a guestEmail is captured", () => {
    expect(
      displayStatusLabel({
        status: "active",
        statusLabel: "Waiting for Bob",
        guestEmail: "bob@example.com",
        guestName: null,
      })
    ).toBe("Waiting for Bob");
  });

  it("returns the label once a guestName is captured", () => {
    expect(
      displayStatusLabel({
        status: "active",
        statusLabel: "Waiting for Bob",
        guestEmail: null,
        guestName: "Bob",
      })
    ).toBe("Waiting for Bob");
  });

  it("always returns the label on agreed sessions regardless of guest fields", () => {
    expect(
      displayStatusLabel({
        status: "agreed",
        statusLabel: "Confirmed",
        guestEmail: null,
        guestName: null,
      })
    ).toBe("Confirmed");
  });

  it("passes through null labels unchanged", () => {
    expect(
      displayStatusLabel({
        status: "active",
        statusLabel: null,
        guestEmail: "bob@example.com",
        guestName: null,
      })
    ).toBeNull();
  });
});
