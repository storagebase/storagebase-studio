/**
 * Unit tests for the seam ledger check (scripts/storagebase/seam-check.mjs).
 *
 * The pure parts (parseArgs, parseLedger, checkAgainstLedger) run against fixtures; the CLI arm runs
 * for real with `--base HEAD`, which diffs the fork against itself: zero changed paths, so the exit is
 * green without needing the upstream remote on this machine. What the check must never lose:
 *
 *   - an upstream file edited or deleted outside SEAMS.md is a violation, whatever the reason;
 *   - a ledgered file over its budget is a violation, counted from the merge-base;
 *   - a `regenerated` row is exempt from the budget but still has to be listed;
 *   - a ledger row whose target upstream no longer carries fails, so a renamed seam anchor surfaces
 *     as a red check rather than a silently dead row.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAgainstLedger, parseArgs, parseLedger } from "../../../scripts/storagebase/seam-check.mjs";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** A fake changes map and helpers to drive checkAgainstLedger without git. */
function fakeLedgerContext(ledger: Map<string, { id: string; added: number; removed: number; regenerated: boolean }>) {
  const changes = new Map<string, string>();
  const numstatOf = new Map<string, { added: number; removed: number }>();
  const upstreamFiles = new Set<string>();
  return {
    changes,
    numstatOf,
    upstreamFiles,
    edit(file: string, added: number, removed: number): void {
      changes.set(file, "M");
      numstatOf.set(file, { added, removed });
      upstreamFiles.add(file);
    },
    check(): string[] {
      return checkAgainstLedger(
        ledger,
        changes,
        (file) => numstatOf.get(file) ?? { added: 0, removed: 0 },
        (file) => upstreamFiles.has(file),
      );
    },
  };
}

describe("parseLedger", () => {
  test("parses budgets, unicode minus, regenerated rows, and skips non-table lines", () => {
    const ledger = parseLedger(
      [
        "Some prose before the table.",
        "",
        "| Id | File | Budget | Edit |",
        "|---|---|---|---|",
        "| S1 | `src/app/page.tsx` | +3/−0 | wrap Studio |",
        "| S4 | `src/lib/db/providers/keyvalue/redis.ts` | +2/−0 | sentinel spread |",
        "| S10 | `bun.lock` | regenerated | lockfile |",
        "| S11 | `CLAUDE.md` | +2 / -0 | anchor |",
        "Some prose after the table.",
      ].join("\n"),
    );

    expect(ledger.get("src/app/page.tsx")).toEqual({ id: "S1", added: 3, removed: 0, regenerated: false });
    expect(ledger.get("src/lib/db/providers/keyvalue/redis.ts")).toEqual({
      id: "S4",
      added: 2,
      removed: 0,
      regenerated: false,
    });
    expect(ledger.get("bun.lock")?.regenerated).toBe(true);
    expect(ledger.get("CLAUDE.md")).toEqual({ id: "S11", added: 2, removed: 0, regenerated: false });
    expect(ledger.size).toBe(4);
  });

  test("a text with no table rows is refused: a silent zero-row ledger checks nothing", () => {
    expect(() => parseLedger("No table here.")).toThrow("parsed to zero rows");
  });

  test("the real SEAMS.md parses, and every row id is unique", () => {
    const ledger = parseLedger(readFileSync(join(ROOT, "SEAMS.md"), "utf8"));
    const ids = [...ledger.values()].map((row) => row.id);

    expect(ledger.size).toBeGreaterThanOrEqual(12);
    expect(new Set(ids).size).toBe(ids.length);
    // The ledger rows are the contract's own examples; if these move, the table format moved.
    expect(ledger.has("src/lib/query-events/sink.ts")).toBe(true);
    expect(ledger.has("bun.lock")).toBe(true);
  });
});

