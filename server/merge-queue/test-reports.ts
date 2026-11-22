/**
 * The common test report formats a check's runner writes, read into the queue's own CheckReport, so a check that
 * writes no SOVA_OUT still names its failing tests and files (blame, narrow reruns): JUnit XML (pytest
 * --junitxml, Maven Surefire, Gradle, Jest/Vitest junit reporters, go-junit-report, ...) and TAP (node --test's tap
 * reporter, prove, tape, ...). Small, lenient readers: a runner writes what it can, and what isn't understood is
 * skipped, never fatal. Pure apart from readDeclaredReport's file reads. No dependency.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { CheckReport } from "./checks";

/** One test case as a report names it. */
export interface TestCase {
  /** The case's own name (JUnit `name`; TAP's description). */
  name: string;
  /** JUnit `classname` (a module, class or package path), when given. */
  classname?: string;
  /** The test file, when the report names it (JUnit `file` on the case or its suite; TAP `location:` / a file-named
   *  parent test), as the report wrote it. */
  file?: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

/** What a check declares its runner writes (MergeCheckDecl.report): a JUnit XML file or folder, or TAP in a file or
 *  on its own output ("stdout"). Paths are relative to the check's working folder. */
export type ReportDecl = { junit: string } | { tap: string };

// ---- JUnit XML ------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = unescapeXml(m[2] ?? m[3] ?? "");
  return out;
}
/** An element's text: CDATA kept as written, markup elsewhere dropped, entities read. */
const textOf = (s: string) =>
  s
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : unescapeXml(part.replace(/<[^>]+>/g, ""))))
    .join("")
    .trim();

/**
 * Every `<testcase>` of a JUnit XML document (any nesting of `<testsuites>`/`<testsuite>`): failed when it holds a
 * `<failure>` or `<error>`, skipped when it holds `<skipped>` (or `<disabled>`), else passed. A case's file is its own
 * `file` attribute, else its nearest suite's. Comments, processing instructions and DOCTYPE are ignored.
 */
export function parseJUnit(xml: string): TestCase[] {
  const doc = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const cases: TestCase[] = [];
  const suiteFiles: (string | undefined)[] = [];
  const re = /<(\/?)(testsuites|testsuite|testcase)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (tag === "testsuite") {
      if (close) suiteFiles.pop();
      else if (!selfClose) suiteFiles.push(attrsOf(rawAttrs!).file ?? suiteFiles.at(-1));
      continue;
    }
    if (tag !== "testcase" || close) continue;
    const a = attrsOf(rawAttrs!);
    let body = "";
    if (!selfClose) {
      const end = doc.indexOf("</testcase>", re.lastIndex);
      body = end < 0 ? doc.slice(re.lastIndex) : doc.slice(re.lastIndex, end);
      re.lastIndex = end < 0 ? doc.length : end + "</testcase>".length;
    }
    const fail = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<(skipped|disabled)\b/.test(body);
    const file = a.file || suiteFiles.at(-1);
    const name = a.name?.trim() || a.classname?.trim() || "";
    if (!name) continue;
    const message = fail ? (attrsOf(fail[2] ?? "").message || textOf(fail[4] ?? "").split("\n")[0] || fail[1]) : undefined;
    cases.push({
      name,
      ...(a.classname?.trim() ? { classname: a.classname.trim() } : {}),
      ...(file ? { file } : {}),
      status: fail ? "failed" : skipped ? "skipped" : "passed",
      ...(message ? { message: message.slice(0, 2000) } : {}),
    });
  }
  return cases;
}

// ---- TAP --------------------------------------------------------------------------------------------

const PATHISH = /^(?:file:\/\/)?(?:\.\/)?[\w@.+-][\w@.+/-]*\.[A-Za-z0-9]{1,6}$/;

/**
 * Every test point of a TAP stream (TAP 12-14): `ok`/`not ok` lines with any indentation (TAP 14 subtests), a
 * `# SKIP`/`# TODO` directive (TODO failures don't count as failures, as TAP says), the YAML block after a point
 * (`location:`/`file:` give its file, `message:`/`error:` its message), and `Bail out!`. A parent point whose
 * subtests were reported is left out (its leaves stand for it), and a parent named like a file path gives its leaves
 * their file (node --test names a file's top-level test after the file).
 */
