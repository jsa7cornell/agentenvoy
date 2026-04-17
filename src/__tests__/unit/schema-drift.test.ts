/**
 * Unit tests for the schema drift detector.
 *
 * Mocks Prisma's DMMF + $queryRaw so we can exercise the diff logic
 * without a real DB. The DMMF shape we mock is a minimal subset of what
 * Prisma generates — enough to exercise scalar/enum filtering, @map
 * handling, and the missing/extra/tableMissing branches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type MockField = {
  name: string;
  kind: "scalar" | "enum" | "object" | "relation" | "unsupported";
  dbName?: string | null;
};
type MockModel = { name: string; dbName?: string | null; fields: MockField[] };

const dmmfModelsMock: { current: MockModel[] } = { current: [] };
const queryRawMock = vi.fn();

vi.mock("@prisma/client", () => ({
  Prisma: {
    get dmmf() {
      return {
        datamodel: {
          get models() {
            return dmmfModelsMock.current;
          },
        },
      };
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  },
}));

import { checkSchemaDrift, formatDriftSummary } from "@/lib/schema-drift";

beforeEach(() => {
  queryRawMock.mockReset();
  dmmfModelsMock.current = [];
});

describe("checkSchemaDrift", () => {
  it("returns ok=true when all expected columns exist", async () => {
    dmmfModelsMock.current = [
      {
        name: "User",
        fields: [
          { name: "id", kind: "scalar" },
          { name: "email", kind: "scalar" },
          { name: "createdAt", kind: "scalar" },
        ],
      },
    ];
    queryRawMock.mockResolvedValue([
      { column_name: "id" },
      { column_name: "email" },
      { column_name: "createdAt" },
    ]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(true);
    expect(report.affected).toEqual([]);
    expect(report.models[0].missing).toEqual([]);
  });

  it("flags missing columns", async () => {
    dmmfModelsMock.current = [
      {
        name: "User",
        fields: [
          { name: "id", kind: "scalar" },
          { name: "email", kind: "scalar" },
          { name: "welcomeEmailSentAt", kind: "scalar" },
        ],
      },
    ];
    queryRawMock.mockResolvedValue([
      { column_name: "id" },
      { column_name: "email" },
    ]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(false);
    expect(report.affected).toHaveLength(1);
    expect(report.models[0].missing).toEqual(["welcomeEmailSentAt"]);
    expect(report.models[0].tableMissing).toBe(false);
  });

  it("flags a missing table with tableMissing=true", async () => {
    dmmfModelsMock.current = [
      {
        name: "RecentlyAddedModel",
        fields: [
          { name: "id", kind: "scalar" },
          { name: "name", kind: "scalar" },
        ],
      },
    ];
    queryRawMock.mockResolvedValue([]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(false);
    expect(report.models[0].tableMissing).toBe(true);
    expect(report.models[0].missing).toEqual(["id", "name"]);
  });

  it("ignores relation fields (they're not columns)", async () => {
    dmmfModelsMock.current = [
      {
        name: "User",
        fields: [
          { name: "id", kind: "scalar" },
          { name: "sessions", kind: "object" },
          { name: "hostedSessions", kind: "object" },
        ],
      },
    ];
    queryRawMock.mockResolvedValue([{ column_name: "id" }]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(true);
  });

  it("honors @map via field.dbName", async () => {
    dmmfModelsMock.current = [
      {
        name: "User",
        fields: [
          { name: "id", kind: "scalar" },
          // Field is named `upcomingSchedulePreferences` in Prisma but
          // `situationalKnowledge` in the DB via @map.
          { name: "upcomingSchedulePreferences", kind: "scalar", dbName: "situationalKnowledge" },
        ],
      },
    ];
    queryRawMock.mockResolvedValue([
      { column_name: "id" },
      { column_name: "situationalKnowledge" },
    ]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(true);
  });

  it("honors @@map via model.dbName", async () => {
    dmmfModelsMock.current = [
      {
        name: "RenamedModel",
        dbName: "actual_table_name",
        fields: [{ name: "id", kind: "scalar" }],
      },
    ];
    queryRawMock.mockResolvedValue([{ column_name: "id" }]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(true);
    expect(report.models[0].table).toBe("actual_table_name");
  });

  it("reports extra columns without failing", async () => {
    dmmfModelsMock.current = [
      {
        name: "User",
        fields: [{ name: "id", kind: "scalar" }],
      },
    ];
    queryRawMock.mockResolvedValue([
      { column_name: "id" },
      { column_name: "legacy_column" },
    ]);

    const report = await checkSchemaDrift();
    expect(report.ok).toBe(true);
    expect(report.models[0].extra).toEqual(["legacy_column"]);
    expect(report.models[0].missing).toEqual([]);
  });
});

describe("formatDriftSummary", () => {
  it("returns the OK message when there's no drift", () => {
    const summary = formatDriftSummary({
      ok: true,
      checkedAt: "2026-04-17T00:00:00.000Z",
      models: [],
      affected: [],
    });
    expect(summary).toMatch(/OK/i);
  });

  it("lists affected tables with missing columns", () => {
    const summary = formatDriftSummary({
      ok: false,
      checkedAt: "2026-04-17T00:00:00.000Z",
      models: [],
      affected: [
        {
          model: "User",
          table: "User",
          tableMissing: false,
          missing: ["welcomeEmailSentAt", "guestTimezone"],
          extra: [],
        },
      ],
    });
    expect(summary).toContain("User:");
    expect(summary).toContain("welcomeEmailSentAt");
    expect(summary).toContain("guestTimezone");
  });

  it("calls out missing tables", () => {
    const summary = formatDriftSummary({
      ok: false,
      checkedAt: "2026-04-17T00:00:00.000Z",
      models: [],
      affected: [
        {
          model: "NewModel",
          table: "NewModel",
          tableMissing: true,
          missing: ["id", "name"],
          extra: [],
        },
      ],
    });
    expect(summary).toContain("ENTIRE TABLE MISSING");
    expect(summary).toContain("NewModel");
  });
});
