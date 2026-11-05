// The macOS kill guard: before an agent's bash command runs on macOS, refuse the kill and kill-by-name
// forms that reach far more processes than the agent meant to. Pure and harness-neutral: a command
// string and a platform in, a refusal (the tool's reply) or undefined out. Never rewrites a command.
//
// Why macOS: BSD pkill and pgrep stop reading options at the first pattern (killall's manual shows options
// first and doesn't say what happens to a later one; it is refused too, and its reply says that), so
// `pkill -f "bun --watch x" -P 1` reads `-P` and `1` as two more patterns, and `1` matches nearly
// every process. On Linux (procps) the same line means what it says, so the guard never runs there.
//
// What it reads: the command split on ; & && || | |& ( ) and newlines, inside $( ), backticks and
// <( ), and the literal script of `sh -c` / `bash -c` / `zsh -c` and `eval`. Leading assignments and
// the wrappers sudo, doas, env, nice, nohup, time, timeout, command, builtin, exec, stdbuf and xargs are
// skipped; the command word is matched by basename. Heredoc bodies and comments are not commands.

/** Names too common to kill by: a pkill/killall pattern (or a pgrep that feeds a kill) that is just
 *  one of these, with nothing more specific, would also kill the user's own apps, editors, servers
 *  and other chats. Matched case-insensitively against the whole pattern, after regex trivia (^ $
 *  .* \b, a one-letter [n]ode class), a directory prefix and a version suffix (python3.12) are
 *  stripped. A longer pattern that names something specific (a script path, a port, a marker) is
 *  not in here and is allowed. Kept in one place; its tests are in shell-guard.test.ts. */
export const BROAD_NAMES: readonly string[] = [
  // Runtimes and interpreters
  "node", "nodejs", "bun", "deno", "python", "python3", "ruby", "java", "perl", "php", "go", "cargo",
  // Package managers and dev servers
  "npm", "npx", "pnpm", "yarn", "vite", "tsc", "esbuild", "webpack", "next", "jest", "vitest", "make",
  // Shells, terminals and sessions
  "sh", "bash", "zsh", "fish", "dash", "ksh", "tmux", "screen", "ssh", "sshd", "login", "sudo",
  "terminal", "iterm", "iterm2",
  // Browsers and their helpers
  "chrome", "google chrome", "google chrome helper", "chrome helper", "chromium", "firefox", "safari",
  "electron", "webkit", "msedge", "microsoft edge",
  // Desktop apps
  "code", "code helper", "visual studio code", "cursor", "slack", "docker", "docker desktop", "com.docker.backend",
  "finder", "dock", "mail", "messages", "zoom", "zoom.us", "discord", "spotify", "notes",
  // Agents and tools Sova itself runs
  "claude", "pi", "sova", "git", "helper",
  // The system: killing these logs the user out or takes the machine down
  "launchd", "windowserver", "loginwindow", "systemuiserver", "kernel_task", "mds", "coreaudiod",
];

const BROAD = new Set(BROAD_NAMES.map((n) => n.toLowerCase()));

/** One word of a command: its text with quotes removed, and whether it holds an expansion
 *  ($VAR, ${…}, $(…), `…`) whose value the guard can't see; `fixed` is the text without them. */
interface Word {
  text: string;
  fixed: string;
  dyn: boolean;
}

interface Lexed {
  commands: Word[][];
  /** The text inside each $( ), backticks and <( ) >( ), to read as commands of their own. */
  inner: string[];
  ok: boolean;
}

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\r";

/** Read a heredoc's delimiter at `i` (just past `<<`) onto `heredocs`; returns the index after it. */
function readHeredoc(src: string, i: number, heredocs: { delim: string; strip: boolean }[]): number {
  const strip = src[i] === "-";
  if (strip) i++;
  while (i < src.length && isSpace(src[i]!)) i++;
  const m = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i));
  if (!m) return i;
  heredocs.push({ delim: m[2]!, strip });
  return i + m[0].length;
}

