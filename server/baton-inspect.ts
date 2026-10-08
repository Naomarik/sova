import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

/**
 * `inspect_files` (§app.baton/files): basic read-only examination of ONE gathering session's
 * received files. The person chatting steers the model that calls it, so it must never reach
 * anything but their own files:
 *
 * - The command line is split here, never by a shell: words, quotes, and `|` between at most 4
 *   commands; every other shell character is refused.
 * - Each command and each of its options is on an allowlist (none reads or writes another file,
 *   runs a program or names a directory), and every word that names a file must be relative and
 *   resolve, links followed, inside the session's view folder (links to its files, nothing else).
 * - Where bwrap works, each command runs in it with only that folder (read-only, at /files) and
 *   /usr, no network, no home, a clean environment; elsewhere with the folder as its working
 *   directory and a clean environment. 10 seconds, low priority, 20,000 characters of output.
 */

export const INSPECT_TOOL = "inspect_files";
export const OUTPUT_MAX = 20_000;
export const INSPECT_TIMEOUT_MS = 10_000;
const STAGES_MAX = 4;
/** The most bytes read of a command's output (characters are cut after decoding). */
const READ_MAX = OUTPUT_MAX * 4;
const STDERR_MAX = 2_000;
const IMAGE_MAX = 5 * 1024 * 1024;

export class InspectRefusal extends Error {}

// ---- the command line ------------------------------------------------------------------------------

/** Split a command line into its pipeline's argv lists, without a shell. Throws an InspectRefusal. */
export function splitCommand(line: string): string[][] {
  const stages: string[][] = [[]];
  let word: string | null = null;
  const end = () => {
    if (word !== null) stages[stages.length - 1]!.push(word);
    word = null;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new InspectRefusal("A quote is not closed.");
      word = (word ?? "") + line.slice(i + 1, close);
      i = close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && (line[j + 1] === '"' || line[j + 1] === "\\")) j++;
        out += line[j];
      }
      if (j >= line.length) throw new InspectRefusal("A quote is not closed.");
      word = (word ?? "") + out;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= line.length) throw new InspectRefusal("A line can't end with \\.");
      word = (word ?? "") + line[++i];
      continue;
    }
    if (c === " " || c === "\t") {
      end();
      continue;
    }
    if (c === "|") {
      end();
      if (line[i + 1] === "|") throw new InspectRefusal("Only one command, or a pipeline joined by |: no ||, ;, &, redirection or substitution.");
      stages.push([]);
      continue;
    }
    if (";&<>`()\n\r{}".includes(c) || (c === "$" && line[i + 1] === "(")) throw new InspectRefusal("Only one command, or a pipeline joined by |: no ||, ;, &, redirection or substitution.");
    word = (word ?? "") + c;
  }
  end();
  if (stages.some((s) => !s.length)) throw new InspectRefusal("A command is missing (an empty line, or | with nothing after it).");
  if (stages.length > STAGES_MAX) throw new InspectRefusal(`At most ${STAGES_MAX} commands in a pipeline.`);
  return stages;
}

// ---- the allowlists --------------------------------------------------------------------------------

/** One command's options: bare single letters (combinable), letters that take a value, long forms. */
interface Spec {
  /** Bare single-letter options, combinable (`-la`). */
  flags: string;
  /** Single-letter options that take a value (`-n 5`, `-n5`). */
  valued?: string;
  /** Long options with no value. */
  long?: string[];
  /** Long options that take one value (`--x v`, `--x=v`), or more (`--arg name value`: 2). */
  longValued?: Record<string, number>;
  /** `-5` as a count (head, tail). */
  dashNumber?: boolean;
  /** Which positional words are files: all of them, or all but the first `skip` (a pattern, a filter). */
  skip?: (opts: Set<string>) => number;
  /** At most this many positional files. */
  maxFiles?: number;
}

