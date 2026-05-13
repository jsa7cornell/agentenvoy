/**
 * Tiny console ring buffer for feedback reports.
 *
 * Patches window.console.{log,info,warn,error} once per page load and keeps
 * the last N formatted lines in memory. Guest path now defaults console-on
 * (debug agents kept asking "what did the browser actually see?") so this
 * runs whenever the feedback UI is mounted.
 *
 * PII posture: browser-local. Nothing here is transmitted until the user
 * submits feedback; at submit time the lines go in the guest's own bundle.
 */

const MAX_LINES = 20;
const MAX_LINE_LEN = 2000;

type Level = "log" | "info" | "warn" | "error";

let installed = false;
let ring: string[] = [];

function format(level: Level, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  const line = `[${ts}] ${level.toUpperCase()} ${body}`;
  // Off-by-one guard: keep the truncated string at exactly MAX_LINE_LEN so the
  // server's `z.string().max(MAX_LINE_LEN)` Zod check passes. Pre-2026-05-13:
  // `slice(0, MAX_LINE_LEN) + "…"` produced MAX_LINE_LEN+1, silently rejecting
  // any feedback submission whose ring captured a long stack trace or JSON
  // dump with "Invalid submission" — surfaced by John on 2026-05-13 on link
  // rnmp4f. The ellipsis costs one of the MAX_LINE_LEN budget.
  return line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN - 1) + "…" : line;
}

export function installConsoleRing(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const levels: Level[] = ["log", "info", "warn", "error"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        ring.push(format(level, args));
        if (ring.length > MAX_LINES) ring = ring.slice(-MAX_LINES);
      } catch {
        /* never let logging kill the page */
      }
      original(...args);
    };
  }
}

export function getConsoleRing(): string[] {
  return ring.slice();
}