/** Skip the bodies of the pending heredocs starting at line start `at`; they are data, not commands. */
function skipHeredocs(src: string, at: number, heredocs: { delim: string; strip: boolean }[]): number {
  for (const h of heredocs.splice(0)) {
    while (at < src.length) {
      const nl = src.indexOf("\n", at);
      const line = src.slice(at, nl < 0 ? src.length : nl);
      at = nl < 0 ? src.length : nl + 1;
      if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
    }
  }
  return at;
}

/** Find the `)` closing a `$(` or `<(` whose content starts at `i`; -1 when unbalanced. */
function closeParen(src: string, i: number): number {
  let depth = 1;
  const heredocs: { delim: string; strip: boolean }[] = [];
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n" && heredocs.length) i = skipHeredocs(src, i + 1, heredocs);
    else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") i = readHeredoc(src, i + 2, heredocs);
    else if (c === "<" && src.startsWith("<<<", i)) i += 3;
    else if (c === "\\") i += 2;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j + 1;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      if (i >= src.length) return -1;
      i++;
    } else if (c === "`") {
      const j = closeTick(src, i + 1);
      if (j < 0) return -1;
      i = j + 1;
    } else {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** Find the closing backtick of one opened at `i - 1`; -1 when unbalanced. */
function closeTick(src: string, i: number): number {
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === "`") return i;
    else i++;
  }
  return -1;
}

/** Split a shell command into simple commands of unquoted words. Approximate by design: it reads
 *  the shapes agents write, and says `ok: false` when quotes or substitutions don't close. */
export function lex(src: string): Lexed {
  const commands: Word[][] = [];
  const inner: string[] = [];
  let cmd: Word[] = [];
  let text = "";
  let fixed = "";
  let dyn = false;
  let started = false;
  let quoted = false;
  let skipNext = false; // the next word is a redirection's target
  const heredocs: { delim: string; strip: boolean }[] = [];
  let ok = true;

  const endWord = () => {
    if (!started) return;
    if (skipNext) skipNext = false;
    else cmd.push({ text, fixed, dyn });
    text = "";
    fixed = "";
    dyn = false;
    started = false;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (cmd.length) commands.push(cmd);
    cmd = [];
  };
  // A $NAME, ${…}, $(…) or `…` at i: added to the word as dynamic; returns the index after it.
  const dollar = (i: number): number => {
    const n = src[i + 1];
    if (n === "(") {
      const j = closeParen(src, i + 2);
      if (j < 0) {
        ok = false;
        return src.length;
      }
      inner.push(src.slice(i + 2, j));
      text += src.slice(i, j + 1);
      dyn = true;
      started = true;
      return j + 1;
    }
    if (n === "{") {
      const j = src.indexOf("}", i + 2);
      if (j < 0) {
        ok = false;
        return src.length;
      }
      text += src.slice(i, j + 1);
      dyn = true;
      started = true;
      return j + 1;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(src.slice(i + 1));
    if (!m) {
      text += "$";
      fixed += "$";
      started = true;
      return i + 1;
    }
    text += "$" + m[0];
    dyn = true;
    started = true;
    return i + 1 + m[0].length;
  };
  const tick = (i: number): number => {
    const j = closeTick(src, i + 1);
    if (j < 0) {
      ok = false;
      return src.length;
    }
    inner.push(src.slice(i + 1, j).replace(/\\`/g, "`"));
    text += src.slice(i, j + 1);
    dyn = true;
    started = true;
    return j + 1;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n" && heredocs.length) {
      endCommand();
      i = skipHeredocs(src, i + 1, heredocs);
      continue;
    }
    if (isSpace(c)) {
      endWord();
      i++;
    } else if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        text += src[i + 1] ?? "";
        fixed += src[i + 1] ?? "";
        started = true;
        i += 2;
      }
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) {
        ok = false;
        break;
      }
      text += src.slice(i + 1, j);
      fixed += src.slice(i + 1, j);
      started = quoted = true;
      i = j + 1;
    } else if (c === '"') {
      started = quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i]!;
        if (d === "\\" && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1]!)) {
          if (src[i + 1] !== "\n") {
            text += src[i + 1];
            fixed += src[i + 1];
          }
          i += 2;
        } else if (d === "$") i = dollar(i);
        else if (d === "`") i = tick(i);
        else {
          text += d;
          fixed += d;
          i++;
        }
      }
      if (i >= src.length) {
        ok = false;
        break;
      }
      i++;
    } else if (c === "$") {
      i = dollar(i);
    } else if (c === "`") {
      i = tick(i);
    } else if (c === "#" && !started) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      // Process substitution: its content is a command of its own.
      const j = closeParen(src, i + 2);
      if (j < 0) {
        ok = false;
        break;
      }
      inner.push(src.slice(i + 2, j));
      text += src.slice(i, j + 1);
      dyn = started = true;
      i = j + 1;
    } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // A redirection: a bare fd number before it is part of it, and the next word is its target.
      if (started && !quoted && /^[0-9]+$/.test(text)) {
        text = fixed = "";
        started = false;
      } else endWord();
      let op = c;
      i++;
      while (i < src.length && "<>&|-".includes(src[i]!) && op.length < 3) op += src[i++];
      if (op.startsWith("<<") && !op.startsWith("<<<")) {
        // A heredoc: read its delimiter word now, skip its body at the next newline.
        i = readHeredoc(src, op === "<<-" ? i - 1 : i, heredocs);
        continue;
      }
      if (/[&]$/.test(op) && /^[0-9-]/.test(src[i] ?? "")) {
        // >&2, <&- : the target is glued on.
        while (i < src.length && /[0-9-]/.test(src[i]!)) i++;
        continue;
      }
      skipNext = true;
    } else if (SEPARATORS.has(c)) {
      endCommand();
      i++;
    } else {
      text += c;
      fixed += c;
      started = true;
      i++;
    }
  }
  endCommand();
  return { commands, inner, ok };
}

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

