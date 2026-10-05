// Run: pnpm test -- server/harness/pi/quirks-meta.test.ts. Keeps the pi quirk registry honest
// (quirks.ts, QUIRKS.md, §app.harness/boundary): every row's canary is a test in contract.test.ts and every
// quirk canary there has a row; QUIRKS.md has the same rows; every cited site exists; and every private
// cast or SDK member assignment in Sova's server and shared code sits at a site some row names, so a new
// reach into pi's internals can't land without a row and a canary. Source scan only: nothing runs pi.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { PI_QUIRKS } from "./quirks.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The canary titles in contract.test.ts: `test("P<n> …"` / `test("T<n> …"`. */
function canaryTitles(): string[] {
  return [...read("server/harness/pi/contract.test.ts").matchAll(/\btest\(\s*"((?:\\.|[^"\\])*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`) as string)
    .filter((t) => /^[PT]\d+ /.test(t));
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "new", "typeof", "function", "with", "do", "else", "try"]);
/** The name a line declares (function, class, interface, method, accessor, or const/let bound to a function), or null. */
function declared(line: string): string | null {
  const t = line.trim();
  const m =
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_$][\w$]*)/.exec(t) ??
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(t) ??
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.exec(t) ??
    /^(?:(?:private|protected|public|static|readonly|override)\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(t);
  return m && !KEYWORDS.has(m[1]!) ? m[1]! : null;
}

const indent = (line: string) => line.length - line.trimStart().length;
const skipped = (line: string) => !line.trim() || /^\s*(?:\/\/|\*|\/\*|\))/.test(line);

/** Every declaration enclosing line `i`, innermost first (by indentation). */
function enclosing(lines: string[], i: number): string[] {
  const out: string[] = [];
  let limit = indent(lines[i]!);
  for (let j = i - 1; j >= 0 && limit > 0; j--) {
    const line = lines[j]!;
    if (skipped(line) || indent(line) >= limit) continue;
    limit = indent(line);
    const name = declared(line);
    if (name) out.push(name);
  }
  return out;
}

/** Reaches into pi's internals the registry must name: a private member cast, a method-table cast of an
    SDK object, or an assignment over an SDK member (not `this._x`, which is Sova's own). */
const DETECTORS: [string, RegExp][] = [
  ["private cast", /as unknown as \{\s*_/],
  ["method-table cast", /as unknown as Record<"(?:prompt|steer|followUp)"/],
  [
    "SDK member assignment",
    /(?<!\bthis)\.(?:_[A-Za-z]\w*|append(?:Compaction|ModelChange|ThinkingLevelChange|Message|CustomEntry|CustomMessageEntry|LabelChange|SessionInfo|Usage|ContextEdit)|streamFunction|getApiKey|hasConfiguredAuth|transformContext)\s*=(?![=>])/,
  ],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "fixtures" && e.name !== "golden") out.push(...sourceFiles(rel));
    } else if (/\.ts$/.test(e.name) && !/\.(?:test|d)\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
}

describe("pi quirk registry", () => {
  test("ids are unique and P/T numbered; every row is complete", () => {
    const ids = PI_QUIRKS.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate id");
    for (const q of PI_QUIRKS) {
      assert.match(q.id, /^[PT]\d+$/);
      assert.ok(q.name && q.relies && q.retireWhen && q.pi.length && q.where.length, `${q.id} is missing a field`);
      assert.ok(q.canary.startsWith(`${q.id} ${q.name.split(" (")[0]}:`), `${q.id}: the canary title starts "${q.id} ${q.name}:"`);
    }
  });

  test("every row's canary is a test in contract.test.ts, and every quirk canary there has a row", () => {
    const titles = canaryTitles();
    assert.equal(new Set(titles).size, titles.length, "duplicate canary title");
    const canaries = new Set(PI_QUIRKS.map((q) => q.canary));
    for (const q of PI_QUIRKS) assert.ok(titles.includes(q.canary), `${q.id}: no test titled ${JSON.stringify(q.canary)} in contract.test.ts`);
    for (const t of titles) assert.ok(canaries.has(t), `contract.test.ts: ${JSON.stringify(t)} is no registry row's canary (quirks.ts)`);
  });

  test("QUIRKS.md lists the same rows, each with its sites", () => {
    const md = read("server/harness/pi/QUIRKS.md");
    const rows = new Map([...md.matchAll(/^\| ([PT]\d+) .*$/gm)].map((m) => [m[1]!, m[0]]));
    assert.deepEqual([...rows.keys()], PI_QUIRKS.map((q) => q.id), "QUIRKS.md's table rows, in registry order");
    for (const q of PI_QUIRKS) {
      const row = rows.get(q.id)!;
      for (const w of q.where) assert.ok(row.includes(`\`${w.symbol}\``), `QUIRKS.md ${q.id}: the row names \`${w.symbol}\``);
    }
  });

  test("every cited site exists: the file, and the symbol declared in it", () => {
    for (const q of PI_QUIRKS)
      for (const w of q.where) {
        assert.ok(existsSync(join(ROOT, w.file)), `${q.id}: ${w.file} does not exist`);
        const names = w.symbol.split(".");
        const decls = new Set(read(w.file).split("\n").map(declared));
        for (const n of names) assert.ok(decls.has(n), `${q.id}: ${w.file} declares no ${n} (${w.symbol})`);
      }
  });

  test("every private cast and SDK member assignment in server/ and shared/ sits at a registered site", () => {
    const sites = new Map<string, Set<string>>();
    for (const q of PI_QUIRKS) for (const w of q.where) (sites.get(w.file) ?? sites.set(w.file, new Set()).get(w.file)!).add(w.symbol.split(".").at(-1)!);
    const unlisted: string[] = [];
    let hits = 0;
    for (const file of [...sourceFiles("server"), ...sourceFiles("shared")]) {
      const lines = read(file).split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(?:\/\/|\*)/.test(line)) return;
        for (const [what, re] of DETECTORS) {
          if (!re.test(line)) continue;
          hits++;
          const chain = enclosing(lines, i);
          if (!chain.some((n) => sites.get(file)?.has(n))) unlisted.push(`${relative(ROOT, join(ROOT, file))}:${i + 1} (${what} in ${chain[0] ?? "top level"}): ${line.trim()}`);
        }
      });
    }
    assert.ok(hits > 0, "the scan found nothing: the detectors are broken");
    assert.deepEqual(unlisted, [], "a reach into pi's internals no quirk names: add a row to quirks.ts and QUIRKS.md with a canary in contract.test.ts");
  });

  test("the scan's enclosing-declaration rule finds methods, functions and nested arrows", () => {
    const src = [
      "export async function outer(",
      "  a: string,",
      "): Promise<void> {",
      "  const restore = () => {",
      "    sm.appendCompaction = append;",
      "  };",
      "}",
      "class K {",
      "  private get host(): H {",
      "    if (x) {",
      "      (s as unknown as { _y(): void })._y();",
      "    }",
      "  }",
      "}",
    ];
    assert.deepEqual(enclosing(src, 4), ["restore", "outer"]);
    assert.deepEqual(enclosing(src, 10), ["host", "K"]);
    assert.ok(DETECTORS.some(([, re]) => re.test(src[4]!)) && DETECTORS.some(([, re]) => re.test(src[10]!)));
    assert.ok(!DETECTORS.some(([, re]) => re.test("    this._own = 1;")), "Sova's own private fields are not pi's");
  });
});