const SPECS: Record<string, Spec> = {
  ls: { flags: "lahR1StrAFdi" },
  file: { flags: "bizL", long: ["--mime-type", "--mime", "--brief"] },
  wc: { flags: "lwcmL" },
  head: { flags: "qv", valued: "nc", dashNumber: true },
  tail: { flags: "qv", valued: "nc", dashNumber: true },
  cat: { flags: "nbAvETs" },
  grep: {
    flags: "icnlLvwxoEFhHrRaszqIP",
    valued: "emABC",
    long: ["--color=never", "--line-number", "--ignore-case", "--count", "--only-matching", "--recursive"],
    longValued: { "--include": 1, "--exclude": 1, "--exclude-dir": 1, "--max-count": 1 },
    skip: (o) => (o.has("-e") ? 0 : 1),
  },
  jq: {
    flags: "rcsSejnaMCR",
    long: ["--tab", "--raw-output", "--compact-output", "--slurp", "--sort-keys", "--null-input", "--join-output", "--ascii-output", "--exit-status", "--raw-input", "--seq", "--stream", "--raw-output0"],
    longValued: { "--arg": 2, "--argjson": 2, "--indent": 1 },
    skip: () => 1,
  },
  sort: { flags: "nrufbhVsdgMR", valued: "kt" },
  uniq: { flags: "cdui", valued: "fsw", maxFiles: 1 },
  cut: { flags: "s", valued: "dfcb", long: ["--complement"] },
};

/** unzip and tar: a fixed first word, then the archive, then member names (never an option). */
const ARCHIVE_MODES: Record<string, string[]> = {
  unzip: ["-l", "-p", "-Z", "-Z1"],
  tar: ["-tf", "-tvf", "-xOf", "tf", "tvf", "xOf"],
};

export const INSPECT_COMMANDS = [...Object.keys(SPECS), ...Object.keys(ARCHIVE_MODES)];

/** A file word inside the view, or a refusal naming it. `view` is real (resolved). */
function checkPath(view: string, word: string): void {
  const refuse = () => new InspectRefusal(`Only this conversation's files can be read: ${word}`);
  if (word === "-") return;
  if (!word || isAbsolute(word) || word.includes("\0")) throw refuse();
  let real: string;
  try {
    real = realpathSync(join(view, word));
  } catch {
    throw new InspectRefusal(`No file ${word} in this conversation (ls lists them).`);
  }
  const rel = relative(view, real);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw refuse();
}

/** jq programs may not load anything: no modules, no library search. */
function checkJqFilter(filter: string): void {
  if (/\b(import|include|modulemeta|get_search_list|input_filename)\b/.test(filter)) throw new InspectRefusal("jq may not import or include anything here.");
}

/** One stage, checked: the argv to run (the command first). Throws an InspectRefusal. */
export function checkStage(argv: readonly string[], view: string): string[] {
  const [cmd, ...args] = argv;
  if (!cmd) throw new InspectRefusal("A command is missing.");
  const archive = ARCHIVE_MODES[cmd];
  if (archive) {
    const [mode, file, ...members] = args;
    if (!mode || !archive.includes(mode)) throw new InspectRefusal(`${cmd} is allowed only as ${archive.filter((m) => m.startsWith("-")).map((m) => `${cmd} ${m} <file>`).join(", ")}.`);
    if (!file) throw new InspectRefusal(`Name the archive: ${cmd} ${mode} <file>.`);
    checkPath(view, file);
    if (file === "-") throw new InspectRefusal(`Name the archive: ${cmd} ${mode} <file>.`);
    for (const m of members) if (m.startsWith("-")) throw new InspectRefusal(`After the archive come only member names, never an option: ${m}`);
    return cmd === "tar" ? ["tar", "--force-local", mode.startsWith("-") ? mode : `-${mode}`, file, ...members] : ["unzip", mode, file, ...members];
  }
  const spec = SPECS[cmd];
  if (!spec) throw new InspectRefusal(`Not an allowed command: ${cmd}. Allowed: ${INSPECT_COMMANDS.join(", ")}.`);
  const seen = new Set<string>();
  const positional: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (endOfOptions || a === "-" || !a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      endOfOptions = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (spec.long?.includes(a)) {
        seen.add(a);
        continue;
      }
      const n = spec.longValued?.[name];
      if (n === undefined) throw new InspectRefusal(`${cmd}: option ${name} is not allowed here.`);
      seen.add(name);
      if (eq < 0) {
        if (i + n >= args.length) throw new InspectRefusal(`${cmd}: ${name} needs a value.`);
        i += n;
      } else if (n !== 1) throw new InspectRefusal(`${cmd}: ${name} takes ${n} words.`);
      continue;
    }
    if (spec.dashNumber && /^-\d+$/.test(a)) continue;
    // A cluster of single letters; a valued letter takes the rest of the word, or the next word.
    for (let j = 1; j < a.length; j++) {
      const l = a[j]!;
      if (spec.valued?.includes(l)) {
        seen.add(`-${l}`);
        if (j === a.length - 1) {
          // The next word is its value (grep's -e pattern included), never a file.
          if (i + 1 >= args.length) throw new InspectRefusal(`${cmd}: -${l} needs a value.`);
          i++;
        }
        break;
      }
      if (!spec.flags.includes(l)) throw new InspectRefusal(`${cmd}: option -${l} is not allowed here.`);
      seen.add(`-${l}`);
    }
  }
  const skip = spec.skip?.(seen) ?? 0;
  if (positional.length < skip) throw new InspectRefusal(cmd === "jq" ? "jq needs a filter, e.g. jq '.records | length' data.json" : `${cmd} needs a pattern.`);
  if (cmd === "jq") checkJqFilter(positional[0]!);
  const files = positional.slice(skip);
  if (spec.maxFiles !== undefined && files.length > spec.maxFiles) throw new InspectRefusal(`${cmd} takes at most ${spec.maxFiles} file here.`);
  for (const f of files) checkPath(view, f);
  return [cmd, ...args];
}

