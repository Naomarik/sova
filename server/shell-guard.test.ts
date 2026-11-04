// The macOS kill guard (§chat/kill-guard): the table of commands it refuses and lets run, the broad
// names, the reply's wording, and Linux untouched. Pure: nothing here runs a command.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BROAD_NAMES, broadName, killGuardRefusal, killProblem, lex } from "./shell-guard";
import { shellGuardExtension } from "./shell-guard-extension";

const refused = (cmd: string) => killGuardRefusal(cmd, "darwin");

/** [command, why it's refused: a fragment of the reason]. */
const REFUSE: [string, RegExp][] = [
  // The two incidents, word for word.
  [`pkill -f "bun --watch src/server/main.ts" -P 1`, /after the first pattern/],
  [`pgrep -f sova-guard-marker-1234 -P 1`, /after the first pattern/],
  // Options after the pattern, every shape.
  [`pkill -f 'vite --port 5317' -9`, /after the first pattern/],
  [`pkill node-server -u omar`, /after the first pattern/],
  [`pkill -f marker-xyz -- -P`, /after the first pattern/],
  [`killall my-long-app-name -9`, /takes its options before the name/],
  [`pgrep -f long-marker-name -P 1 | xargs kill`, /after the first pattern/],
  // Kill everything.
  [`kill -1`, /-1/],
  [`kill -9 -1`, /-1/],
  [`kill -s KILL -1`, /-1/],
  [`kill -- -1`, /-1/],
  [`/bin/kill -TERM -1`, /-1/],
  [`pkill -f x`, /one or two characters/],
  [`pkill -f ab`, /one or two characters/],
  [`pkill -f ''`, /empty/],
  [`pkill -f '.*'`, /empty/],
  [`killall -m .`, /one or two characters/],
  [`pkill -u omar`, /no pattern/],
  [`pkill -9 -P 1`, /no pattern/],
  [`killall -u omar`, /-u or -t and no name/],
  [`pkill -v -f some-long-marker`, /-v inverts/],
  // Broad names.
  [`pkill node`, /name this broad/],
  [`pkill -9 -f node`, /name this broad/],
  [`pkill -f "node.*"`, /name this broad/],
  [`pkill -f '^node$'`, /name this broad/],
  [`pkill -f '[n]ode'`, /name this broad/],
  [`pkill -f /usr/local/bin/node`, /name this broad/],
  [`pkill -x python3.12`, /name this broad/],
  [`pkill -i Chrome`, /name this broad/],
  [`pkill -f "Google Chrome"`, /name this broad/],
  [`killall "Google Chrome"`, /name this broad/],
  [`killall -9 Slack`, /name this broad/],
  [`killall -c bun`, /name this broad/],
  [`killall Finder`, /name this broad/],
  [`pgrep -lf node | xargs kill`, /name this broad/],
  [`pgrep -f node | xargs -n1 kill -9`, /name this broad/],
  // The live runbook's safe probe: signal 0 is refused like any kill, and is harmless if the guard is missing.
  [`pgrep -f node | xargs kill -0`, /name this broad/],
  [`kill $(pgrep vite)`, /name this broad/],
  [`kill -9 \`pgrep -f deno\``, /name this broad/],
  [`for p in $(pgrep bun); do kill $p; done`, /name this broad/],
  [`pgrep bun | while read p; do kill "$p"; done`, /name this broad/],
  [`P=$(pgrep chrome); kill $P`, /name this broad/],
  [`pkill claude`, /name this broad/],
  [`pkill -f 'node|bun'`, /name this broad/],
  [`pkill -f '(node|vite --port 5317)'`, /name this broad/],
  [`pkill -f 'a|some-long-marker'`, /one or two characters/],
  [`ps aux | grep -E 'node|bun' | awk '{print $2}' | xargs kill`, /picks the PIDs to kill by a name this broad/],
  [`builtin kill -9 -1`, /-1/],
  [`ps aux | grep node | grep -v grep | awk '{print $2}' | xargs kill -9`, /picks the PIDs to kill by a name this broad/],
  [`kill $(ps -ax | grep -i chrome | awk '{print $1}')`, /picks the PIDs to kill by a name this broad/],
  // A pattern Sova can't see, or a command it can't read.
  [`pkill -f "$PATTERN"`, /variable or a command/],
  [`pkill -f "$(cat name)"`, /variable or a command/],
  [`pkill -f "unclosed`, /couldn't read/],
  // Wrappers, compound lines and nesting.
  [`sudo pkill node`, /name this broad/],
  [`sudo -u root pkill -f ab`, /one or two characters/],
  [`env FOO=1 pkill -f "bun --watch x" -P 1`, /after the first pattern/],
  [`FOO=1 BAR=2 pkill node`, /name this broad/],
  [`nice -n 10 pkill node`, /name this broad/],
  [`nohup pkill node &`, /name this broad/],
  [`timeout 5 pkill node`, /name this broad/],
  [`time pkill node`, /name this broad/],
  [`command pkill node`, /name this broad/],
  [`exec pkill node`, /name this broad/],
  [`\\pkill node`, /name this broad/],
  [`/usr/bin/pkill node`, /name this broad/],
  [`cd /tmp && pkill node`, /name this broad/],
  [`true || pkill node`, /name this broad/],
  [`echo hi; pkill node`, /name this broad/],
  [`ls\npkill node`, /name this broad/],
  [`(pkill node)`, /name this broad/],
  [`{ pkill node; }`, /name this broad/],
  [`if pgrep -q bun; then pkill bun; fi`, /name this broad/],
  [`echo $(pkill node)`, /name this broad/],
  [`sh -c 'pkill node'`, /name this broad/],
  [`bash -lc "pkill -f 'bun --watch x' -P 1"`, /after the first pattern/],
  [`zsh -c "kill -9 -1"`, /-1/],
  [`eval "pkill node"`, /name this broad/],
  [`pkill node 2>/dev/null`, /name this broad/],
  [`pkill node >/dev/null 2>&1 || true`, /name this broad/],
  [`xargs kill -1 < pids`, /-1/],
];

/** Commands that must run untouched on macOS. */
const ALLOW: string[] = [
  `pkill -f 'bun --watch src/server/main.ts'`,
  `pkill -P 1 -f 'bun --watch src/server/main.ts'`,
  `pkill -9 -f 'vite --port 5317'`,
  `pkill -f sova-guard-marker-1234`,
  `pgrep -f sova-guard-marker-1234`,
  `pgrep -lf node`,
  `pgrep node`,
  `pgrep -f 'bun --watch src/server/main.ts' | xargs kill`,
  `kill 1234`,
  `kill -9 1234 5678`,
  `kill -HUP 1234`,
  `kill -TERM -- -4321`,
  `kill $(cat app.pid)`,
  `lsof -ti :5173 | xargs kill`,
  `kill -l`,
  `killall sova-guard-marker-app`,
  `pkill -F /tmp/app.pid`,
  `pkill -f chrome-devtools-mcp`,
  `pkill -f "node server.js"`,
  `pkill -f "$HOME/projects/app/server.js"`,
  `echo "pkill node -P 1"`,
  `git commit -m "kill -1 and pkill node are refused now"`,
  `grep -rn "pkill" server/`,
  `man pkill`,
  `command -v pkill`,
  `ls -la # pkill node`,
  `cat <<EOF > notes.md\npkill -f x -P 1\nkill -9 -1\nEOF\necho done`,
  `cat <<'EOF'\npkill node\nEOF`,
  `git commit -m "$(cat <<'EOF'\nDon't kill -1 here, and pkill node is refused\nEOF\n)"`,
  `git commit -F - <<'EOF'\nit's about kill -9 -1\nEOF`,
  `pkill -f 'vite --port 5317|bun --watch src/server/main.ts'`,
  `pkill -f 'app-(blue|green)-server'`,
  `echo hi > kill.log`,
  `node server.js`,
  `npm run dev`,
  `ps aux | grep node`,
  `ps aux | grep 'bun --watch src/server/main.ts' | grep -v grep | awk '{print $2}' | xargs kill`,
  `grep -q x file && kill 1234`,
  `sleep 1 && echo ok`,
];

describe("the guard refuses (macOS)", () => {
  for (const [cmd, why] of REFUSE)
    test(JSON.stringify(cmd), () => {
      const r = refused(cmd);
      assert.ok(r, `expected a refusal for ${cmd}`);
      assert.match(r, why);
    });
});

describe("the guard allows (macOS)", () => {
  for (const cmd of ALLOW) test(JSON.stringify(cmd), () => assert.equal(refused(cmd), undefined, killProblem(cmd)?.why));
});

describe("Linux and other platforms: the check never runs", () => {
  for (const platform of ["linux", "freebsd", "win32"])
    test(platform, () => {
      for (const [cmd] of REFUSE) assert.equal(killGuardRefusal(cmd, platform), undefined, `${platform}: ${cmd}`);
    });
});

describe("the reply", () => {
  test("says nothing ran, the command at fault, why and the fix", () => {
    const r = refused(`pkill -f "bun --watch src/server/main.ts" -P 1`)!;
    assert.match(r, /^Sova refused this bash command before it ran; nothing ran\./);
    assert.match(r, /`pkill -f 'bun --watch src\/server\/main\.ts' -P 1`/);
    assert.match(r, /on macOS, pkill reads every argument after the first pattern as another pattern/);
    assert.match(r, /put every option before the pattern/);
    assert.match(r, /project_verbs down/);
  });
  test("killall's reply says its manual shows options first, not what happens to a later one, and fixes it with killall's own form", () => {
    const r = refused(`killall my-long-app-name -9`)!;
    assert.match(r, /killall takes its options before the name, and what it does with one after the name isn't documented, so Sova refuses it/);
    assert.match(r, /put every option before the name \(`killall -9 name`\)/);
    assert.doesNotMatch(r, /reads every argument/, "unproven for killall, so never stated as fact");
    assert.doesNotMatch(r, /-P 1|-f 'pattern'/, "pkill's options are no fix for killall");
  });
  test("pkill and pgrep keep their wording, with their own command in the fix", () => {
    assert.match(refused(`pkill -f marker-long-name -9`)!, /on macOS, pkill reads every argument after the first pattern/);
    assert.match(refused(`pkill -f marker-long-name -9`)!, /`pkill -P 1 -f 'pattern'`/);
    assert.match(refused(`pgrep -f marker-long-name -P 1`)!, /on macOS, pgrep reads every argument after the first pattern/);
    assert.match(refused(`pgrep -f marker-long-name -P 1`)!, /`pgrep -P 1 -f 'pattern'`/);
  });
  test("every form a reply recommends is itself allowed: a fix that gets refused is no fix", () => {
    const sample = [`killall my-long-app-name -9`, `pkill -f marker-long-name -9`, `pgrep -f marker-long-name -P 1`, `pkill node`, `kill -9 -1`, `pkill -f "unclosed`, `pkill -f "$P"`, `pkill -v -f marker-long-name`];
    const recommended = new Set<string>();
    for (const cmd of sample) {
      const r = refused(cmd);
      assert.ok(r, cmd);
      // Every backticked command on the reply's Fix line; PORT stands in for a real port.
      for (const m of r.split("\nFix:")[1]!.matchAll(/`([^`]+)`/g)) recommended.add(m[1]!.replace("PORT", "5173"));
    }
    for (const form of [`killall -9 name`, `lsof -ti :5173 | xargs kill`]) assert.ok(recommended.has(form), `a reply recommends ${form}`);
    assert.ok(recommended.size >= 5, [...recommended].join(" ; "));
    for (const form of recommended) assert.equal(refused(form), undefined, `recommended but refused: ${form}`);
  });
  test("a broad name says to match something specific or kill by PID", () => {
    const r = refused(`pgrep -lf node | xargs kill`)!;
    assert.match(r, /`node` is a name this broad/);
    assert.match(r, /a script path, a port, a unique marker/);
    assert.match(r, /lsof -ti :PORT \| xargs kill/);
  });
});

describe("the broad-name table", () => {
  test("is lower-case-unique and holds the names the decision named", () => {
    const lower = BROAD_NAMES.map((n) => n.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, "no duplicates");
    for (const n of ["node", "bun", "chrome", "google chrome", "python", "python3", "ruby", "java", "deno", "npm", "pnpm", "vite", "sh", "bash", "zsh", "docker", "code", "slack", "safari", "finder"])
      assert.ok(lower.includes(n), n);
  });
  test("every entry is refused by pkill, killall and pgrep-feeding-kill", () => {
    for (const n of BROAD_NAMES) {
      assert.ok(refused(`pkill -f '${n}'`), `pkill ${n}`);
      assert.ok(refused(`killall '${n}'`), `killall ${n}`);
      assert.ok(refused(`pgrep -f '${n}' | xargs kill`), `pgrep|kill ${n}`);
    }
  });
  test("normalises regex trivia, case, a directory and a version", () => {
    assert.equal(broadName("^Node$"), "node");
    assert.equal(broadName("[c]hrome"), "chrome");
    assert.equal(broadName(".*python3.11.*"), "python");
    assert.equal(broadName("python3"), "python3");
    assert.equal(broadName("/opt/homebrew/bin/bun"), "bun");
    assert.equal(broadName("ruby3"), "ruby");
  });
  test("anything more specific is not broad", () => {
    for (const p of ["bun --watch src/server/main.ts", "node server.js", "vite --port 5317", "chrome-devtools-mcp", "sova-guard-marker-1", "Google Chrome Canary --user-data-dir=/tmp/x"])
      assert.equal(broadName(p), undefined, p);
  });
});

describe("the reader", () => {
  test("splits compound lines and reads substitutions", () => {
    const l = lex(`a 1 && b "x y" | c; d $(e f) \`g\``);
    assert.deepEqual(l.commands.map((c) => c.map((w) => w.text)), [["a", "1"], ["b", "x y"], ["c"], ["d", "$(e f)", "`g`"]]);
    assert.deepEqual(l.inner, ["e f", "g"]);
    assert.ok(l.ok);
  });
  test("drops redirections and their targets, and skips heredoc bodies", () => {
    const l = lex(`cmd a 2>/dev/null >out <in 2>&1\ncat <<X\nbody\nX\nnext`);
    assert.deepEqual(l.commands.map((c) => c.map((w) => w.text)), [["cmd", "a"], ["cat"], ["next"]]);
  });
  test("an unclosed quote is not ok", () => assert.equal(lex(`echo "abc`).ok, false));
});

describe("the extension", () => {
  type Handler = (event: { toolName: string; input: unknown }) => unknown;
  const load = (platform: string) => {
    const handlers = new Map<string, Handler>();
    shellGuardExtension(platform)({ on: (name: string, h: Handler) => void handlers.set(name, h) } as never);
    return handlers;
  };
  test("macOS: blocks a refused bash call with the reply, lets others and other tools through", () => {
    const h = load("darwin").get("tool_call")!;
    const out = h({ toolName: "bash", input: { command: "pkill -f marker-long-name -P 1" } }) as { block: boolean; reason: string };
    assert.equal(out.block, true);
    assert.match(out.reason, /nothing ran/);
    assert.equal(h({ toolName: "bash", input: { command: "pkill -P 1 -f marker-long-name" } }), undefined);
    assert.equal(h({ toolName: "write", input: { path: "x", content: "pkill node" } }), undefined);
    assert.equal(h({ toolName: "bash", input: {} }), undefined);
  });
  test("Linux: registers no hook at all", () => {
    assert.equal(load("linux").size, 0);
  });
});
