/**
 * How much of a file a tool call put in front of the model: which of its lines, from the call's own
 * arguments. The Context tab tells a full read of a SKILL.md from a skim with it (server/context-tab.ts).
 *
 * A read is a chain of stages applied, in order, to the file's lines as one stream: a `pick` keeps
 * positions of the stream so far (sed -n A,Bp, head, tail -n +N, a read's offset and limit), `last`
 * keeps the stream's last lines (tail), and `cap` is the tool's own output limit (pi's read keeps
 * the head of what it reads, pi's bash the tail of what a command printed: 2000 lines or 50 KB).
 * An empty chain is the whole file. Chains are data, resolved against the file's current text
 * (`linesLoaded`), so the count follows the file as it is now, and paged reads add up as a union.
 *
 * The shell route is inferred, and narrow on purpose: only forms recognised here count (cat, nl,
 * less, more, bat with or without --line-range, head and tail with -n, sed -n with numeric line
 * addresses), piped through those same filters or none. Anything else (grep, awk, a regex address,
 * a filter we don't know, output sent to a file) counts nothing: the chip must never say a line was
 * read that may not have been.
 */

/** A position in the stream: a line number, or `$`, its last line. */
type Pos = number | "$";

export type LineStage =
  /** Keep these positions of the stream so far (1-based, inclusive), in stream order, each once. */
  | { kind: "pick"; ranges: readonly { from: Pos; to: Pos }[] }
  /** Keep the stream's last `count` lines. */
  | { kind: "last"; count: number }
  /** A tool's output limit: whole lines from the head or the tail, until either limit is reached. */
  | { kind: "cap"; keep: "head" | "tail"; lines: number; bytes: number };

/** Stages applied in order to a file's lines; [] is the whole file. */
export type LineChain = readonly LineStage[];

/** pi's tool output limits (pi-coding-agent dist/core/tools/truncate.js: DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES). */
export const TOOL_MAX_LINES = 2000;
export const TOOL_MAX_BYTES = 50 * 1024;

const readCap: LineStage = { kind: "cap", keep: "head", lines: TOOL_MAX_LINES, bytes: TOOL_MAX_BYTES };
/** What pi's bash tool keeps of a command's output. Applied to each read on its own: a command that
    prints several files shares the limit, which this doesn't model. */
export const BASH_CAP: LineStage = { kind: "cap", keep: "tail", lines: TOOL_MAX_LINES, bytes: TOOL_MAX_BYTES };

const toInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : undefined;
};

/** A read tool's call (pi's `offset`/`limit`; Claude Code's Read spells them the same). */
export function readToolChain(args: { offset?: unknown; limit?: unknown }): LineChain {
  const offset = toInt(args.offset);
  const limit = toInt(args.limit);
  const from = offset && offset > 0 ? offset : 1;
  if (limit !== undefined && limit <= 0) return [{ kind: "pick", ranges: [] }];
  const to: Pos = limit !== undefined ? from + limit - 1 : "$";
  return from === 1 && to === "$" ? [readCap] : [{ kind: "pick", ranges: [{ from, to }] }, readCap];
}

// ---- Resolving a chain against the file -----------------------------------------------------------

/** The file as a chain is resolved against: its line count, and each line's bytes (for a cap). */
export interface FileLines {
  count: number;
  /** Bytes of line n (1-based), its newline not included. Absent: caps count lines only. */
  bytes?: (line: number) => number;
}

/** Lines the way pi's tools and `wc -l` count them: a trailing newline ends the last line, it doesn't start one. */
export function fileLinesOf(text: string): FileLines {
  if (text === "") return { count: 0, bytes: () => 0 };
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const sizes = lines.map((l) => Buffer.byteLength(l, "utf8"));
  return { count: sizes.length, bytes: (n) => sizes[n - 1] ?? 0 };
}

function applyStage(stream: number[], stage: LineStage, file: FileLines): number[] {
  if (stage.kind === "last") return stage.count <= 0 ? [] : stream.slice(-stage.count);
  if (stage.kind === "pick") {
    const at = (p: Pos) => (p === "$" ? stream.length : p);
    const keep = new Set<number>();
    for (const r of stage.ranges) {
      const from = Math.max(1, at(r.from));
      const to = Math.min(stream.length, at(r.to));
      for (let i = from; i <= to; i++) keep.add(i);
    }
    return stream.filter((_, i) => keep.has(i + 1));
  }
  // A cap keeps whole lines, from its end, while both limits hold (pi's truncateHead / truncateTail).
  const order = stage.keep === "head" ? stream : [...stream].reverse();
  const kept: number[] = [];
  let bytes = 0;
  for (const line of order) {
    if (kept.length >= stage.lines) break;
    const size = (file.bytes?.(line) ?? 0) + (kept.length > 0 ? 1 : 0);
    if (bytes + size > stage.bytes) break;
    kept.push(line);
    bytes += size;
  }
  return stage.keep === "head" ? kept : kept.reverse();
}

