// judge: the held-out pool graded by three model judges (plan.md amendment 5). Packets for the
// judges, and their answers folded into grades.json (the per-pair median) with their agreement.
// Pure functions only; bench.ts reads and writes the files.

export const JUDGE_MODEL = "claude-opus-5-5";
export const JUDGE_EFFORT = "medium";
export const GRADER = `median of 3 model judges (${JUDGE_MODEL}, ${JUDGE_EFFORT})`;

/** One pooled pair to grade, in the pool's order. */
export interface Pair {
  qid: string;
  id: string;
}

export type Grades = Record<string, Record<string, number>>;

export const pairsOf = (items: readonly { qid: string; sessions: readonly { id: string }[] }[]): Pair[] => items.flatMap((it) => it.sessions.map((s) => ({ qid: it.qid, id: s.id })));

/** Every problem with one judge's answer file: a pooled pair missing or not graded 0, 1 or 2, a
    query or session the pool doesn't hold. Empty when it is complete. */
export function validateJudge(name: string, answer: unknown, pairs: readonly Pair[]): string[] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [`${name}: not a JSON object of {"<qid>": {"<sessionId>": 0|1|2}}`];
  const a = answer as Record<string, unknown>;
  const errs: string[] = [];
  const want = new Map<string, Set<string>>();
  for (const p of pairs) (want.get(p.qid) ?? want.set(p.qid, new Set()).get(p.qid)!).add(p.id);
  for (const [qid, ids] of want) {
    const g = a[qid];
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      errs.push(`${name}: query ${qid} has no grades`);
      continue;
    }
    for (const id of ids) {
      const v = (g as Record<string, unknown>)[id];
      if (v === undefined) errs.push(`${name}: ${qid} / ${id} is not graded`);
      else if (v !== 0 && v !== 1 && v !== 2) errs.push(`${name}: ${qid} / ${id} is graded ${JSON.stringify(v)}, not 0, 1 or 2`);
    }
    for (const id of Object.keys(g)) if (!ids.has(id)) errs.push(`${name}: ${qid} / ${id} is not in the pool`);
  }
  for (const qid of Object.keys(a)) if (!want.has(qid)) errs.push(`${name}: query ${qid} is not in the pool`);
  return errs;
}

export const median3 = (a: number, b: number, c: number): number => [a, b, c].sort((x, y) => x - y)[1]!;

/** The per-pair median of three complete, validated answer files. */
export function medianGrades(pairs: readonly Pair[], judges: readonly [Grades, Grades, Grades]): Grades {
  const out: Grades = {};
  for (const { qid, id } of pairs) (out[qid] ??= {})[id] = median3(judges[0][qid]![id]!, judges[1][qid]![id]!, judges[2][qid]![id]!);
  return out;
}

export interface Agreement {
  pairs: number;
  /** Share of pairs two judges grade the same, per judge pair. */
  pairwise: Record<string, number>;
  /** Share of pairs all three grade the same. */
  allThree: number;
  /** Fleiss' kappa over the three judges and grades 0/1/2; null when every grade is one value. */
  fleissKappa: number | null;
  /** Pairs where one judge gave 0 and another 2. */
  spread0to2: number;
  /** How often each grade was given, per judge, and in the median. */
  distribution: Record<string, [number, number, number]>;
}

export function agreement(pairs: readonly Pair[], names: readonly [string, string, string], judges: readonly [Grades, Grades, Grades], median: Grades): Agreement {
  const n = pairs.length;
  const g = (j: number, p: Pair) => judges[j]![p.qid]![p.id]!;
  const pairwise: Record<string, number> = {};
  for (const [x, y] of [[0, 1], [0, 2], [1, 2]] as const) pairwise[`${names[x]}~${names[y]}`] = n ? pairs.filter((p) => g(x, p) === g(y, p)).length / n : 0;
  let all = 0;
  let spread = 0;
  let pBar = 0;
  const totals = [0, 0, 0];
  const distribution: Record<string, [number, number, number]> = Object.fromEntries([...names, "median"].map((k) => [k, [0, 0, 0]]));
  for (const p of pairs) {
    const v = [g(0, p), g(1, p), g(2, p)];
    if (v[0] === v[1] && v[1] === v[2]) all++;
    if (Math.max(...v) - Math.min(...v) === 2) spread++;
    const counts = [0, 0, 0];
    v.forEach((x, j) => {
      counts[x]!++;
      totals[x]!++;
      distribution[names[j]!]![x]!++;
    });
    distribution.median![median[p.qid]![p.id]!]!++;
    pBar += (counts.reduce((a, c) => a + c * c, 0) - 3) / 6;
  }
  pBar = n ? pBar / n : 0;
  const pE = n ? totals.reduce((a, t) => a + (t / (3 * n)) ** 2, 0) : 1;
  return { pairs: n, pairwise, allThree: n ? all / n : 0, fleissKappa: pE >= 1 ? null : (pBar - pE) / (1 - pE), spread0to2: spread, distribution };
}

// ---- packets --------------------------------------------------------------------------------------

export interface PacketMessage {
  who: "user" | "assistant";
  lineAt: number;
  text: string;
}

export interface PacketSession {
  id: string;
  title: string;
  folder: string;
  lastActive: number;
  summary: string | null;
  firstPrompt: string;
  quotes: PacketMessage[];
  /** The copied session file, as it was at the search time. */
  path: string;
}

export interface PacketQuery {
  qid: string;
  words: string;
  at: number;
  ask?: string;
  sessions: PacketSession[];
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** `text` on one line, at most `n` characters, centred a little before the first query word it holds. */
export function trimAround(text: string, words: readonly string[], n: number): string {
  const t = flat(text);
  if (t.length <= n) return t;
  const lower = t.toLowerCase();
  const hit = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, Math.min(hit - Math.floor(n / 4), t.length - n));
  return `${from > 0 ? "…" : ""}${t.slice(from, from + n)}${from + n < t.length ? "…" : ""}`;
}

