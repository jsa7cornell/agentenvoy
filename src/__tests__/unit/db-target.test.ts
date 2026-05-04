import { describe, it, expect } from "vitest";
import { classifyDbUrl } from "../../../scripts/lib/db-target";

/**
 * Pins the script-side DB target classifier (used by prisma/seed.ts and
 * scripts/backfill-link-posture.ts to gate destructive writes against
 * remote URLs). Mirrors the shape of the integration-test guard's tests
 * — same incident-shape URLs, same substring-collision cases.
 *
 * The helper itself doesn't need a regression test for the prompt /
 * sentinel logic (those are exercised at runtime); pure classification
 * is the testable core.
 */
describe("classifyDbUrl", () => {
  describe("local targets", () => {
    const cases = [
      "postgresql://postgres:postgres@localhost:5432/agentenvoy_dev",
      "postgresql://postgres:postgres@127.0.0.1:5433/agentenvoy_dev",
      "postgresql://u:p@localhost:5432/anything",
      "postgresql://u:p@postgres:5432/agentenvoy_test",
      "postgresql://u:p@db:5432/agentenvoy_ci",
    ];
    for (const url of cases) {
      it(`classifies as local: ${url}`, () => {
        expect(classifyDbUrl(url).target).toBe("local");
      });
    }
  });

  describe("remote targets", () => {
    const cases = [
      // Today's incident shape
      "postgresql://postgres:pwd@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
      // Substring-collision cases — would have passed a regex-based guard
      "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/agentenvoy_test",
      "postgresql://localhost-fake.example.com:5432/agentenvoy_dev",
      "postgresql://u:p@prod.example.com:5432/postgres",
    ];
    for (const url of cases) {
      it(`classifies as remote: ${url}`, () => {
        expect(classifyDbUrl(url).target).toBe("remote");
      });
    }
  });

  describe("unparseable", () => {
    it("classifies empty string", () => {
      expect(classifyDbUrl("").target).toBe("unparseable");
    });
    it("classifies undefined", () => {
      expect(classifyDbUrl(undefined).target).toBe("unparseable");
    });
    it("classifies non-URL garbage", () => {
      expect(classifyDbUrl("not-a-url").target).toBe("unparseable");
    });
  });

  it("redacts password in the redacted field", () => {
    const result = classifyDbUrl(
      "postgresql://user:supersecret@prod.example.com:5432/postgres",
    );
    expect(result.redacted).not.toContain("supersecret");
    expect(result.redacted).toContain(":***@");
  });

  it("extracts hostname and database name", () => {
    const result = classifyDbUrl(
      "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require",
    );
    expect(result.hostname).toBe("aws-1-us-east-2.pooler.supabase.com");
    expect(result.database).toBe("postgres");
  });
});