/** Keywords that open or continue a compound command: what follows is the command. */
const LEAD_KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "while", "until", "do", "time", "coproc"]);
/** Keywords whose simple command runs nothing of its own (a loop header, a closer). */
const NOT_A_COMMAND = new Set(["for", "case", "select", "function", "done", "fi", "esac", "in"]);

/** Each wrapper's options that take a value: skip them with it. */
const WRAPPER_VALUE_OPTS: Record<string, string> = {
  sudo: "ugpCrtUDRTh",
  doas: "uC",
  env: "uSCP",
  nice: "n",
  exec: "a",
  timeout: "sk",
  gtimeout: "sk",
  stdbuf: "ioe",
  xargs: "IEeLlnPsdaJR",
  time: "",
  nohup: "",
  command: "",
  builtin: "",
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Strip leading assignments, keywords and wrappers; what is left is the command and its args. */
function unwrap(words: Word[]): { name: string; args: Word[]; script?: string } | null {
  let i = 0;
  for (;;) {
    while (i < words.length && (LEAD_KEYWORDS.has(words[i]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text))) i++;
    const w = words[i];
    if (!w) return null;
    if (NOT_A_COMMAND.has(w.text)) return null;
    const name = basename(w.text);
    const valueOpts = WRAPPER_VALUE_OPTS[name];
    if (valueOpts === undefined) {
      const args = words.slice(i + 1);
      if (SHELLS.has(name)) {
        // sh -c 'script': the literal script is read as commands too.
        let j = 0;
        while (j < args.length && args[j]!.text.startsWith("-") && args[j]!.text !== "--") {
          if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[j]!.text)) {
            const s = args[j + 1];
            return s ? { name, args, script: s.text } : { name, args };
          }
          j++;
        }
      }
      if (name === "eval") return { name, args, script: args.map((a) => a.text).join(" ") };
      return { name, args };
    }
    // A wrapper: skip its options (and their values), then what it runs.
    i++;
    if (name === "command" && words[i] && /^-[A-Za-z]*[vV]/.test(words[i]!.text)) return null; // command -v: only looks
    while (i < words.length) {
      const t = words[i]!.text;
      if (t === "--") {
        i++;
        break;
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      if (!t.startsWith("-") || t === "-") break;
      if (name === "nice" && /^-[0-9]+$/.test(t)) {
        i++;
        continue;
      }
      i++;
      if (t.startsWith("--")) {
        if (!t.includes("=") && /^--(signal|kill-after|user|group|replace|max-args|max-procs|delimiter|arg-file)$/.test(t)) i++;
        continue;
      }
      // -uName or -u Name: a value letter takes the rest of the cluster or the next word.
      const letters = t.slice(1);
      const at = [...letters].findIndex((l) => valueOpts.includes(l));
      if (at >= 0 && at === letters.length - 1) i++;
    }
    if (name === "timeout" || name === "gtimeout") i++; // its duration
  }
}