/** Every stage of a command line, checked. */
export function checkCommand(line: string, view: string): string[][] {
  const real = realpathSync(view);
  return splitCommand(line).map((s) => checkStage(s, real));
}

// ---- running ----------------------------------------------------------------------------------------

const SAFE_PATH = ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);

function which(name: string): string | null {
  for (const d of SAFE_PATH.split(delimiter)) {
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** The bwrap view of `view`: /usr, the system's /bin, /lib, /lib64 as they are (links or folders), the folder at /files. */
function bwrapArgs(bwrap: string, view: string): string[] {
  const out = [bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", "/files", "--ro-bind", "/usr", "/usr"];
  for (const d of ["/bin", "/lib", "/lib64", "/sbin"]) {
    try {
      const st = lstatSync(d);
      if (st.isSymbolicLink()) out.push("--symlink", realpathSync(d).replace(/^\//, ""), d);
      else if (st.isDirectory()) out.push("--ro-bind", d, d);
    } catch {
      // absent here
    }
  }
  for (const f of ["/etc/ld.so.cache", "/etc/magic", "/etc/localtime"]) if (existsSync(f)) out.push("--ro-bind", f, f);
  out.push("--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", view, "/files", "--chdir", "/files", "--");
  return out;
}

let bwrapState: string | null | undefined;
/** bwrap, when it is installed and works here (probed once). */
export function workingBwrap(): string | null {
  if (bwrapState !== undefined) return bwrapState;
  const bwrap = process.env.SOVA_INSPECT_BWRAP === "off" ? null : which("bwrap");
  bwrapState = null;
  if (bwrap) {
    const probe = spawnSync(bwrap, [...bwrapArgs(bwrap, "/usr").slice(1), "true"], { timeout: 5000, stdio: "ignore" });
    if (probe.status === 0) bwrapState = bwrap;
    else console.warn("[baton-inspect] bwrap is installed but can't run here: inspect_files runs unconfined (its checks still hold).");
  }
  return bwrapState;
}

export interface InspectOutput {
  text: string;
  /** `cat` of one image file, for a model that sees images. */
  image?: { data: string; mimeType: string };
}

const IMAGE_SIGS: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a"],
  ["image/webp", (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"],
];

/**
 * Run one checked command line against `view` (the session's view folder). Never throws for the
 * command's own failure: its exit and error output are part of the text.
 */
export async function runInspect(view: string, line: string, opts: { seesImages?: boolean; timeoutMs?: number; bwrap?: string | null } = {}): Promise<InspectOutput> {
  const real = realpathSync(view);
  const stages = checkCommand(line, real);
  // One image, shown: only a plain `cat <image>` for a model that sees images.
  if (opts.seesImages && stages.length === 1 && stages[0]!.length === 2 && stages[0]![0] === "cat") {
    const path = join(real, stages[0]![1]!);
    try {
      const st = statSync(path);
      if (st.isFile() && st.size <= IMAGE_MAX) {
        const bytes = readFileSync(path);
        const mime = IMAGE_SIGS.find(([, ok]) => ok(bytes))?.[0];
        if (mime) return { text: `${stages[0]![1]}: ${mime}, ${bytes.length} bytes, shown as an image.`, image: { data: bytes.toString("base64"), mimeType: mime } };
      }
    } catch {
      // read as text below
    }
  }
  const bwrap = opts.bwrap !== undefined ? opts.bwrap : workingBwrap();
  const nice = which("nice");
  const env = { PATH: SAFE_PATH, LANG: "C.UTF-8", HOME: real };
  const procs: ChildProcess[] = stages.map((argv) => {
    const full = [...(nice ? [nice, "-n", "10"] : []), ...(bwrap ? bwrapArgs(bwrap, real) : []), ...argv];
    return spawn(full[0]!, full.slice(1), { cwd: real, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  });
  procs[0]!.stdin!.end();
  // Each stage's output feeds the next by hand, with backpressure: stream.pipe() between two
  // children can spin on Bun once the reader exits first.
  for (let i = 0; i + 1 < procs.length; i++) {
    const from = procs[i]!.stdout!;
    const to = procs[i + 1]!.stdin!;
    let open = true;
    const shut = () => {
      if (!open) return;
      open = false;
      from.resume();
      to.end();
    };
    // A later stage that quits early (head) closes its input: no error for the one feeding it.
    to.on("error", () => {
      open = false;
      from.resume();
    });
    from.on("error", shut);
    from.on("data", (b: Buffer) => {
      if (!open) return;
      if (!to.write(b)) {
        from.pause();
        to.once("drain", () => from.resume());
      }
    });
    from.on("end", shut);
    procs[i + 1]!.on("close", () => {
      open = false;
      from.resume();
    });
  }
  const kill = () => {
    for (const p of procs)
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {
        // gone already
      }
  };
  const out: Buffer[] = [];
  let outBytes = 0;
  let cut = false;
  let errText = "";
  let timedOut = false;
  const last = procs[procs.length - 1]!;
  last.stdout!.on("data", (b: Buffer) => {
    if (cut) return;
    out.push(b);
    outBytes += b.length;
    if (outBytes > READ_MAX) {
      cut = true;
      kill();
    }
  });
  for (const p of procs)
    p.stderr!.on("data", (b: Buffer) => {
      if (errText.length < STDERR_MAX) errText += b.toString("utf8");
    });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs ?? INSPECT_TIMEOUT_MS);
  const codes = await Promise.all(
    procs.map(
      (p) =>
        new Promise<number | null>((resolve) => {
          p.on("error", (err) => {
            errText += `${err.message}\n`;
            resolve(127);
          });
          p.on("close", (code) => resolve(code));
        }),
    ),
  );
  clearTimeout(timer);
  const raw = Buffer.concat(out);
  let text: string;
  const nul = raw.subarray(0, 4096).filter((b) => b === 0).length;
  if (nul > 0) text = `(binary output, ${raw.length}${cut ? "+" : ""} bytes: not shown. file names the type; unzip -l or tar -tf list an archive.)`;
  else {
    text = raw.toString("utf8");
    if (text.length > OUTPUT_MAX) {
      text = text.slice(0, OUTPUT_MAX);
      cut = true;
    }
  }
  const lines = [text.replace(/\n$/, "")];
  if (cut) lines.push(`[Output cut at ${OUTPUT_MAX.toLocaleString("en-US")} characters.]`);
  if (timedOut) lines.push(`[Stopped after ${Math.round((opts.timeoutMs ?? INSPECT_TIMEOUT_MS) / 1000)} seconds.]`);
  const failed = codes.find((c) => c !== 0 && c !== null);
  const err = errText.trim().slice(0, STDERR_MAX).replaceAll(real, ".").replaceAll("/files/", "");
  if (err && !cut) lines.push(`[stderr] ${err}`);
  if (failed !== undefined && !cut && !timedOut) lines.push(`[exit ${failed}]`);
  const body = lines.filter((l, i) => i > 0 || l.length > 0).join("\n");
  return { text: body || "(no output)" };
}
