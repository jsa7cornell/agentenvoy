/**
 * Unit tests for `src/lib/primer-state.ts` — Stage 3 V2 of proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity`.
 *
 * Contract:
 *   - `hasSeenPrimer` / `markPrimerSeen` round-trip via localStorage.
 *   - `cleanupPrimersForSession` removes only keys scoped to one session,
 *     leaving other sessions' primer state and unrelated localStorage
 *     entries intact.
 *   - All three functions are SSR-safe (no-op when `window` is undefined;
 *     `hasSeenPrimer` treats SSR as "seen" to skip a server-rendered
 *     flash).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hasSeenPrimer,
  markPrimerSeen,
  cleanupPrimersForSession,
} from "@/lib/primer-state";

// A minimal in-memory localStorage polyfill for the happy path.
function installMockLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  // @ts-expect-error — jsdom env already has window, but we replace its
  // localStorage for determinism.
  globalThis.window = { localStorage: storage };
  return storage;
}

describe("primer-state — Stage 3 V2 persistence", () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  afterEach(() => {
    // @ts-expect-error — clean up between tests.
    delete globalThis.window;
  });

  describe("round-trip", () => {
    it("hasSeenPrimer returns false before markPrimerSeen", () => {
      expect(hasSeenPrimer("session-1", "dannys-agent")).toBe(false);
    });

    it("hasSeenPrimer returns true after markPrimerSeen for the same pair", () => {
      markPrimerSeen("session-1", "dannys-agent");
      expect(hasSeenPrimer("session-1", "dannys-agent")).toBe(true);
    });

    it("markPrimerSeen does NOT leak across agent identities", () => {
      markPrimerSeen("session-1", "dannys-agent");
      expect(hasSeenPrimer("session-1", "other-agent")).toBe(false);
    });

    it("markPrimerSeen does NOT leak across sessions", () => {
      markPrimerSeen("session-1", "dannys-agent");
      expect(hasSeenPrimer("session-2", "dannys-agent")).toBe(false);
    });
  });

  describe("cleanupPrimersForSession", () => {
    it("removes keys scoped to the given session only", () => {
      markPrimerSeen("session-1", "agent-a");
      markPrimerSeen("session-1", "agent-b");
      markPrimerSeen("session-2", "agent-a");

      cleanupPrimersForSession("session-1");

      expect(hasSeenPrimer("session-1", "agent-a")).toBe(false);
      expect(hasSeenPrimer("session-1", "agent-b")).toBe(false);
      // Session-2's key must survive.
      expect(hasSeenPrimer("session-2", "agent-a")).toBe(true);
    });

    it("does not touch unrelated localStorage keys", () => {
      // Write a non-primer key directly; cleanup must leave it alone.
      window.localStorage.setItem("user-prefs:theme", "dark");
      markPrimerSeen("session-1", "agent-a");

      cleanupPrimersForSession("session-1");

      expect(window.localStorage.getItem("user-prefs:theme")).toBe("dark");
    });

    it("is a no-op when no matching keys exist", () => {
      expect(() => cleanupPrimersForSession("session-never-used")).not.toThrow();
    });

    it("does not remove session-N keys when cleaning up session-NN (prefix boundary)", () => {
      // If cleanup were a loose substring match, "session-1" would sweep
      // "session-10". Guard that boundary explicitly.
      markPrimerSeen("session-1", "agent-a");
      markPrimerSeen("session-10", "agent-a");

      cleanupPrimersForSession("session-1");

      expect(hasSeenPrimer("session-1", "agent-a")).toBe(false);
      expect(hasSeenPrimer("session-10", "agent-a")).toBe(true);
    });
  });

  describe("SSR safety (window === undefined)", () => {
    beforeEach(() => {
      // @ts-expect-error — simulate server-side render
      delete globalThis.window;
    });

    it("hasSeenPrimer returns true on the server (skip flashing the primer)", () => {
      expect(hasSeenPrimer("session-1", "agent-a")).toBe(true);
    });

    it("markPrimerSeen is a no-op on the server", () => {
      expect(() => markPrimerSeen("session-1", "agent-a")).not.toThrow();
    });

    it("cleanupPrimersForSession is a no-op on the server", () => {
      expect(() => cleanupPrimersForSession("session-1")).not.toThrow();
    });
  });

  describe("resilience to localStorage errors", () => {
    it("hasSeenPrimer treats getItem throw as 'seen' (safe fallback)", () => {
      const throwing: Storage = {
        length: 0,
        clear: () => {},
        getItem: () => {
          throw new Error("storage disabled");
        },
        key: () => null,
        removeItem: () => {},
        setItem: () => {
          throw new Error("storage disabled");
        },
      };
      // @ts-expect-error — replace storage with throwing stub
      globalThis.window = { localStorage: throwing };

      expect(hasSeenPrimer("session-1", "agent-a")).toBe(true);
    });

    it("markPrimerSeen swallows setItem exceptions", () => {
      const throwing: Storage = {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {
          throw new Error("quota");
        },
      };
      // @ts-expect-error — replace storage with throwing stub
      globalThis.window = { localStorage: throwing };

      expect(() => markPrimerSeen("session-1", "agent-a")).not.toThrow();
    });
  });

  // Sanity check — vi is imported so beforeEach/afterEach don't trip the
  // import-unused lint gate if vitest ever tightens that.
  it("_meta: uses vitest matchers", () => {
    expect(vi).toBeDefined();
  });
});