export const queryWords = (words: string): string[] => [...new Set(words.toLowerCase().split(/\s+/).filter(Boolean))];

/** Up to `k` messages written by `at` that hold the most query words (distinct, as substrings), in
    the order they were written. The first user message is shown on its own and left out here. */
export function relevantMessages<M extends PacketMessage>(msgs: readonly M[], words: string, at: number, k = 5, skip?: M): M[] {
  const ws = queryWords(words);
  const scored = msgs
    .map((m, i) => ({ m, i, n: m.lineAt <= at && m !== skip ? ws.filter((w) => m.text.toLowerCase().includes(w)).length : 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.i - a.i); // the most words, then the newest
  return scored
    .slice(0, k)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.m);
}

export const RUBRIC = [
  "## How to grade",
  "",
  "Each search below is words a searcher typed to find one earlier conversation (a coding-agent chat session). Under it are the sessions two search systems returned, merged, shuffled and shown blind: nothing says which system found which, or in what rank. Judge each session on its own.",
  "",
  "- **2**: this is the conversation the searcher was looking for.",
  "- **1**: related or partly useful (same topic or work, but not the one being sought).",
  "- **0**: not it.",
  "",
  "When a search has a \"What was asked just before\" line, it is the request that led to the search: the best statement of what the searcher was after. Grade on what each conversation held at the search time (the quotes below are cut there). You may read more of a session at its file path (a copy cut at the search time; JSONL, one entry per line); you need not. Grade every listed session; never skip one.",
  "",
].join("\n");

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export function renderQuery(q: PacketQuery, n: number, of: number): string {
  const ws = queryWords(q.words);
  const out = [`## Search ${n} of ${of}: \`${q.qid}\``, "", `- Words: **${q.words}**`, `- Searched at: ${iso(q.at)} UTC`];
  if (q.ask) out.push(`- What was asked just before: ${trimAround(q.ask, ws, 600)}`);
  out.push("", `${q.sessions.length} sessions to grade.`, "");
  for (const [i, s] of q.sessions.entries()) {
    out.push(`### ${q.qid} · session ${i + 1} of ${q.sessions.length}: \`${s.id}\``, "");
    out.push(`- Title: ${s.title}`, `- Folder: ${s.folder} · last active ${iso(s.lastActive)} UTC`);
    if (s.summary) out.push(`- Summary: ${flat(s.summary)}`);
    out.push(`- File: \`${s.path}\``, `- First user prompt: ${s.firstPrompt ? trimAround(s.firstPrompt, [], 600) : "(none)"}`);
    if (s.quotes.length) {
      out.push("- Messages holding the most search words (in order):");
      for (const m of s.quotes) out.push(`  - ${m.who === "user" ? "USER" : "ASSISTANT"} (${iso(m.lineAt)}): ${trimAround(m.text, ws, 400)}`);
    } else out.push("- No message held any search word by the search time.");
    out.push("");
  }
  return out.join("\n");
}

export const templateOf = (qs: readonly { qid: string; sessions: readonly { id: string }[] }[]): string =>
  JSON.stringify(Object.fromEntries(qs.map((q) => [q.qid, Object.fromEntries(q.sessions.map((s) => [s.id, "0|1|2"]))])), null, 1);

/** The pool split into packets of whole searches, each under `maxChars` where a search allows it. */
export function packets(qs: readonly PacketQuery[], maxChars: number): { file: string; body: string; qids: string[]; pairs: number }[] {
  const blocks = qs.map((q, i) => ({ q, text: renderQuery(q, i + 1, qs.length) }));
  const groups: (typeof blocks)[] = [];
  let cur: typeof blocks = [];
  let size = 0;
  for (const b of blocks) {
    if (cur.length && size + b.text.length > maxChars) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += b.text.length;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, k) => {
    const file = `packet-${String(k + 1).padStart(2, "0")}-of-${String(groups.length).padStart(2, "0")}.md`;
    const pairs = g.reduce((a, b) => a + b.q.sessions.length, 0);
    const body = [
      `# Search grading packet ${k + 1} of ${groups.length}`,
      "",
      `${g.length} searches, ${pairs} sessions. Answer every packet, then put all of them into one JSON file (the full template is in index.md).`,
      "",
      RUBRIC,
      "## Answer template for this packet",
      "",
      "Replace each `\"0|1|2\"` with the number 0, 1 or 2.",
      "",
      "```json",
      templateOf(g.map((b) => b.q)),
      "```",
      "",
      ...g.map((b) => b.text),
    ].join("\n");
    return { file, body, qids: g.map((b) => b.q.qid), pairs };
  });
}

export function indexOf(ps: readonly { file: string; qids: string[]; pairs: number }[], qs: readonly PacketQuery[]): string {
  const pairs = qs.reduce((a, q) => a + q.sessions.length, 0);
  return [
    "# Search grading: index",
    "",
    `${ps.length} packet${ps.length === 1 ? "" : "s"}, ${qs.length} searches, ${pairs} sessions to grade. Read every packet in this folder:`,
    "",
    ...ps.map((p) => `- \`${p.file}\`: ${p.qids.length} searches, ${p.pairs} sessions`),
    "",
    RUBRIC,
    "## Your answer",
    "",
    "One JSON file holding every search and every session below, each graded with the number 0, 1 or 2 (no other value, no extra keys):",
    "",
    "```json",
    templateOf(qs),
    "```",
    "",
  ].join("\n");
}