export function parseTap(text: string): TestCase[] {
  type Point = TestCase & { depth: number; line: number };
  const lines = text.split(/\r?\n/);
  const points: Point[] = [];
  /** A subtest's name announced by `# Subtest: <name>` at each depth (TAP 14), for leaves' files. */
  const announced: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const depth = Math.floor((raw.length - raw.trimStart().length) / 4);
    const line = raw.trim();
    const sub = /^#\s*Subtest:\s*(.+)$/.exec(line);
    if (sub) {
      announced[depth] = sub[1]!.trim();
      announced.length = depth + 1;
      continue;
    }
    if (/^Bail out!/i.test(line)) {
      points.push({ name: line.replace(/^Bail out!\s*/i, "") || "Bail out!", status: "failed", message: line, depth, line: i });
      continue;
    }
    const p = /^(not ok|ok)\b(?:\s+\d+)?(?:\s*-\s*|\s+)?(.*)$/.exec(line);
    if (!p) continue;
    let desc = p[2] ?? "";
    let directive: string | null = null;
    const d = /\s*(?<!\\)#\s*(SKIP|TODO)\b.*$/i.exec(desc);
    if (d) {
      directive = d[1]!.toUpperCase();
      desc = desc.slice(0, d.index);
    }
    desc = desc.replace(/\\#/g, "#").trim();
    const failed = p[1] === "not ok" && directive !== "TODO";
    const point: Point = { name: desc || `test ${points.length + 1}`, status: directive === "SKIP" ? "skipped" : failed ? "failed" : "passed", depth, line: i };
    // A YAML diagnostic block right after the point, indented: `---` … `...`.
    if (lines[i + 1]?.trim() === "---") {
      let j = i + 2;
      const yaml: string[] = [];
      for (; j < lines.length && lines[j]!.trim() !== "..."; j++) yaml.push(lines[j]!);
      i = j;
      const field = (k: string) => {
        for (const y of yaml) {
          const f = new RegExp(`^\\s*${k}:\\s*(.*)$`).exec(y);
          if (f) return f[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
        }
        return undefined;
      };
      const loc = field("location") ?? field("file") ?? field("at");
      if (loc) {
        const file = loc.replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?\)?$/, "").replace(/^\(/, "");
        if (file) point.file = file;
      }
      const msg = field("message") ?? field("error");
      if (msg && failed) point.message = msg.slice(0, 2000);
    }
    if (!point.file && PATHISH.test(point.name)) {
      // A point named after its file stands for the file.
    } else if (!point.file) {
      for (let k = depth - 1; k >= 0; k--) if (announced[k] && PATHISH.test(announced[k]!)) {
        point.file = announced[k]!.replace(/^file:\/\//, "");
        break;
      }
    }
    if (failed && !point.message) point.message = `not ok: ${point.name}`.slice(0, 2000);
    points.push(point);
  }
  // A point followed (in TAP 14: preceded) by deeper points is their parent: its leaves stand for it. TAP 14 prints a
  // parent's own point after its indented subtests.
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1];
    const next = points[i + 1];
    const parentAfter = !!prev && prev.depth > p.depth;
    const parentBefore = !!next && next.depth > p.depth && next.line === p.line + 1;
    if (parentAfter || parentBefore) {
      // The leaves under a file-named parent take its file.
      if (PATHISH.test(p.name)) {
        for (let k = i - 1; k >= 0 && points[k]!.depth > p.depth; k--) points[k]!.file ??= p.name;
        for (let k = i + 1; k < points.length && points[k]!.depth > p.depth; k++) points[k]!.file ??= p.name;
      }
      continue;
    }
    out.push(p);
  }
  return out.map(({ depth: _d, line: _l, ...c }): TestCase => {
    if (!c.file && PATHISH.test(c.name)) c.file = c.name.replace(/^file:\/\//, "");
    return c;
  });
}

/** Whether `text` reads as a TAP stream: a `TAP version` line, or a plan (`1..N`) with at least one test point. */
export function looksLikeTap(text: string): boolean {
  if (/^TAP version \d+\s*$/m.test(text)) return true;
  return /^\s*1\.\.\d+\b/m.test(text) && /^\s*(?:not )?ok \d+\b/m.test(text);
}

// ---- into the queue's report ---------------------------------------------------------------------

/**
 * A file a report names, as a path from the repository's root: `cwd` (the check's working folder, from the root) is
 * prefixed to a relative path; an absolute one inside `copy` is made relative to it; anything outside the copy (a
 * library's frame) is dropped. `./` and `file://` go.
 */
