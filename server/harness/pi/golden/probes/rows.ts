// Probes owned by batch R2 (rows on HEntry): the transcript's rows as wire JSON strings (byte identity, key
// order included), one entry at a time as the live path appends them, tool contents, the rows routes and the
// watch feed. A batch edits only its own probes file, and only to follow a moved function (README.md).
import { appendFileSync } from "node:fs";
import type { TranscriptItem } from "../../../../../shared/protocol";
import { normalizeClaudeText } from "../../../../claude-transcript";
import { resolveContext } from "../../../../models";
import { normalizeEntries, normalizeEntry } from "../../../../transcript";
import { activeBranch, parseLines } from "../../reader";
import { contextForBranch, contextOfBranch } from "../../usage";
import { clearRowsCache, transcriptLight, transcriptRows, type RowsQuery } from "../../../../transcript-rows";
import { claudeToolContent, piToolContent } from "../../../../transcript-tool";
import { SessionTail } from "../../../../watch";
import { contextTally } from "../../../../worker-context";
import type { Fixture, Probe } from "../golden";

const wire = (rows: readonly TranscriptItem[]) => rows.map((r) => JSON.stringify(r));
const rowsOf = (f: Fixture) => (f.format === "pi" ? normalizeEntries(activeBranch(parseLines(f.text))) : normalizeClaudeText(f.text));
const toolIds = (rows: readonly TranscriptItem[]) => rows.filter((r) => r.kind === "tool-call" || r.kind === "tool-result").map((r) => r.id);
/** A fixed window for every model ref: the watch probe pins the fill, not a catalog. */
const window = (ref: string) => (ref ? 200_000 : null);

/** The file's complete lines in three runs (the last keeps a torn tail), for the watch probe's appends. */
function thirds(text: string): [string, string, string] {
  const lines = text.split(/(?<=\n)/);
  const a = Math.ceil(lines.length / 3);
  const b = Math.ceil((2 * lines.length) / 3);
  return [lines.slice(0, a).join(""), lines.slice(a, b).join(""), lines.slice(b).join("")];
}

export const probes: Probe[] = [
  {
    name: "rows",
    formats: ["pi", "cc"],
    run: (f) => wire(rowsOf(f)),
  },
  {
    name: "rows-each",
    formats: ["pi"],
    // The live path: each appended entry alone, as chat-manager normalizes it (no running model).
    run: (f) => parseLines(f.text).map((e, i) => wire(normalizeEntry(e, `line${i}`))),
  },
  {
    name: "context",
    formats: ["pi"],
    run: (f) => contextForBranch(activeBranch(parseLines(f.text))),
  },
  {
    name: "tool-content",
    formats: ["pi", "cc"],
    async run(f) {
      const ids = [...toolIds(rowsOf(f)), "no-such-row"];
      return f.format === "pi" ? piToolContent(f.file(), ids) : claudeToolContent(f.file(), ids);
    },
  },
  {
    name: "transcript-rows",
    formats: ["pi"],
    async run(f) {
      clearRowsCache();
      const path = f.file();
      const rows = rowsOf(f);
      const entries = parseLines(f.text);
      const branchIds = new Set(activeBranch(entries).map((e) => e.id));
      const abandoned = entries.find((e) => typeof e.id === "string" && e.type !== "session" && !branchIds.has(e.id))?.id as string | undefined;
      const mid = rows[Math.floor(rows.length / 2)]?.id;
      const block = rows.find((r) => /:\d+$/.test(r.id))?.id;
      const explain = rows.find((r) => r.report?.explain?.id)?.report?.explain?.id;
      const queries: Record<string, RowsQuery> = {
        tail: { tail: true },
        "before-mid": mid ? { before: mid } : { before: "no-such-row" },
        "from-first": rows[0] ? { from: rows[0].id } : { from: "no-such-row" },
        "from-block-entry": block ? { from: block.replace(/:\d+$/, "") } : { from: "no-such-row" },
        "from-missing": { from: "no-such-row" },
        explain: { explain: explain ?? "no-such-explain" },
        chunk: { chars: 1 },
        "leaf-abandoned": abandoned ? { tail: true, leaf: abandoned } : { tail: true, leaf: "no-such-entry" },
      };
      const context = (branch: Parameters<typeof contextOfBranch>[0]) => resolveContext(contextOfBranch(branch));
      const out: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(queries)) out[name] = await transcriptRows(path, q, context);
      out.light = await transcriptLight(path, context);
      return out;
    },
  },
  {
    name: "watch",
    formats: ["pi", "cc"],
    async run(f) {
      const [one, two, three] = thirds(f.text);
      const path = f.copy("watch", one);
      const sent: string[] = [];
      const pi = f.format === "pi";
      const tail = new SessionTail(path, (m) => void sent.push(JSON.stringify(m)), pi ? undefined : normalizeClaudeText, contextTally(pi ? "pi" : "claude", window));
      // The snapshot and two reads, called directly: no watcher or poll timer runs beside them.
      const t = tail as unknown as { snapshot(): Promise<void>; readNew(): Promise<void> };
      await t.snapshot();
      appendFileSync(path, two);
      await t.readNew();
      appendFileSync(path, three);
      await t.readNew();
      tail.close();
      return sent;
    },
  },
];