/** The lines (1-based) a set of reads loaded between them: the union of each chain over the file. */
export function linesLoaded(chains: readonly LineChain[], file: FileLines): Set<number> {
  const out = new Set<number>();
  const all = Array.from({ length: file.count }, (_, i) => i + 1);
  for (const chain of chains) {
    let stream = all;
    for (const stage of chain) stream = applyStage(stream, stage, file);
    for (const line of stream) out.add(line);
  }
  return out;
}

// ---- The shell route --------------------------------------------------------------------------------

/** A heredoc's body is text a command writes, not a command being run: `python3 - <<'EOF' … EOF`. */
const stripHeredocs = (command: string): string => command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, " ");

type Tok = { op: string } | { word: string };

/** Words and operators, with quotes removed from words. Good enough for the common forms, no more:
    no expansion, and `$(…)` or backticks stay inside their word, so they never look like a file. */
function tokenize(command: string): Tok[] {
  const out: Tok[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) out.push({ word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if ((c === "$" && command[i + 1] === "(") || c === "`") {
      // A command substitution's output is captured, not shown: the whole of it stays one word.
      let end = i + 1;
      if (c === "`") end = command.indexOf("`", i + 1);
      else for (let depth = 0; end < command.length; end++) {
        if (command[end] === "(") depth++;
        else if (command[end] === ")" && --depth === 0) break;
      }
      const stop = end < 0 ? command.length : Math.min(end, command.length - 1);
      word += command.slice(i, stop + 1);
      inWord = true;
      i = stop;
    } else if (c === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") {
        word += command[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === " " || c === "\t") flush();
    else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "<" || c === ">" || c === "(" || c === ")") {
      // A digit right before a redirection is its file descriptor (`2>/dev/null`), not a word.
      const fd = (c === ">" || c === "<") && inWord && /^\d$/.test(word) ? word : "";
      if (fd) {
        word = "";
        inWord = false;
      } else flush();
      let op = c;
      const next = command[i + 1];
      if ((c === "|" || c === "&" || c === ">" || c === "<") && next === c) op += command[++i];
      else if (c === ">" && next === "&") op += command[++i];
      else if (c === "&" && next === ">") op += command[++i];
      out.push({ op: fd + op });
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return out;
}

/** A pipeline stage: its words, the files it reads from `<`, and whether its output leaves the screen. */
type Stage = { words: string[]; input: string[]; outToFile: boolean };

/** Commands (split at `;`, `&&`, `||`, `&`, newlines and parentheses), each a list of piped stages. */
function pipelines(command: string): Stage[][] {
  const out: Stage[][] = [];
  let line: Stage[] = [];
  let stage: Stage = { words: [], input: [], outToFile: false };
  const endStage = () => {
    line.push(stage);
    stage = { words: [], input: [], outToFile: false };
  };
  const endLine = () => {
    endStage();
    if (line.some((s) => s.words.length > 0)) out.push(line);
    line = [];
  };
  const toks = tokenize(stripHeredocs(command));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if ("word" in t) {
      stage.words.push(t.word);
      continue;
    }
    const { op } = t;
    if (op === "|") endStage();
    else if (op === "<") {
      const next = toks[i + 1];
      if (next && "word" in next) {
        stage.input.push(next.word);
        i++;
      }
    } else if (/^\d?(>|>>|>&)$/.test(op) || op === "&>" || op === "&>>") {
      const next = toks[i + 1];
      const target = next && "word" in next ? next.word : "";
      if (next && "word" in next) i++;
      // Only stdout sent somewhere else hides the output: `2>/dev/null` and `2>&1` don't.
      const fd = /^\d/.test(op) ? op[0] : "1";
      const toStdout = op.includes("&") && /^[12]$/.test(target);
      if ((fd === "1" || op.startsWith("&")) && !toStdout) stage.outToFile = true;
    } else endLine(); // ; && || & newline ( )
  }
  endLine();
  return out;
}

/** What one stage does: reads files (each through `chain`), filters its input through `chain`, or neither. */
type Verb = { files: string[]; chain: LineChain } | null;

const lineRange = (from: Pos, to: Pos): LineStage => ({ kind: "pick", ranges: [{ from, to }] });

/** `-n N`, `-nN`, `-N`, `--lines=N`, `--lines N` (head/tail), with flags that take no argument skipped.
    Returns the count as written ("+5", "-3", "40"), "" for none, or null for a form we don't read. */
function headTailArgs(words: string[]): { count: string; files: string[] } | null {
  let count = "";
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") {
      files.push(...words.slice(i + 1));
      break;
    }
    if (w === "-n" || w === "--lines") count = words[++i] ?? "";
    else if (w.startsWith("--lines=")) count = w.slice(8);
    else if (/^-n[+-]?\d+$/.test(w)) count = w.slice(2);
    else if (/^-\d+$/.test(w)) count = w.slice(1);
    else if (/^\+\d+$/.test(w)) count = w;
    else if (/^-[qvfFsz]+$/.test(w) || w === "--quiet" || w === "--silent" || w === "--verbose" || w === "--follow") continue;
    else if (w.startsWith("-")) return null; // -c bytes, and anything else we don't model
    else files.push(w);
  }
  return { count, files };
}

