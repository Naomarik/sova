// Run: pnpm test -- server/harness/pi/insertion.test.ts. Insertion invariance (§app.harness/unknown-entries):
// an entry this pi version can't read changes no non-display output. For every committed pi fixture
// (synthetic and faux), a `future_entry` is inserted after an entry in turn (with an id, parented in the
// chain: the entry's children are re-parented to it) and each golden probe runs on the copy. The rows gain
// exactly one Unrecognized row; every non-display probe gives the original's output, once the inserted
// entry's own traces (its id as a key or list item, its raw line in a fork prefix) are left out. Files with
// id-less entries are legacy linear (pinned as they are) and skipped. SOVA_INSERTION_ALL=1 inserts after
// every entry instead of a sample of up to 10; SOVA_INSERTION_DEBUG=1 prints the differing values.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-insertion-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const g = await import("./golden/golden");
const { activeBranch, parseLines } = await import("./reader");
const PROBE_FILES = ["rows", "usage", "list", "baton", "overseer", "fork"];
const probes: import("./golden/golden").Probe[] = (await Promise.all(PROBE_FILES.map((n) => import(`./golden/probes/${n}.ts`)))).flatMap((m) => m.probes);

/** The probes that display nothing: their output must not change. */
const NON_DISPLAY = [
  "context", "insights-facts", "attention-turn", "skills", "worker-skills", "worker-fill", "unread", "summary", "head", "tail", "title-input",
  "tail-turn", "schedule-last-turn", "project-costs-title", "baton-view", "baton-facts", "share-view", "overseer-folds", "align-scan",
  "readiness-scan", "fork", "regenerate", "rewind", "chat-title",
];
/** Paths that move with the file by design, per probe: numbers that count its bytes or lines, and targets
    a probe picks by position (the middle entry, a prefix cut), which an extra entry shifts. */
const MOVES: Record<string, RegExp> = {
  "align-scan": /\.size$|^\$\.prefix\b/,
  "readiness-scan": /\.size$|^\$\.prefix\b/,
  "attention-turn": /^\$\.window4k\b/,
  fork: /^\$\.parse\.lines$/,
  unread: /^\$\.(mid|incremental)\b/,
  "share-view": /^\$\.branchTo\.mid\b/,
};

const INSERTED = "ffff0001";
const ALL = process.env.SOVA_INSERTION_ALL === "1";

interface Line { text: string; entry: Record<string, any> | null }

/** The fixture's lines, each with its parsed entry (null for the header, a blank or a malformed line). */
function linesOf(text: string): Line[] {
  return text.split("\n").map((t) => {
    try {
      const v = JSON.parse(t);
      return { text: t, entry: v && typeof v === "object" && v.type !== "session" ? v : null };
    } catch {
      return { text: t, entry: null };
    }
  });
}

/** `text` with an unknown entry after line `at`, its children re-parented to it. */
function inserted(lines: Line[], at: number): string {
  const host = lines[at]!.entry!;
  const out: string[] = [];
  lines.forEach((l, i) => {
    let t = l.text;
    if (i > at && typeof host.id === "string" && l.entry?.parentId === host.id) t = t.replace(`"parentId":${JSON.stringify(host.id)}`, `"parentId":"${INSERTED}"`);
    out.push(t);
    if (i === at) {
      const e: Record<string, unknown> = { type: "future_entry", id: INSERTED, parentId: typeof host.id === "string" ? host.id : null };
      if (host.timestamp !== undefined) e.timestamp = host.timestamp;
      e.payload = { inserted: true };
      out.push(JSON.stringify(e));
    }
  });
  return out.join("\n");
}

/** The output without the inserted entry's own traces: keys that hold its id, list items that are its id or
    a string or object carrying it (a raw line, a row, a compact copy of the entry), digests (they hash the
    lines), and its id where its host's stood (a re-parented child's parentId, the leaf a rewind left). */
function withoutInserted(v: unknown, host: string): unknown {
  const carries = (x: unknown) =>
    (typeof x === "string" && (x === INSERTED || x.includes(`"id":"${INSERTED}"`))) || (!!x && typeof x === "object" && !Array.isArray(x) && (x as Record<string, unknown>).id === INSERTED);
  if (typeof v === "string") return v === INSERTED ? host : v.replaceAll(`"parentId":"${INSERTED}"`, `"parentId":${JSON.stringify(host)}`);
  if (Array.isArray(v)) {
    // Raw lines (a fork prefix): the inserted entry's children now hang off its parent as written there,
    // which a fork that drops an entry may have moved.
    let parent = host;
    for (const x of v)
      if (typeof x === "string" && x.includes(`"id":"${INSERTED}"`))
        try {
          const p = JSON.parse(x)?.parentId;
          if (typeof p === "string") parent = p;
        } catch {}
    return v.filter((x) => !carries(x)).map((x) => withoutInserted(x, parent));
  }
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!k.includes(INSERTED) && k !== "$digest") out[k] = withoutInserted(x, host);
  return out;
}

