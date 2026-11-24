/**
 * The flaky tests a project's merge queue has seen, across landings, kept for good beside queue.json:
 *
 *   <state>/merge-queue/<key>/flaky.json   { v: 1, tests: MergeFlakyTest[] }
 *
 * A test counts once per run in which it failed and then passed on its rerun (run.ts: blame "flaky"). Keyed by check,
 * file and test name (whichever the runner named), so the same test seen by name in one run and by file in another
 * stays two rows: nothing is guessed. A damaged file reads as empty and is rewritten on the next record.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLAKY_RUNS_KEPT, type MergeFlakyTest } from "../../shared/merge-queue-health";

/** One flaky failure a run found (RunOutcome.flaky). */
export interface FlakySeen {
  check: string;
  label: string;
  file?: string;
  name?: string;
}

export const flakyKey = (s: Pick<FlakySeen, "check" | "file" | "name">): string => `${s.check}\u0000${s.file ?? ""}\u0000${s.name ?? ""}`;

/** Most often first, then most recent, then by key (a stable order for the same records). */
export const byFlakiness = (a: MergeFlakyTest, b: MergeFlakyTest): number => b.count - a.count || b.lastAt.localeCompare(a.lastAt) || a.key.localeCompare(b.key);

/**
 * `tests` with one run's flaky failures counted (pure). A run already counted for a test is never counted again (a
 * second record of the same run changes nothing).
 */
export function countFlaky(tests: readonly MergeFlakyTest[], seen: readonly FlakySeen[], run: { run: string; entry: string; branch: string; at: string }): MergeFlakyTest[] {
  const out = new Map(tests.map((t) => [t.key, t]));
  const once = new Set<string>();
  for (const s of seen) {
    const key = flakyKey(s);
    if (once.has(key)) continue;
    once.add(key);
    const had = out.get(key);
    if (had?.runs.some((r) => r.run === run.run)) continue;
    const runs = [run, ...(had?.runs ?? [])].slice(0, FLAKY_RUNS_KEPT);
    out.set(key, {
      key,
      check: s.check,
      checkLabel: s.label || had?.checkLabel || s.check,
      ...(s.file ? { file: s.file } : {}),
      ...(s.name ? { name: s.name } : {}),
      count: (had?.count ?? 0) + 1,
      firstAt: had?.firstAt && had.firstAt < run.at ? had.firstAt : run.at,
      lastAt: had?.lastAt && had.lastAt > run.at ? had.lastAt : run.at,
      runs,
      ...(had?.fix ? { fix: had.fix } : {}),
    });
  }
  return [...out.values()].sort(byFlakiness);
}

export class FlakyStore {
  readonly file: string;
  constructor(queueDir: string) {
    this.file = join(queueDir, "flaky.json");
  }

  list(): MergeFlakyTest[] {
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8")) as { tests?: unknown };
      const tests = Array.isArray(o?.tests) ? (o.tests as MergeFlakyTest[]).filter((t) => t && typeof t.key === "string" && typeof t.count === "number" && Array.isArray(t.runs)) : [];
      return tests.sort(byFlakiness);
    } catch {
      return [];
    }
  }

  get(key: string): MergeFlakyTest | undefined {
    return this.list().find((t) => t.key === key);
  }

  private write(tests: MergeFlakyTest[]): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, tests })}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Count one run's flaky failures; answers the tests it counted (none: nothing written). */
  record(seen: readonly FlakySeen[], run: { run: string; entry: string; branch: string; at: string }): MergeFlakyTest[] {
    if (!seen.length) return [];
    const before = this.list();
    const after = countFlaky(before, seen, run);
    const was = new Map(before.map((t) => [t.key, t.count]));
    const counted = after.filter((t) => t.count !== (was.get(t.key) ?? 0));
    if (counted.length) this.write(after);
    return counted;
  }

  /** Fix in New Chat was started for `key`. */
  markFix(key: string, fix: NonNullable<MergeFlakyTest["fix"]>): void {
    const tests = this.list();
    const t = tests.find((x) => x.key === key);
    if (!t) return;
    t.fix = fix;
    this.write(tests);
  }
}

/** The first message of a Fix in New Chat for a flaky test: what fails, how often, where its logs are. */
export function flakyFixText(t: MergeFlakyTest, o: { target: string; runPage: (run: string) => string; logs: { run: string; path: string }[] }): string {
  const what = [t.name ? `the test "${t.name}"` : null, t.file ? `${t.name ? "in " : "the test file "}${t.file}` : null].filter(Boolean).join(" ") || `the check ${t.checkLabel}`;
  const lines = [
    `Fix a flaky test: ${what} (check ${t.checkLabel}) failed and then passed on its rerun in ${t.count} merge queue run${t.count === 1 ? "" : "s"}, first ${t.firstAt.slice(0, 10)}, last ${t.lastAt.slice(0, 10)}.`,
    "",
    "Find why it fails only sometimes (timing, order, shared state, a port or file another test uses, a clock) and make it pass every time. Never skip it or loosen what it checks to make it pass; if it can't be made deterministic, say why.",
    "",
    "The runs that saw it (newest first):",
    ...t.runs.slice(0, 10).map((r) => `- ${r.run} on ${r.branch} at ${r.at} (${o.runPage(r.run)})`),
  ];
  if (o.logs.length) lines.push("", "Logs of those runs' failing step:", ...o.logs.map((l) => `- ${l.run}: ${l.path}`));
  lines.push("", `Work on a new branch from ${o.target}.`);
  return lines.join("\n");
}