function headVerb(words: string[]): Verb {
  const a = headTailArgs(words);
  if (!a) return null;
  if (a.count === "") return { files: a.files, chain: [lineRange(1, 10)] };
  if (!/^\+?\d+$/.test(a.count)) return null; // `head -n -5`: all but the last 5, not modelled
  return { files: a.files, chain: [lineRange(1, Number(a.count))] };
}

function tailVerb(words: string[]): Verb {
  const a = headTailArgs(words);
  if (!a) return null;
  if (a.count === "") return { files: a.files, chain: [{ kind: "last", count: 10 }] };
  if (/^\+\d+$/.test(a.count)) return { files: a.files, chain: [lineRange(Math.max(1, Number(a.count.slice(1))), "$")] };
  if (/^-?\d+$/.test(a.count)) return { files: a.files, chain: [{ kind: "last", count: Math.abs(Number(a.count)) }] };
  return null;
}

/** One sed address: a line number or `$`. A regex address isn't read. */
const sedAddr = (s: string): Pos | null => (s === "$" ? "$" : /^\d+$/.test(s) ? Number(s) : null);

/** A sed script of numeric line ranges: `A,Bp`, `Ap`, `A,$p`, `A,+Np` under -n, each optionally
    ended by `Nq`; without -n only `Nq` (`sed 40q`). Anything else is null. */
function sedScript(script: string[], quiet: boolean): LineChain | null {
  const ranges: { from: Pos; to: Pos }[] = [];
  let quitAt: number | undefined;
  for (const command of script.flatMap((s) => s.split(/[;\n]/)).map((s) => s.trim()).filter(Boolean)) {
    const q = /^(\d+)\s*([qQ])$/.exec(command);
    if (q) {
      const n = Number(q[1]) - (q[2] === "Q" ? 1 : 0);
      quitAt = quitAt === undefined ? n : Math.min(quitAt, n);
      continue;
    }
    const m = /^(\d+|\$)(?:\s*,\s*(\d+|\$|\+\d+))?\s*p$/.exec(command);
    if (!m || !quiet) return null;
    const from = sedAddr(m[1]!)!;
    const end = m[2];
    const to: Pos = end === undefined ? from : end.startsWith("+") ? (from === "$" ? "$" : from + Number(end.slice(1))) : sedAddr(end)!;
    // sed's `A,B` with B before A prints line A alone.
    ranges.push(typeof from === "number" && typeof to === "number" && to < from ? { from, to: from } : { from, to });
  }
  if (!quiet) return quitAt === undefined ? null : [lineRange(1, quitAt)];
  if (ranges.length === 0) return null;
  const pick: LineStage = { kind: "pick", ranges };
  return quitAt === undefined ? [pick] : [lineRange(1, quitAt), pick];
}