/** Every difference path between two outputs, `MOVES` paths left out. */
function diffs(a: unknown, b: unknown, moves: RegExp | undefined, path = "$", out: string[] = []): string[] {
  if (a === b || moves?.test(path)) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object" || Array.isArray(a) !== Array.isArray(b)) {
    out.push(path);
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Array.isArray(a) ? [...Array(Math.max(a.length, (b as unknown[]).length)).keys()].map(String) : [...new Set([...Object.keys(ao), ...Object.keys(bo)])];
  for (const k of keys) {
    const p = Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`;
    if (!(k in ao) || !(k in bo)) out.push(p);
    else diffs(ao[k], bo[k], moves, p, out);
    if (out.length > 3) break;
  }
  return out;
}

const workspace = join(agentDir, "sessions", "--insertion--");
const sets = g.fixtureSets().filter((s) => s.name === "synthetic" || s.name === "faux");

for (const set of sets)
  describe(`insertion invariance, ${set.name}`, () => {
    for (const fx of set.fixtures) {
      const original = g.workspaceFixture(set, fx, workspace);
      const lines = linesOf(original.text);
      const hosts = lines.map((l, i) => (l.entry ? i : -1)).filter((i) => i >= 0);
      // An id-less file is legacy linear: its rows are keyed by position, and there is no chain to insert into.
      if (hosts.some((i) => typeof lines[i]!.entry!.id !== "string")) {
        test.skip(`${set.name}/${fx.name}: entries without ids (legacy linear, pinned as is)`, () => {});
        continue;
      }
      const at = ALL ? hosts : g.targetsOf({ private: true }, hosts.map(String)).map(Number);
      test(`${set.name}/${fx.name}: ${at.length} insertion points`, async () => {
        const base = new Map<string, unknown>();
        for (const p of probes) if (p.formats.includes("pi")) base.set(p.name, g.encode(await g.runProbe(p, original)));
        const problems: string[] = [];
        for (const i of at) {
          const text = inserted(lines, i);
          const path = join(workspace, `${set.name}__${fx.name}__ins${i}.src.jsonl`);
          writeFileSync(path, text);
          const copy = g.workspaceFixture({ ...set, name: `${set.name}-ins${i}` }, { ...fx, path }, workspace);
          const where = `${set.name}/${fx.name} after line ${i + 1}`;
          const host = lines[i]!.entry!.id as string;
          // Rows: the original's, plus one Unrecognized row for the inserted entry where it sits when it is on
          // the active branch (inserted on an abandoned one, none).
          const rows = g.encode(await g.runProbe(probes.find((p) => p.name === "rows")!, copy)) as string[];
          const before = base.get("rows") as string[];
          const onBranch = activeBranch(parseLines(text)).some((e) => e.id === INSERTED);
          const own = rows.filter((r) => JSON.parse(r).id === INSERTED);
          if (own.length !== (onBranch ? 1 : 0) || (onBranch && JSON.parse(own[0]!).kind !== "unknown")) problems.push(`rows ${where}: ${own.length} rows for the inserted entry (on the branch: ${onBranch})`);
          else if (JSON.stringify(withoutInserted(rows.filter((r) => !own.includes(r)), host)) !== JSON.stringify(before)) {
            const rest = withoutInserted(rows.filter((r) => !own.includes(r)), host) as string[];
            const k = rest.findIndex((r, j) => r !== before[j]);
            problems.push(`rows ${where}: the other rows changed at ${k}: ${process.env.SOVA_INSERTION_DEBUG ? `${before[k]} → ${rest[k]}` : ""}`);
          }
          for (const name of NON_DISPLAY) {
            const p = probes.find((x) => x.name === name)!;
            const got = withoutInserted(g.encode(await g.runProbe(p, copy)), host);
            const d = diffs(withoutInserted(base.get(name), host), got, MOVES[name]);
            if (d.length)
              problems.push(`${name} ${where}: ${d.slice(0, 3).join(", ")}${process.env.SOVA_INSERTION_DEBUG ? ` ${JSON.stringify(g.valueAt(withoutInserted(base.get(name), host), d[0]!))} → ${JSON.stringify(g.valueAt(got, d[0]!))}` : ""}`);
          }
        }
        assert.deepEqual(problems, []);
      });
    }
  });

