/**
 * Eval candidate-set extraction (Phase 4 PR 2 — pre-work for Phase 5).
 *
 * Pulls anonymized turns from `Message` joined to `NegotiationSession`
 * + `NegotiationLink` over the trailing N days, scrubs PII, and writes
 * two JSONL files (`host.jsonl` for `administrator`-role turns,
 * `guest.jsonl` for `guest`-role turns) into
 * `eval/golden-sets/_candidates/`. These are *candidates* for John's
 * Phase 5 curation session — he marks each row keep/drop/edit and adds
 * the `expected_intent` / `expected_tone` columns himself. The curated
 * Phase 5 output lives one level up at `eval/golden-sets/host.jsonl`
 * and `guest.jsonl` (NOT in `_candidates/`).
 *
 * Dev-tooling only. Excluded from `tsconfig.json` per
 * `tsconfig.json:25` `"exclude": ["scripts"]`. NOT runtime, NOT a
 * migration, NOT MCP-wire.
 *
 * Invocation:
 *   npm run eval:extract-candidates -- --days=60 --dry-run
 *   npm run eval:extract-candidates -- --days=60 --max-per-role=200
 *
 * Flags:
 *   --days=N           trailing window in days (default 60, max 180)
 *   --out-dir=PATH     output dir (default eval/golden-sets/_candidates)
 *   --max-per-role=N   pre-curation candidate cap (default 500)
 *   --dry-run          parse + scrub but do not write
 *
 * Reference: refactor-package-2026-04-25/PROJECT-PLAN.md lines 258-262
 *            refactor-package-2026-04-25/CODEBASE-CLEANUP.md item 9
 *            refactor-package-2026-04-25/REVIEW.md N3 mitigation.
 */

import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { scrubPII, type ScrubContext } from "./pii-scrub";

// ---- Constants -----------------------------------------------------------

const DEFAULT_DAYS = 60;
const MAX_DAYS = 180;
const DEFAULT_MAX_PER_ROLE = 500;
const PRIOR_CONTENT_CAP = 200;
const SAMPLED_ROW_CEILING = 50_000; // memory-hazard guardrail (decision surface)

// ---- Types ---------------------------------------------------------------

interface CliArgs {
  days: number;
  outDir: string;
  maxPerRole: number;
  dryRun: boolean;
}

interface SessionContext {
  link_type: string;
  link_mode: string;
  session_status: string;
  session_format: string | null;
  session_duration_min: number | null;
}

interface CandidateRow {
  session_id_anon: string;
  turn_index: number;
  role: string; // literal Message.role — see header note in brief
  content_scrubbed: string;
  scrub_replacements: number;
  context: SessionContext & {
    prior_role: string | null;
    prior_content_scrubbed: string | null;
  };
  extracted_at: string;
}

// ---- CLI parsing ---------------------------------------------------------

function defaultOutDir(): string {
  // Anchored at repo root (where package.json lives) — `scripts/` is a
  // child of repo root, so two levels up from this file gets us there.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "eval", "golden-sets", "_candidates");
}

function parseArgs(argv: string[]): CliArgs {
  let days = DEFAULT_DAYS;
  let outDir = defaultOutDir();
  let maxPerRole = DEFAULT_MAX_PER_ROLE;
  let dryRun = false;

  for (const arg of argv) {
    if (arg.startsWith("--days=")) {
      const n = Number(arg.slice("--days=".length));
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--days must be a positive number, got "${arg}"`);
      }
      days = Math.min(n, MAX_DAYS);
      if (days !== n) {
        console.warn(
          `[eval:extract] --days=${n} clamped to ${MAX_DAYS} (max).`,
        );
      }
    } else if (arg.startsWith("--out-dir=")) {
      outDir = resolve(arg.slice("--out-dir=".length));
    } else if (arg.startsWith("--max-per-role=")) {
      const n = Number(arg.slice("--max-per-role=".length));
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--max-per-role must be a positive number, got "${arg}"`);
      }
      maxPerRole = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      console.warn(`[eval:extract] ignoring unknown arg: ${arg}`);
    }
  }

  return { days, outDir, maxPerRole, dryRun };
}