function sedVerb(words: string[]): Verb {
  const script: string[] = [];
  const files: string[] = [];
  let quiet = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") {
      files.push(...words.slice(i + 1));
      break;
    }
    if (w === "--quiet" || w === "--silent") quiet = true;
    else if (w.startsWith("--expression=")) script.push(w.slice(13));
    else if (w === "--expression") script.push(words[++i] ?? "");
    else if (/^-[a-zA-Z]+$/.test(w)) {
      // Short flags, combinable (`-ne`): -e takes the rest or the next word; -i and -f aren't reads we model.
      for (let k = 1; k < w.length; k++) {
        const f = w[k]!;
        if (f === "n") quiet = true;
        else if (f === "E" || f === "r" || f === "s" || f === "u") continue;
        else if (f === "e") {
          script.push(k + 1 < w.length ? w.slice(k + 1) : (words[++i] ?? ""));
          break;
        } else return null;
      }
    } else if (w.startsWith("-")) return null;
    else if (script.length === 0) script.push(w);
    else files.push(w);
  }
  const chain = sedScript(script, quiet);
  return chain ? { files, chain } : null;
}

/** bat's `--line-range A:B` (`A:`, `:B`, `A`), any number of them; other flags are display-only. */
function batVerb(words: string[]): Verb {
  const ARG = new Set(["-l", "--language", "-H", "--highlight-line", "--style", "--theme", "-m", "--map-syntax", "--tabs", "--wrap", "--terminal-width", "--color", "--paging", "--decorations", "--italic-text", "--file-name"]);
  const ranges: { from: Pos; to: Pos }[] = [];
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    let range: string | undefined;
    if (w === "-r" || w === "--line-range") range = words[++i] ?? "";
    else if (w.startsWith("--line-range=")) range = w.slice(13);
    else if (/^-r.+/.test(w)) range = w.slice(2);
    else if (ARG.has(w)) i++;
    else if (w.startsWith("-")) continue;
    else files.push(w);
    if (range === undefined) continue;
    const m = /^(\d*):(\d*)$|^(\d+)$/.exec(range);
    if (!m) return null;
    ranges.push(m[3] ? { from: Number(m[3]), to: Number(m[3]) } : { from: m[1] ? Number(m[1]) : 1, to: m[2] ? Number(m[2]) : "$" });
  }
  return { files, chain: ranges.length ? [{ kind: "pick", ranges }] : [] };
}

/** Flags of nl that take an argument as the next word. */
const NL_ARG = new Set(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"]);

/** What a stage's words do, by its command's name. */
function verbOf(words: string[]): Verb {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // `LC_ALL=C cat …`
  const rest = words.slice(i);
  const name = (rest[0] ?? "").split("/").pop() ?? "";
  const plain = (skip: Set<string> = new Set()): Verb => {
    const files: string[] = [];
    for (let k = 1; k < rest.length; k++) {
      const w = rest[k]!;
      if (skip.has(w)) k++;
      else if (w.startsWith("+")) return null; // `less +40`: a start line we don't model
      else if (!w.startsWith("-") || w === "-") files.push(w);
    }
    return { files, chain: [] };
  };
  switch (name) {
    case "cat":
    case "less":
    case "more":
    case "tee":
      return plain();
    case "nl":
      return plain(NL_ARG);
    case "bat":
    case "batcat":
      return batVerb(rest);
    case "head":
      return headVerb(rest);
    case "tail":
      return tailVerb(rest);
    case "sed":
      return sedVerb(rest);
    default:
      return null;
  }
}

/**
 * The files a shell command prints, each with the lines of it that reach the output. A stage that
 * reads files starts a stream; each later stage must be a filter recognised here applied to its
 * input, or the read counts nothing. A file read by a filter in mid-pipeline isn't counted.
 */
export function shellReads(command: string): { path: string; chain: LineChain }[] {
  const out: { path: string; chain: LineChain }[] = [];
  for (const line of pipelines(command)) {
    const first = line[0]!;
    const verb = verbOf(first.words);
    if (!verb) continue;
    const files = [...verb.files.filter((f) => f !== "-"), ...first.input];
    if (files.length === 0) continue;
    let tail: LineStage[] = [];
    let shown = !first.outToFile;
    for (const stage of line.slice(1)) {
      const filter = stage.words[0] === "tee" ? { files: [], chain: [] } : verbOf(stage.words);
      // A filter reading files of its own prints those, not its input; one we don't know may print anything.
      if (!filter || filter.files.some((f) => f !== "-") || stage.input.length > 0) {
        shown = false;
        break;
      }
      // Several files are one stream to a filter that cuts it: which lines of each survive isn't modelled.
      if (files.length > 1 && filter.chain.length > 0) {
        shown = false;
        break;
      }
      tail = [...tail, ...filter.chain];
      shown = !stage.outToFile || stage.words[0] === "tee";
    }
    if (!shown) continue;
    for (const path of files) out.push({ path, chain: [...verb.chain, ...tail] });
  }
  return out;
}