/** pkill/pgrep options (BSD and procps) that take a value. */
const PG_VALUE_OPTS = "FGgMNPsStUuJcdr";
const SIGNALS = new Set(
  "HUP INT QUIT ILL TRAP ABRT EMT FPE KILL BUS SEGV SYS PIPE ALRM TERM URG STOP TSTP CONT CHLD TTIN TTOU IO XCPU XFSZ VTALRM PROF WINCH INFO USR1 USR2".split(" "),
);
const isSignalOpt = (t: string) => /^-[0-9]+$/.test(t) || SIGNALS.has(t.slice(1).toUpperCase().replace(/^SIG/, ""));

/** A pattern with its regex trivia, directory and version suffix removed, lower-cased: what the
 *  broad-name table is matched against. */
export function corePattern(p: string): string {
  let s = p.trim();
  s = s.replace(/\[([^\]^]+)\]/g, (m, set: string) => (new Set(set.toLowerCase()).size === 1 ? set[0]! : m));
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^\^/, "").replace(/\$$/, "").replace(/^(\.\*|\.\+|\\b|\\<)/, "").replace(/(\.\*|\.\+|\\b|\\>)$/, "").trim();
  }
  if (!/\s/.test(s) && s.includes("/")) s = basename(s);
  return s.toLowerCase();
}

/** The broad name a pattern is, or undefined. */
export function broadName(p: string): string | undefined {
  const s = corePattern(p);
  if (BROAD.has(s)) return s;
  const unversioned = s.replace(/[0-9][0-9.]*$/, "").replace(/[-@]$/, "");
  return unversioned && BROAD.has(unversioned) ? unversioned : undefined;
}

type Problem = { what: string; why: string; fix: string };

const show = (name: string, args: Word[]) => [name, ...args.map((a) => (/[\s"'$]/.test(a.text) ? `'${a.text}'` : a.text))].join(" ");

const FIX_SPECIFIC = "match something specific instead (a script path, a port, a unique marker: `pkill -f 'vite --port 5317'`), or kill by PID (`lsof -ti :PORT | xargs kill`, `kill $(cat app.pid)`)";

/** A regex's top-level alternatives (`a|b`, `(a|b)`, `a\|b`), or the pattern alone: each one matches on
 *  its own, so each is checked. An alternation inside a group of a longer pattern (`app-(a|b)`) is not split. */
export function alternatives(p: string): string[] {
  let s = p.trim();
  if (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) wraps = false;
    }
    if (wraps) s = s.slice(1, -1);
  }
  const out: string[] = [];
  let depth = 0;
  let part = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|" && depth === 0) {
      out.push(part);
      part = "";
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "|" && depth === 0) {
      out.push(part);
      part = "";
    } else part += c;
  }
  out.push(part);
  return out;
}

/** Check the patterns a kill-by-name will act on. */
function checkPatterns(cmd: string, patterns: Word[]): Problem | undefined {
  for (const p of patterns) {
    for (const alt of alternatives(p.dyn ? p.fixed : p.text)) {
      const broad = broadName(alt);
      if (broad)
        return { what: cmd, why: `\`${p.text}\` is a name this broad: it would also kill the user's own apps, editors, servers and other chats running ${broad}`, fix: FIX_SPECIFIC };
      const core = corePattern(alt);
      if (p.dyn && core.length <= 2)
        return { what: cmd, why: `the pattern \`${p.text}\` comes from a variable or a command, so Sova can't see what it matches`, fix: `write the pattern out literally, or ${FIX_SPECIFIC}` };
      if (core.length <= 2)
        return { what: cmd, why: `the pattern \`${p.text}\` is ${core.length ? "one or two characters" : "empty"}, so it matches nearly every process`, fix: FIX_SPECIFIC };
    }
  }
  return undefined;
}

