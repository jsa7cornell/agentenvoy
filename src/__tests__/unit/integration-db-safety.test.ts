import { describe, it, expect } from "vitest";
import {
  assertSafeIntegrationDbUrl,
  UnsafeIntegrationDbError,
} from "@/__tests__/integration/helpers/safety";

/**
 * Regression test for the 2026-05-04 prod-wipe incident. The earlier guard
 * was a substring regex on the connection string, which would have allowed
 * a prod URL containing the literal "agentenvoy_test" anywhere — including
 * a hostname or query-string artifact. This test pins the URL parser
 * behavior so a future refactor can't silently weaken the gate.
 *
 * Tests assertSafeIntegrationDbUrl in isolation (the URL parse-check half
 * of the safety gate). The env-var sentinel half is exercised in
 * integration-test runtime, not here.
 */
describe("assertSafeIntegrationDbUrl", () => {
  describe("safe URLs (must NOT throw)", () => {
    const cases = [
      "postgresql://postgres:postgres@localhost:5432/agentenvoy_test",
      "postgresql://postgres:postgres@127.0.0.1:5432/agentenvoy_test",
      "postgresql://postgres:postgres@localhost:5432/agentenvoy_ci",
      // Localhost overrides DB-name allow-list
      "postgresql://u:p@localhost:5432/anything_goes",
      // Docker-compose service hostnames
      "postgresql://postgres:postgres@postgres:5432/agentenvoy_test",
      "postgresql://postgres:postgres@db:5432/agentenvoy_test",
      // Hosted DB with allow-listed test database name
      "postgresql://u:p@hosted-test-db.example.com:5432/agentenvoy_ci",
    ];
    for (const url of cases) {
      it(`accepts ${url}`, () => {
        expect(() => assertSafeIntegrationDbUrl(url)).not.toThrow();
      });
    }
  });

  describe("unsafe URLs (must throw)", () => {
    const cases: Array<[string, string]> = [
      ["", "empty URL"],
      ["not-a-url", "non-URL string"],
      [
        "postgresql://postgres:pwd@aws-1-us-east-2.pooler.supabase.com:5432/postgres",
        "real Supabase pooler hostname (today's incident shape)",
      ],
      [
        "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/agentenvoy_test_oops",
        // Substring regex would have matched 'agentenvoy_test' here; parsed
        // DB name is 'agentenvoy_test_oops' which is NOT in the allow-list.
        "DB name with allow-listed substring but not equal",
      ],
      [
        "postgresql://localhost-fake.example.com:5432/agentenvoy_test_x",
        // Substring 'localhost' inside hostname — must not pass on host alone.
        "hostname containing 'localhost' substring",
      ],
      [
        "postgresql://u:p@prod.example.com:5432/postgres",
        "arbitrary prod-shaped URL",
      ],
    ];
    for (const [url, label] of cases) {
      it(`rejects: ${label}`, () => {
        expect(() => assertSafeIntegrationDbUrl(url)).toThrow(
          UnsafeIntegrationDbError,
        );
      });
    }
  });

  it("redacts the password in error messages", () => {
    try {
      assertSafeIntegrationDbUrl(
        "postgresql://user:supersecret@prod.example.com:5432/postgres",
      );
      throw new Error("expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("supersecret");
      expect(msg).toContain(":***@");
    }
  });
});