describe("checkAgainstLedger", () => {
  test("an upstream file edited outside the ledger is a violation", () => {
    const ledger = parseLedger("| S1 | `src/app/page.tsx` | +3/−0 | rail |\n");
    const context = fakeLedgerContext(ledger);
    context.upstreamFiles.add("src/app/page.tsx");
    context.edit("src/components/hot-upstream-file.tsx", 1, 0);

    expect(context.check()).toEqual([
      "upstream file changed but not in SEAMS.md: edited src/components/hot-upstream-file.tsx",
    ]);
  });

  test("a deleted upstream file is a violation even though it adds no lines", () => {
    const ledger = parseLedger("| S1 | `src/app/page.tsx` | +3/−0 | rail |\n");
    const context = fakeLedgerContext(ledger);
    context.upstreamFiles.add("src/app/page.tsx");
    context.changes.set("src/components/deleted-leaf.tsx", "D");
    context.upstreamFiles.add("src/components/deleted-leaf.tsx");

    expect(context.check()).toEqual([
      "upstream file changed but not in SEAMS.md: deleted src/components/deleted-leaf.tsx",
    ]);
  });

  test("a seam within budget passes; the same seam over budget fails", () => {
    const ledger = parseLedger("| S2 | `src/lib/query-events/sink.ts` | +2/−0 | tap |\n");
    const within = fakeLedgerContext(ledger);
    within.edit("src/lib/query-events/sink.ts", 2, 0);
    expect(within.check()).toEqual([]);

    const over = fakeLedgerContext(ledger);
    over.edit("src/lib/query-events/sink.ts", 3, 0);
    expect(over.check()).toEqual(["S2: src/lib/query-events/sink.ts spent +3/−0, over its +2/−0 budget."]);
  });

  test("a fork-owned path never appears: it cannot conflict, so it is not the ledger's business", () => {
    const ledger = parseLedger("| S1 | `src/app/page.tsx` | +3/−0 | rail |\n");
    const context = fakeLedgerContext(ledger);
    context.upstreamFiles.add("src/app/page.tsx");
    context.changes.set("src/storagebase/audit/tap.ts", "M");
    // The file exists only on the fork side: existsAtBase says false.
    context.numstatOf.set("src/storagebase/audit/tap.ts", { added: 400, removed: 0 });

    expect(context.check()).toEqual([]);
  });

  test("a regenerated row is exempt from the budget, never from the listing", () => {
    const ledger = parseLedger("| S10 | `bun.lock` | regenerated | lockfile |\n");
    const context = fakeLedgerContext(ledger);
    context.edit("bun.lock", 1000, 900);

    expect(context.check()).toEqual([]);
  });

  test("a ledger row whose target upstream no longer carries fails loudly", () => {
    const ledger = parseLedger("| S8a | `src/components/renamed-away.tsx` | +2/−0 | stub |\n");
    const context = fakeLedgerContext(ledger);

    expect(context.check()).toEqual([
      "S8a: src/components/renamed-away.tsx does not exist at the upstream base — the seam target moved; update SEAMS.md.",
    ]);
  });
});

describe("parseArgs", () => {
  test("the upstream ref defaults to libredb/main and honours the environment override", () => {
    const before = process.env.STORAGEBASE_UPSTREAM_REF;
    process.env.STORAGEBASE_UPSTREAM_REF = "libredb/tags/1.2.0";
    expect(parseArgs([]).ref).toBe("libredb/tags/1.2.0");
    delete process.env.STORAGEBASE_UPSTREAM_REF;
    expect(parseArgs([]).ref).toBe("libredb/main");
    process.env.STORAGEBASE_UPSTREAM_REF = before;

    expect(parseArgs(["--ref", "libredb/tags/1.2.0", "--base", "abc1234"]).base).toBe("abc1234");
  });

  test("unknown options are refused rather than ignored", () => {
    expect(() => parseArgs(["--verbose"])).toThrow("Unknown option: --verbose");
  });
});

describe("the CLI arm", () => {
  test("the check runs green end to end", () => {
    const run = spawnSync("node", [join(ROOT, "scripts", "storagebase", "seam-check.mjs"), "--base", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("seam-check: green");
  });

  test("a missing upstream ref fails with fetch instructions instead of passing vacuously", () => {
    const run = spawnSync(
      "node",
      [join(ROOT, "scripts", "storagebase", "seam-check.mjs"), "--ref", "definitely-not-a-ref"],
      { cwd: ROOT, encoding: "utf8" },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("definitely-not-a-ref is not present locally");
  });
});