/** pkill, or pgrep (whose output a kill in the same command acts on when `killing`). */
function checkPgrep(name: string, args: Word[], killing: boolean): Problem | undefined {
  const cmd = show(name, args);
  const patterns: Word[] = [];
  let pidFile = false;
  let invert = false;
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (afterDashes || !t.startsWith("-") || t === "-") {
      patterns.push(args[i]!);
      continue;
    }
    if (t === "--") {
      if (patterns.length) return misplaced(cmd, name, t);
      afterDashes = true;
      continue;
    }
    if (patterns.length) return misplaced(cmd, name, t);
    if (isSignalOpt(t)) continue;
    if (t.startsWith("--")) {
      if (/^--(signal|pidfile|group|pgroup|parent|session|terminal|euid|uid|delimiter|ns|nslist|runstates|cgroup|env)$/.test(t)) i++;
      if (/^--(pidfile)/.test(t)) pidFile = true;
      if (t === "--inverse") invert = true;
      continue;
    }
    const letters = t.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const l = letters[k]!;
      if (l === "v") invert = true;
      if (PG_VALUE_OPTS.includes(l)) {
        if (l === "F") pidFile = true;
        if (k === letters.length - 1) i++;
        break;
      }
    }
  }
  if (name === "pgrep" && !killing) return undefined;
  const acting = name === "pkill" ? "pkill" : "pgrep feeding a kill";
  if (invert)
    return { what: cmd, why: `-v inverts the match: ${acting} then signals every process except the ones named`, fix: FIX_SPECIFIC };
  if (!patterns.length && !pidFile)
    return { what: cmd, why: `${acting} with no pattern signals every process its other options select (a whole user, a parent, a terminal)`, fix: FIX_SPECIFIC };
  return checkPatterns(cmd, patterns);
}

function misplaced(cmd: string, name: string, opt: string): Problem {
  return {
    what: cmd,
    why: `on macOS, ${name} reads every argument after the first pattern as another pattern, so \`${opt}\` and what follows are patterns here, and a short one like \`1\` matches nearly every process`,
    fix: `put every option before the pattern (\`${name} -P 1 -f 'pattern'\`), or kill by PID (\`lsof -ti :PORT | xargs kill\`)`,
  };
}

/** killall (macOS): options first, then names; -m makes them regexes; -u/-t alone select everything. */
function checkKillall(args: Word[]): Problem | undefined {
  const cmd = show("killall", args);
  const names: Word[] = [];
  let selector = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (!t.startsWith("-") || t === "-") {
      names.push(args[i]!);
      continue;
    }
    if (names.length)
      return {
        what: cmd,
        why: "killall takes its options before the name, and what it does with one after the name isn't documented, so Sova refuses it",
        fix: "put every option before the name (`killall -9 name`), or kill by PID (`lsof -ti :PORT | xargs kill`)",
      };
    if (t === "--") continue;
    if (t === "-c" && args[i + 1]) {
      names.push(args[++i]!);
      continue;
    }
    if (t === "-u" || t === "-t") {
      selector = true;
      i++;
    }
  }
  if (!names.length && selector)
    return { what: cmd, why: "killall with -u or -t and no name signals every process of that user or terminal", fix: FIX_SPECIFIC };
  return checkPatterns(cmd, names);
}

/** kill: any `-1` is refused (a PID of -1 is every process the user owns). */
function checkKill(name: string, args: Word[]): Problem | undefined {
  if (args.some((a) => !a.dyn && a.text === "-1"))
    return {
      what: show(name, args),
      why: "a PID of `-1` signals every process you own (and `-1` as a signal is easy to misread; write `-HUP` for that)",
      fix: "kill by PID (`lsof -ti :PORT | xargs kill`, `kill $(cat app.pid)`), or by a specific pattern (`pkill -f 'unique-marker'`)",
    };
  return undefined;
}

