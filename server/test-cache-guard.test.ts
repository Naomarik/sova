// Guards for test-result reuse that read the project itself (unit tier, files only):
//  - every environment switch a test or the code it imports reads is either passed to tests (and so keyed),
//    or held back here on purpose; no credential is ever passed;
//  - a merge check and a chat's run of the same code give tests the same keyed settings, so a chat's pass can
//    stand at landing (sandboxed or not, for the unit tier);
//  - no test reads the checkout's own spec claims or manifest, which the fingerprint leaves out.
// The fingerprint's own guards: scripts/test-cache-guard.test.ts; the runner end to end:
// scripts/test-cache-guard.integration.test.ts; what landing writes: server/test-cache-guard.integration.test.ts.
import { describe, test } from "node:test";
import { readFileSync, globSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "./merge-queue/testing/expect";
import { parseDefinition } from "../shared/project-contract";
import { envOf } from "./merge-queue/checks";

const ROOT = resolve(import.meta.dirname, "..");
// Variable specifiers: plain-JS runner modules, typed here by what this file uses.
const testEnvPath = "../scripts/test-env.mjs";
const cachePath = "../scripts/test-cache.mjs";
const changedPath = "../scripts/test-changed.mjs";
const testEnvMod = (await import(testEnvPath)) as {
  passesToTests(name: string, tier: "unit" | "integration"): boolean;
  testEnv(source: Record<string, string | undefined>, tier: "unit" | "integration"): Record<string, string>;
  dropChatEnv(env: Record<string, string | undefined>): string[];
  matchesRecordsNothing(name: string): boolean;
  CREDENTIAL: RegExp;
};
const cacheMod = (await import(cachePath)) as {
  keyedEnv(env: Record<string, string>): Record<string, string>;
  systemdReachable(env: Record<string, string | undefined>): boolean;
  CREDENTIAL_ENV: RegExp;
};
const { resolveImport } = (await import(changedPath)) as { resolveImport(root: string, from: string, spec: string): string | null };

/** The runner's test files (its GLOBS, read from its source so this can't drift from it) and their relative-import closure. */
function testClosure(): { tests: string[]; files: string[] } {
  const src = readFileSync(join(ROOT, "scripts/run-tests.mjs"), "utf8");
  const at = src.indexOf("const GLOBS = [");
  const globs = [...src.slice(at, src.indexOf("];", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const tests = [...new Set(globs.flatMap((g) => (globSync(g, { cwd: ROOT }) as string[])))].sort();
  const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`](\.{1,2}\/[^"'`$]+)["'`]/g;
  const seen = new Set(tests);
  const todo = [...tests];
  while (todo.length) {
    const f = todo.pop()!;
    let text = "";
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const g = resolveImport(ROOT, f, m[1]!);
      if (g && !seen.has(g)) {
        seen.add(g);
        todo.push(g);
      }
    }
  }
  return { tests, files: [...seen].sort() };
}
const closure = testClosure();
const texts = new Map(closure.files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const));

describe("the settings tests see: one list, covering every switch they read", () => {
  /** Each `process.env.X` / `process.env["X"]` read (an assignment is not a read), with the files reading it. */
  const reads = new Map<string, Set<string>>();
  const READ = /process\.env(?:\.([A-Z_][A-Z0-9_]*)(?![\w$])|\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\])(?!\s*(?:=[^=]|\?\?=|\|\|=))/g;
  for (const [f, t] of texts) for (const m of t.matchAll(READ)) {
    const name = (m[1] ?? m[2])!;
    (reads.get(name) ?? reads.set(name, new Set()).get(name)!).add(f);
  }
  const all = [...texts.values()].join("\n");
  /** Whether any file of the closure gives `name` a value (a test sets its own), as a property or an assignment. */
  const setSomewhere = (name: string) => new RegExp(`(\\.${name}\\s*(?:=[^=]|\\?\\?=|\\|\\|=)|\\[\\s*["'\`]${name}["'\`]\\s*\\]\\s*=[^=]|\\b${name}\\s*:|["'\`]${name}["'\`]\\s*:|delete\\s+[\\w.]+\\.${name}\\b)`).test(all);

  /** Read by code a test runs, never set by a test, and held back from tests on purpose: each with why. A name
   *  here must not pass; a new one must be decided (TEST_SWITCHES in scripts/test-env.mjs, or here). */
  const HELD: Record<string, string> = {
    // Debug output only: a run with them set behaves the same.
    POOL_TEST_LOG: "debug log", SOVA_REPLAY_DEBUG: "debug log", SOVA_AUTOTITLE_TRACE: "debug log", SOVA_STALL_RECORDER: "debug log", SOVA_STALL_STACKS: "debug log", SOVA_INSPECT_BWRAP: "debug log",
    // Production knobs of the code under test: tests get the defaults (a shell's value must not reach them).
    SOVA_SCHEDULE_SPEED: "production knob", SOVA_SCHEDULE_TICK_MS: "production knob", SOVA_CHAT_TEST_ACT_DELAY_AT: "trial-only knob, set by the trial itself", SOVA_CHAT_TEST_ACT_DELAY_MS: "trial-only knob, set by the trial itself",
    SOVA_LINK_OFFER_TTL_MS: "production knob", SOVA_BATON_UPLOADS_FREE_MB: "production knob", SOVA_VOICE_DIR: "production knob", SOVA_VOICE_IMPORT_DIRS: "production knob", SOVA_VOICE_MODEL: "production knob", SOVA_VOICE_PATH: "production knob",
    GIT_ATTR_GLOBAL: "git's own, scrubbed", GIT_ATTR_SOURCE: "git's own, scrubbed", GIT_ATTR_SYSTEM: "git's own, scrubbed", GIT_CONFIG_PARAMETERS: "git's own, scrubbed", GIT_REPLACE_REF_BASE: "git's own, scrubbed", GIT_SHALLOW_FILE: "git's own, scrubbed",
    POSIXLY_CORRECT: "a shell setting, not a test switch", HTTP_PROXY: "the sandbox's proxy: never a test's", HTTPS_PROXY: "the sandbox's proxy: never a test's",
    // Given by the engine under test to the processes it starts, never by the runner.
    SOVA_PORT_ADMIN: "engine-provided", SOVA_PORT_HTTP: "engine-provided", SOVA_PORT_NREPL: "engine-provided", SOVA_PORT_REPL_NREPL: "engine-provided", SOVA_PORT_SVC_TCP: "engine-provided", SOVA_PORT_TCP: "engine-provided",
    // Standalone tools' own settings (scripts the tests import pieces of, never set by a run).
    ACCESS_TTL_S: "mesh-lab mock server", HTTP_PORT: "mesh-lab mock server", MOCK_HOST: "mesh-lab mock server", MOCK_TOKEN_URL: "mesh-lab mock server", TLS_CERT: "mesh-lab mock server", TLS_KEY: "mesh-lab mock server",
    SEARCH_AB_COPY: "bench tool", SEARCH_AB_PRIVATE: "bench tool", USAGE_HELPER_MAIN: "set by the helper's launcher",
  };

  test("every env name a test or the code it imports reads is passed to tests, set by the tests themselves, or held back here with a reason", () => {
    expect(reads.size > 50).toBe(true); // the scan sees the tree (a broken scan would pass everything)
    const undecided = [...reads]
      .filter(([n]) => !testEnvMod.passesToTests(n, "integration") && !setSomewhere(n) && !(n in HELD) && !testEnvMod.CREDENTIAL.test(n))
      .map(([n, fs]) => `${n} (read in ${[...fs].slice(0, 2).join(", ")})`);
    expect(undecided).toEqual([]);
  });

  test("a name held back here really is held back, and a reason is given", () => {
    for (const [n, why] of Object.entries(HELD)) {
      expect({ n, passes: testEnvMod.passesToTests(n, "integration") }).toEqual({ n, passes: false });
      expect(why.length > 3).toBe(true);
    }
  });

  test("the documented developer switches reach tests", () => {
    for (const n of ["SOVA_GOLDEN_MODE", "SOVA_GOLDEN_RECORD", "SOVA_GOLDEN_REAL_DIR", "SOVA_GOLDEN_SETS", "SOVA_LOADOUT_UPDATE", "SOVA_INVENTORY_OUT", "SOVA_TOUR_BROWSER", "SLOW", "WRITE_ROW_SNAPSHOT", "SOVA_MQ_UI_DIST", "CHAT_TRIAL_ROOT"])
      expect({ n, unit: testEnvMod.passesToTests(n, "unit"), int: testEnvMod.passesToTests(n, "integration") }).toEqual({ n, unit: true, int: true });
  });

  test("a switch pointing tests at files outside the fingerprint (a prebuilt dist, another tree) makes a run record nothing", () => {
    for (const n of [...reads.keys()].filter((k) => /^SOVA_[A-Z_]+_DIST$/.test(k) && !setSomewhere(k)).concat("CHAT_TRIAL_ROOT"))
      expect({ n, recordsNothing: testEnvMod.matchesRecordsNothing(n) }).toEqual({ n, recordsNothing: true });
  });

  test("no credential reaches a test or a key, whatever its name's shape", () => {
    const creds = [...reads.keys()].filter((n) => testEnvMod.CREDENTIAL.test(n) || cacheMod.CREDENTIAL_ENV.test(n));
    expect(creds.length > 3).toBe(true);
    for (const n of [...creds, "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "SOVA_PASSWORD", "DB_PASSWD", "BASIC_AUTH", "SSH_PRIVATE_KEY", "CLAUDE_SESSION_KEY", "MISE_GITHUB_TOKEN"]) {
      expect({ n, unit: testEnvMod.passesToTests(n, "unit"), int: testEnvMod.passesToTests(n, "integration") }).toEqual({ n, unit: false, int: false });
      expect({ n, keyed: n in cacheMod.keyedEnv({ [n]: "x" }) }).toEqual({ n, keyed: false });
    }
  });
});

describe("a merge check and a chat's run give tests the same keyed settings", () => {
  const def = parseDefinition(JSON.stringify({ version: 1, services: { web: { cmd: ["node", "w.js"], ports: { http: { base: 5100 } } } }, merge: { checks: [{ id: "unit", run: ["pnpm", "test"] }] } }));
  const scope = { project: "/p/sova", projectId: "sova", copy: "/p/.worktrees/sova-merge", slot: 9, data: "/s/d", target: "master", base: "b".repeat(40), tip: "t".repeat(40) };
  /** The server's own environment, as the user's service manager starts it. */
  const server = (o: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    PATH: "/home/u/.local/share/mise/shims:/usr/local/bin:/usr/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", LANG: "en_US.UTF-8", SHELL: "/usr/bin/zsh",
    XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", MISE_SHELL: "zsh", PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
    GH_TOKEN: "fake-01", ANTHROPIC_API_KEY: "fake-02", SSH_AUTH_SOCK: "/run/user/1000/ssh", TERM: "xterm-256color", INVOCATION_ID: "abc", JOURNAL_STREAM: "8:1",
    ...o,
  });
  /** A chat's shell (a worker's too): the server's environment plus the chat process's own, plus, sandboxed, the
   *  sandbox's differences. */
  const chat = (srv: Record<string, string | undefined>, sandboxed: boolean): Record<string, string | undefined> => {
    const e: Record<string, string | undefined> = { ...srv, SOVA_URL: "http://127.0.0.1:4800", SOVA_CALLER_KEY: "fake-03", SOVA_CHAT_ID: "c1", SOVA_CHAT_UNIT: "u1", PI_SESSION_ID: "s1", SOVA_SPEC_LANDED_FILE: "/x", PWD: "/p/.worktrees/sova-x", OLDPWD: "/p" };
    if (sandboxed) {
      Object.assign(e, { TMPDIR: "/tmp/pi-sandbox-1000/x/tmp", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", PATH: "/home/u/.pi/agent/bin:/home/u/.local/share/mise/installs/bun/1.4.2/bin:/usr/bin" });
      delete e.XDG_RUNTIME_DIR;
      delete e.DBUS_SESSION_BUS_ADDRESS;
      delete e.SSH_AUTH_SOCK;
    }
    return e;
  };
  /** What the runner keys for `tier` when started with `procEnv`: its chat variables dropped, the pinned test env. */
  const keyed = (procEnv: Record<string, string | undefined>, tier: "unit" | "integration") => {
    const e = { ...procEnv };
    testEnvMod.dropChatEnv(e);
    const t = testEnvMod.testEnv(e, tier);
    return { env: cacheMod.keyedEnv(t), ...(tier === "integration" ? { systemd: !!t.XDG_RUNTIME_DIR } : {}) };
  };
  /** The env a merge check's runner starts with when the server's environment is `srv`. */
  const queueEnv = (srv: Record<string, string | undefined>, fresh: boolean) => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, Object.fromEntries(Object.entries(srv).filter(([, v]) => v !== undefined)));
      return envOf(def, scope, { step: "unit", out: "/s/out.json", fresh });
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  for (const [label, srv] of [
    ["a server with the usual settings", server()],
    ["a server started with no LANG (a launchd agent, a bare unit)", server({ LANG: undefined })],
    ["a server with LC_ALL and TZ set", server({ LC_ALL: "C.UTF-8", TZ: "Europe/Berlin" })],
  ] as const) {
    test(`${label}: unit tier, the queue's check == a chat's run == a sandboxed worker's run`, () => {
      const q = keyed(queueEnv(srv, false), "unit");
      expect(keyed(queueEnv(srv, true), "unit")).toEqual(q); // fresh or sampled: the same key
      expect(keyed(chat(srv, false), "unit")).toEqual(q);
      expect(keyed(chat(srv, true), "unit")).toEqual(q);
    });
    test(`${label}: integration tier, the queue's check == an unsandboxed chat's run`, () => {
      expect(keyed(chat(srv, false), "integration")).toEqual(keyed(queueEnv(srv, false), "integration"));
    });
  }

  test("nothing the queue adds for its own bookkeeping, and no chat variable, is keyed", () => {
    const q = keyed(queueEnv(server(), false), "integration").env;
    expect(Object.keys(q).filter((k) => /^(SOVA_(OUT|STEP|MERGE_|VERB|V|PROJECT|INSTANCE|SLOT|CHECKOUT|MAIN|BRANCH|DATA|LEAK_NAMES|PORT_|TEST_SELECT|FRESH|REUSE_SAMPLE|URL|CALLER_KEY|CHAT_)|PI_SESSION)/.test(k))).toEqual([]);
  });
});

describe("no test reads the checkout's own spec claims or manifest (they are outside the fingerprint)", () => {
  /** Names a file binds, at its top level, to this checkout's root (import.meta.dirname / __dirname / import.meta.url / process.cwd() based). */
  const rootNames = (t: string) =>
    new Set([...t.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:import\.meta\.(?:dirname|url|filename)|__dirname|process\.cwd\(\))[^;\n]*/gm)].map((m) => m[1]!).concat(["REPO_ROOT"]));
  const SPEC = /\.sova[/"'`,\s]+spec\b|["'`]spec["'`]\s*,\s*["'`](claims|manifest\.json)/;

  test("the tripwire sees the shape it looks for (a scan that matches nothing proves nothing)", () => {
    const sample = `const ROOT = resolve(import.meta.dirname, "..");\nconst text = readFileSync(join(ROOT, ".sova", "spec", "claims", "app", "x.md"));\n`;
    const names = rootNames(sample);
    expect(names.has("ROOT")).toBe(true);
    expect(sample.split("\n").some((l) => SPEC.test(l) && [...names].some((n) => new RegExp(`\\b${n}\\b`).test(l)))).toBe(true);
  });

  test("no runner-globbed test or file it imports builds a path into this checkout's .sova/spec from its own root", () => {
    const hits: string[] = [];
    for (const [f, t] of texts) {
      if (f === "server/test-cache-guard.test.ts") continue; // its own sample above
      const names = rootNames(t);
      t.split("\n").forEach((line, i) => {
        if (!SPEC.test(line)) return;
        const direct = /import\.meta\.(dirname|url)|__dirname|process\.cwd\(\)/.test(line);
        if (direct || [...names].some((n: string) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(line))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    // A test that must read the real claims: take its path off SPEC_EXCLUDED (scripts/test-cache.mjs) and list it here.
    expect(hits).toEqual([]);
  });
});