export function rootPathOf(file: string, cwd: string, copy: string): string | null {
  let f = file.replace(/^file:\/\//, "");
  if (isAbsolute(f)) {
    const rel = relative(copy, f);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split("\\").join("/");
  }
  f = f.replace(/^\.\//, "");
  if (f.split("/").includes("..")) {
    const rel = relative(copy, join(copy, cwd, f));
    return rel.startsWith("..") ? null : rel.split("\\").join("/");
  }
  return cwd && cwd !== "." ? `${cwd.replace(/\/+$/, "")}/${f}` : f;
}

/**
 * A JUnit classname that names a Python module ("tests.test_math", pytest's default) as the file it lives in, when
 * that file exists under `dir`; else null. Only the module part counts ("tests.test_math.TestAdd" → tests/test_math.py).
 */
export function moduleFileOf(classname: string, dir: string): string | null {
  const parts = classname.split(".");
  for (let n = parts.length; n > 0; n--) {
    const rel = `${parts.slice(0, n).join("/")}.py`;
    if (existsSync(join(dir, rel))) return rel;
  }
  return null;
}

/**
 * The CheckReport of `cases`, every file as a repository path (rootPathOf over the check's `cwd`). A case's name in
 * the report is `classname.name` when it has a classname (the form a runner's own output shows), else its name.
 * ranFiles: every file the cases name, only when every case names one (else a rerun's proof stays its counts).
 */
export function reportOfCases(cases: readonly TestCase[], o: { cwd: string; copy: string; format: "junit" | "tap" }): CheckReport {
  const dir = join(o.copy, o.cwd);
  const fileOf = (c: TestCase): string | undefined => {
    const raw = c.file ?? (o.format === "junit" && c.classname ? moduleFileOf(c.classname, dir) ?? undefined : undefined);
    return raw ? rootPathOf(raw, o.cwd, o.copy) ?? undefined : undefined;
  };
  const named = cases.map((c) => ({ c, file: fileOf(c), name: c.classname && !c.name.startsWith(c.classname) ? `${c.classname}.${c.name}` : c.name }));
  const failed = named.filter((x) => x.c.status === "failed");
  const failures = failed.slice(0, 50).map((x) => ({ name: x.name.slice(0, 500), ...(x.file ? { file: x.file } : {}), ...(x.c.message ? { message: x.c.message } : {}) }));
  const allNamed = named.length > 0 && named.every((x) => x.file);
  return {
    passed: named.filter((x) => x.c.status === "passed").length,
    failed: failed.length,
    skipped: named.filter((x) => x.c.status === "skipped").length,
    failures,
    failingFiles: [...new Set(failed.flatMap((x) => (x.file ? [x.file] : [])))],
    failingNames: [...new Set(failed.map((x) => x.name.slice(0, 500)))],
    ...(failed.length ? { failingTests: failed.slice(0, 200).map((x) => ({ test: x.c.name.slice(0, 500), ...(x.file ? { file: x.file } : {}) })) } : {}),
    ...(allNamed ? { ranFiles: [...new Set(named.map((x) => x.file!))] } : {}),
    passedNames: [...new Set(named.filter((x) => x.c.status === "passed").map((x) => x.name.slice(0, 500)))],
    notes: [`read from the ${o.format === "junit" ? "JUnit XML" : "TAP"} report`],
  };
}

/** The XML files a declared JUnit path holds: the file itself, or every *.xml in the folder (3 levels deep), each
 *  written at or after `since` (ms; a report left by an earlier run in a reused copy never counts). */
function junitFiles(path: string, since: number): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  const fresh = (p: string) => {
    try {
      return statSync(p).mtimeMs >= since - 1000;
    } catch {
      return false;
    }
  };
  if (st.isFile()) return fresh(path) ? [path] : [];
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".xml") && fresh(p)) out.push(p);
      if (out.length >= 500) return;
    }
  };
  walk(path, 1);
  return out.sort();
}

/**
 * A check's declared report, read after it ran: `{junit}` the XML file or folder, `{tap: "stdout"}` the check's own
 * output, `{tap: <file>}` a TAP file; each path under the check's working folder `cwd` (from the copy's root) and
 * written since `since`. Null when nothing readable was written (no file, no test case in it): the queue then knows
 * no more than the exit code.
 */
export function readDeclaredReport(decl: ReportDecl, o: { copy: string; cwd: string; since: number; output: string }): CheckReport | null {
  const dir = join(o.copy, o.cwd);
  if ("junit" in decl) {
    const cases: TestCase[] = [];
    for (const f of junitFiles(join(dir, decl.junit), o.since)) {
      try {
        cases.push(...parseJUnit(readFileSync(f, "utf8")));
      } catch {
        /* unreadable: skipped */
      }
    }
    return cases.length ? reportOfCases(cases, { cwd: o.cwd, copy: o.copy, format: "junit" }) : null;
  }
  let text = "";
  if (decl.tap === "stdout") text = o.output;
  else {
    const f = join(dir, decl.tap);
    try {
      if (statSync(f).mtimeMs >= o.since - 1000) text = readFileSync(f, "utf8");
    } catch {
      return null;
    }
  }
  const cases = parseTap(text);
  return cases.length ? reportOfCases(cases, { cwd: o.cwd, copy: o.copy, format: "tap" }) : null;
}