const KILLERS = new Set(["kill", "pkill", "killall"]);
const GREPS = new Set(["grep", "egrep", "fgrep", "rg"]);
/** grep options that take a value (the pattern itself comes through -e). */
const GREP_VALUE_OPTS = "ABCmfdDe";

/** `ps … | grep <pattern> | … | xargs kill`: a grep that picks PIDs by a broad name is that kill's
 *  pattern. Only broad names are checked here (a short grep like `grep -v grep` is common and fine). */
function checkPsGrep(name: string, args: Word[]): Problem | undefined {
  const patterns: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === "-e" && args[i + 1]) patterns.push(args[++i]!);
    else if (t.startsWith("-") && t !== "-") {
      if (!t.startsWith("--") && GREP_VALUE_OPTS.includes(t.slice(-1)) && t.length === 2) i++;
    } else {
      if (!patterns.length) patterns.push(args[i]!);
      break;
    }
  }
  for (const p of patterns) {
    for (const alt of alternatives(p.dyn ? p.fixed : p.text)) {
      const broad = broadName(alt);
      if (broad)
        return { what: show(name, args), why: `\`${p.text}\` picks the PIDs to kill by a name this broad: it would also kill the user's own apps, editors, servers and other chats running ${broad}`, fix: FIX_SPECIFIC };
    }
  }
  return undefined;
}
const MAX_DEPTH = 6;

/** Every simple command of a script, its substitutions and its `sh -c` / `eval` strings, unwrapped. */
function collect(src: string, depth: number, out: { name: string; args: Word[] }[]): boolean {
  if (depth > MAX_DEPTH) return false;
  const lexed = lex(src);
  let ok = lexed.ok;
  for (const words of lexed.commands) {
    const u = unwrap(words);
    if (!u) continue;
    out.push({ name: u.name, args: u.args });
    if (u.script !== undefined) ok = collect(u.script, depth + 1, out) && ok;
  }
  for (const s of lexed.inner) ok = collect(s, depth + 1, out) && ok;
  return ok;
}

/** The first problem with the kills in a command, or undefined when there is none. Platform-free. */
export function killProblem(command: string): Problem | undefined {
  const cmds: { name: string; args: Word[] }[] = [];
  const ok = collect(command, 0, cmds);
  if (!ok && /(^|[^A-Za-z0-9_-])(pkill|pgrep|killall|kill)([^A-Za-z0-9_-]|$)/.test(command))
    return {
      what: command.trim().slice(0, 120),
      why: "Sova couldn't read this command reliably (an unclosed quote or substitution, or nesting too deep), and it holds a kill",
      fix: "write the kill as its own plain command",
    };
  // A pgrep is checked as a kill when anything in the same command kills: its PIDs may reach it
  // through a pipe, xargs, $( ), a variable or a loop.
  const killing = cmds.some((c) => KILLERS.has(c.name));
  const psGrep = killing && cmds.some((c) => c.name === "ps");
  for (const c of cmds) {
    const p =
      psGrep && GREPS.has(c.name)
        ? checkPsGrep(c.name, c.args)
        : c.name === "pkill" || c.name === "pgrep"
        ? checkPgrep(c.name, c.args, c.name === "pkill" || killing)
        : c.name === "killall"
          ? checkKillall(c.args)
          : c.name === "kill"
            ? checkKill(c.name, c.args)
            : undefined;
    if (p) return p;
  }
  return undefined;
}

/** The reply that refuses an agent's bash command on macOS, or undefined to let it run. Linux and
 *  every other platform: always undefined, the check never runs. */
export function killGuardRefusal(command: string, platform: string = process.platform): string | undefined {
  if (platform !== "darwin") return undefined;
  if (!/kill|pgrep/.test(command)) return undefined;
  const p = killProblem(command);
  if (!p) return undefined;
  return [
    `Sova refused this bash command before it ran; nothing ran. \`${p.what}\`: ${p.why}.`,
    `Fix: ${p.fix}. For a project's services, use project_verbs down.`,
  ].join("\n");
}