function printHelpAndExit(): never {
  console.log(
    [
      "Usage: npm run eval:extract-candidates -- [flags]",
      "",
      "Flags:",
      `  --days=N           trailing window in days (default ${DEFAULT_DAYS}, max ${MAX_DAYS})`,
      "  --out-dir=PATH     output dir (default eval/golden-sets/_candidates)",
      `  --max-per-role=N   pre-curation candidate cap (default ${DEFAULT_MAX_PER_ROLE})`,
      "  --dry-run          parse + scrub but do not write",
      "  --help, -h         this message",
    ].join("\n"),
  );
  process.exit(0);
}

// ---- Helpers -------------------------------------------------------------

/** Stable, anonymized session id for grouping multi-turn excerpts in
 *  John's curation pass. SHA-256 truncated to 12 hex chars + prefix. */
function anonymizeSessionId(sessionId: string): string {
  const hex = createHash("sha256").update(sessionId).digest("hex");
  return `sess_${hex.slice(0, 12)}`;
}

/** Cap and trim a string at `n` characters with a tail ellipsis if cut. */
function capContent(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

/** Build the `knownNames` allowlist for a session — the set of names
 *  that, if seen verbatim, should be replaced with `<NAME_n>`. Pulled
 *  from session.guestName, link.inviteeName/inviteeNames, and
 *  host.user.name. Filters falsy + dedupes case-insensitively while
 *  preserving the first-seen casing. */
function buildKnownNames(input: {
  hostName: string | null;
  guestName: string | null;
  inviteeName: string | null;
  inviteeNames: string[];
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    input.hostName,
    input.guestName,
    input.inviteeName,
    ...(input.inviteeNames ?? []),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// ---- Main ---------------------------------------------------------------

interface ExtractStats {
  totalMessages: number;
  hostRows: number;
  guestRows: number;
  skippedSystem: number;
  scrubbedReplacementsTotal: number;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const extractedAt = new Date().toISOString();

  console.log(
    `[eval:extract] days=${args.days} maxPerRole=${args.maxPerRole} dryRun=${args.dryRun} outDir=${args.outDir}`,
  );

  if (!process.env.DATABASE_URL) {
    console.error(
      "[eval:extract] DATABASE_URL not set. Aborting (we don't read .env files here).",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

    // Coarse pre-flight count to surface the memory-hazard decision
    // surface flagged in the brief: if >50k candidate Messages, stop
    // and prompt the architect for a sampling strategy.
    const totalMatching = await prisma.message.count({
      where: {
        role: { in: ["administrator", "guest"] },
        session: { createdAt: { gt: since } },
      },
    });

    if (totalMatching > SAMPLED_ROW_CEILING) {
      console.error(
        `[eval:extract] Aborting: ${totalMatching} candidate messages exceeds ` +
          `the ${SAMPLED_ROW_CEILING} memory-hazard ceiling. ` +
          `This is a decision surface — propose a sampling strategy ` +
          `(uniform random subsample, stratify by link.type, etc.) ` +
          `and re-run.`,
      );
      process.exit(2);
    }

    console.log(
      `[eval:extract] ${totalMatching} candidate messages in trailing ${args.days}d`,
    );

    // Pull host turns (administrator) and guest turns separately so
    // the per-role cap is enforced cleanly. We order by createdAt asc
    // so `turn_index` numbering is meaningful — the first message in
    // a session is index 0.
    const hostMessages = await prisma.message.findMany({
      where: {
        role: "administrator",
        session: { createdAt: { gt: since } },
      },
      orderBy: { createdAt: "asc" },
      take: args.maxPerRole,
      include: {
        session: {
          include: {
            link: true,
            host: { select: { name: true } },
          },
        },
      },
    });

    const guestMessages = await prisma.message.findMany({
      where: {
        role: "guest",
        session: { createdAt: { gt: since } },
      },
      orderBy: { createdAt: "asc" },
      take: args.maxPerRole,
      include: {
        session: {
          include: {
            link: true,
            host: { select: { name: true } },
          },
        },
      },
    });

    // Group by sessionId so we can compute turn_index + prior turn.
    // We need full session message lists (not just host or guest) for
    // accurate turn indexing and prior-turn context. Fetch one batch
    // per unique session id we care about.
    const sessionIds = new Set<string>([
      ...hostMessages.map((m) => m.sessionId),
      ...guestMessages.map((m) => m.sessionId),
    ]);

    const sessionMessageMap = new Map<
      string,
      Array<{ id: string; role: string; content: string; createdAt: Date }>
    >();
    for (const sid of sessionIds) {
      const all = await prisma.message.findMany({
        where: { sessionId: sid },
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, createdAt: true },
      });
      sessionMessageMap.set(sid, all);
    }

    const stats: ExtractStats = {
      totalMessages: hostMessages.length + guestMessages.length,
      hostRows: 0,
      guestRows: 0,
      skippedSystem: 0,
      scrubbedReplacementsTotal: 0,
    };

    function buildRow(
      msg: (typeof hostMessages)[number],
    ): CandidateRow | null {
      const session = msg.session;
      if (!session) return null;
      const link = session.link;
      if (!link) return null;

      const knownNames = buildKnownNames({
        hostName: session.host?.name ?? null,
        guestName: session.guestName ?? null,
        inviteeName: link.inviteeName ?? null,
        inviteeNames: link.inviteeNames ?? [],
      });
      const ctx: ScrubContext = { knownNames };

      const allTurns = sessionMessageMap.get(msg.sessionId) ?? [];
      const turnIndex = allTurns.findIndex((t) => t.id === msg.id);
      const priorTurn = turnIndex > 0 ? allTurns[turnIndex - 1] : null;

      const scrubbed = scrubPII(msg.content ?? "", ctx);
      stats.scrubbedReplacementsTotal += scrubbed.replacements;

      let priorRole: string | null = null;
      let priorContent: string | null = null;
      if (priorTurn) {
        priorRole = priorTurn.role;
        const priorScrub = scrubPII(priorTurn.content ?? "", ctx);
        priorContent = capContent(priorScrub.text, PRIOR_CONTENT_CAP);
      }

      return {
        session_id_anon: anonymizeSessionId(msg.sessionId),
        turn_index: turnIndex < 0 ? 0 : turnIndex,
        role: msg.role,
        content_scrubbed: scrubbed.text,
        scrub_replacements: scrubbed.replacements,
        context: {
          link_type: link.type,
          link_mode: link.mode,
          session_status: session.status,
          session_format: session.format ?? null,
          session_duration_min: session.duration ?? null,
          prior_role: priorRole,
          prior_content_scrubbed: priorContent,
        },
        extracted_at: extractedAt,
      };
    }

    const hostRows: CandidateRow[] = [];
    for (const m of hostMessages) {
      const row = buildRow(m);
      if (row) {
        hostRows.push(row);
        stats.hostRows++;
      }
    }

    const guestRows: CandidateRow[] = [];
    for (const m of guestMessages) {
      const row = buildRow(m);
      if (row) {
        guestRows.push(row);
        stats.guestRows++;
      }
    }

    if (args.dryRun) {
      console.log("[eval:extract] dry-run: no files written.");
      console.log(
        `[eval:extract] would write ${hostRows.length} host rows, ${guestRows.length} guest rows.`,
      );
    } else {
      mkdirSync(args.outDir, { recursive: true });
      const hostPath = join(args.outDir, "host.jsonl");
      const guestPath = join(args.outDir, "guest.jsonl");

      const hostJsonl =
        hostRows.map((r) => JSON.stringify(r)).join("\n") +
        (hostRows.length > 0 ? "\n" : "");
      const guestJsonl =
        guestRows.map((r) => JSON.stringify(r)).join("\n") +
        (guestRows.length > 0 ? "\n" : "");

      writeFileSync(hostPath, hostJsonl, "utf8");
      writeFileSync(guestPath, guestJsonl, "utf8");

      console.log(`[eval:extract] wrote ${hostRows.length} rows to ${hostPath}`);
      console.log(`[eval:extract] wrote ${guestRows.length} rows to ${guestPath}`);
    }

    console.log(
      `[eval:extract] stats: host=${stats.hostRows} guest=${stats.guestRows} ` +
        `total_replacements=${stats.scrubbedReplacementsTotal}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run main() when invoked directly (mirrors bench-intent).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("extract.ts") ||
  process.argv[1]?.endsWith("extract.js");

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[eval:extract] fatal:", err);
    process.exit(1);
  });
}
