// Store adapters against scratch dirs only, in-process: a throwaway pi auth.json and a throwaway Claude
// config dir driven by the store-shape simulator (the mock token server's handler called directly). The
// real ~/.pi and ~/.claude are never read or written. Another process tearing the file, and the
// simulator over HTTP: logins-stores.integration.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLAUDE_OAUTH_KEY,
  ClaudeCredentialStore,
  LockBusyError,
  PiAuthStore,
  canonicalJson,
  classifyPiEntry,
  fingerprint,
  type StoreSnapshot,
} from "./logins-stores";

const root = mkdtempSync(join(tmpdir(), "sova-cred-stores-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const scratch = () => {
  const d = join(root, `d${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const lockfile = createRequire(piEntry)("proper-lockfile") as {
  lock(file: string, o: object): Promise<() => Promise<void>>;
};
// pi's own store class (not exported by the package; loaded by path, in tests only).
const { AuthStorage } = (await import(pathToFileURL(join(piEntry, "..", "core", "auth-storage.js")).href)) as {
  AuthStorage: {
    create(path: string): {
      read(p: string): Promise<unknown>;
      modify(p: string, fn: (cur: unknown) => Promise<unknown>): Promise<unknown>;
      delete(p: string): Promise<void>;
    };
  };
};

// Count the lock attempts proper-lockfile refused (the very module the stores use: pi's own), so a
// test sees a write held off by a lock by its refusals, never by how long it waited.
let lockRefusals = 0;
const lockOf = lockfile.lock.bind(lockfile);
lockfile.lock = async (file, o) => {
  try {
    return await lockOf(file, o);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOCKED") lockRefusals++;
    throw error;
  }
};
/** Poll with a generous hang guard: never a bound on how fast a lock is tried. */
async function until(what: string, ok: () => boolean): Promise<void> {
  const end = Date.now() + 15_000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const LATER = Date.now() + 3_600_000; // fixed, so two calls build equal entries
const oauthEntry = (tag: string, expires = LATER) => ({
  type: "oauth",
  access: `at-${tag}`,
  refresh: `rt-${tag}`,
  expires,
  accountId: "acct-1",
});
const keyEntry = (key: string) => ({ type: "api_key", key });
const noTemps = (dir: string) => readdirSync(dir).filter((f) => f.includes(".sova-sync.") || f.endsWith(".tmp"));
const snapOf = (store: PiAuthStore | ClaudeCredentialStore) => store.transact((snap) => ({ result: snap }));

test("canonical JSON and fingerprints ignore key order and never contain the secret", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  const a = fingerprint({ type: "api_key", key: "sk-secret-value" });
  assert.equal(a, fingerprint({ key: "sk-secret-value", type: "api_key" }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!a.includes("secret"));
});

test("pi entries: oauth and literal api keys travel; command, $VAR and env keys are device config", () => {
  assert.equal(classifyPiEntry(oauthEntry("x"))?.kind, "oauth");
  assert.equal(classifyPiEntry(oauthEntry("x"))?.dead, false);
  assert.equal(classifyPiEntry({ ...oauthEntry("x"), access: "" })?.dead, true);
  assert.equal(classifyPiEntry(keyEntry("sk-literal"))?.kind, "api_key");
  for (const local of [
    keyEntry("!pass show zai"),
    keyEntry("$ZAI_KEY"),
    keyEntry("pre${X}post"),
    { type: "api_key", key: "lit", env: { A: "b" } },
    { type: "api_key" },
    { type: "oauth", access: "a", refresh: "r" },
    { type: "oauth", access: "a", refresh: "r", expires: Number.NaN },
    { type: "session-cookie", v: 1 },
  ]) {
    assert.equal(classifyPiEntry(local as Record<string, unknown>), undefined, JSON.stringify(local));
  }
  // Two hosts' copies of one entry share a fingerprint; the account is digested, never copied.
  const e = classifyPiEntry(oauthEntry("x"))!;
  assert.equal(e.fingerprint, classifyPiEntry({ ...oauthEntry("x") })!.fingerprint);
  assert.ok(e.account && !e.account.includes("acct-1"));
});

test("pi: a write changes only the named entries, keeps pi's format and the rest, 0600, no temp left", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  const original = { "openai-codex": oauthEntry("one"), zai: keyEntry("sk-zai"), mine: keyEntry("!cmd"), weird: { type: "x" } };
  writeFileSync(path, JSON.stringify(original, null, 2), { mode: 0o644 });
  const store = new PiAuthStore(path);
  const snap = await snapOf(store);
  assert.equal(snap.state, "ok");
  assert.deepEqual([...snap.entries.keys()].sort(), ["openai-codex", "zai"]);
  assert.deepEqual([...snap.localOnly].sort(), ["mine", "weird"]);

  await store.transact(() => ({
    result: undefined,
    changes: new Map<string, Record<string, unknown> | null>([
      ["zai", keyEntry("sk-zai-2")],
      ["deepseek", keyEntry("sk-ds")],
      ["mine", keyEntry("overwrite-attempt")], // local-only: never touched
      ["openai-codex", null],
    ]),
  }));
  const text = readFileSync(path, "utf8");
  assert.equal(text, JSON.stringify({ zai: keyEntry("sk-zai-2"), mine: keyEntry("!cmd"), weird: { type: "x" }, deepseek: keyEntry("sk-ds") }, null, 2));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(noTemps(dir), []);
  assert.equal(existsSync(`${path}.lock`), false, "the lock is released");
});

test("pi: a file that isn't valid JSON is never written, whatever is asked", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  writeFileSync(path, '{"zai": {"type": "api_key", "key": "sk-');
  const store = new PiAuthStore(path);
  const snap = await store.transact((s) => ({ result: s, changes: new Map([["zai", keyEntry("sk-new")]]) }));
  assert.equal(snap.state, "invalid");
  assert.equal(readFileSync(path, "utf8"), '{"zai": {"type": "api_key", "key": "sk-');
});

test("pi: a missing file is created at 0600 by the first write; a missing file reads as empty", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  const store = new PiAuthStore(path);
  const snap = await snapOf(store);
  assert.equal(snap.state, "missing");
  await store.transact(() => ({ result: 0, changes: new Map([["zai", keyEntry("sk")]]) }));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { zai: keyEntry("sk") });
});

test("pi: our write waits for pi's auth.json.lock, then gives up only after its deadline", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  writeFileSync(path, "{}");
  const release = await lockfile.lock(path, { realpath: false, stale: 30_000 });
  let done = false;
  const refusedBefore = lockRefusals;
  const pending = new PiAuthStore(path).transact(() => ({ result: undefined, changes: new Map([["zai", keyEntry("sk")]]) })).then(() => {
    done = true;
  });
  await until("the store to be refused the lock twice", () => lockRefusals >= refusedBefore + 2);
  assert.equal(done, false, "held off by pi's lock");
  assert.equal(readFileSync(path, "utf8"), "{}");
  await release();
  await pending;
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { zai: keyEntry("sk") });

  const again = await lockfile.lock(path, { realpath: false, stale: 30_000 });
  await assert.rejects(new PiAuthStore(path, { lockDeadlineMs: 200 }).transact(() => ({ result: 0 })), LockBusyError);
  await again();
});

test("H5: pi's own modify of one provider and our write of another, racing, both survive", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "openai-codex": oauthEntry("one"), zai: keyEntry("sk-old") }, null, 2), { mode: 0o600 });
  const pi = AuthStorage.create(path);
  // pi holds its lock across a slow "refresh" of openai-codex (as resolveStoredOAuth does): here it
  // lasts until our write has been refused the lock, so the two really overlap.
  let piInside = false;
  let finishRefresh!: () => void;
  const refreshDone = new Promise<void>((r) => (finishRefresh = r));
  const piModify = pi.modify("openai-codex", async () => {
    piInside = true;
    await refreshDone;
    return oauthEntry("two");
  });
  await until("pi inside its lock", () => piInside);
  const refusedBefore = lockRefusals;
  const ours = new PiAuthStore(path).transact(() => ({ result: undefined, changes: new Map([["zai", keyEntry("sk-new")]]) }));
  await until("our write refused pi's lock", () => lockRefusals > refusedBefore);
  finishRefresh();
  await Promise.all([piModify, ours]);
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(onDisk["openai-codex"], oauthEntry("two"), "pi's refresh kept");
  assert.deepEqual(onDisk.zai, keyEntry("sk-new"), "our pushed entry kept");
});

test("pi observes our rename-based write at its next read (no restart)", async () => {
  const dir = scratch();
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ zai: keyEntry("sk-1") }, null, 2), { mode: 0o600 });
  const pi = AuthStorage.create(path);
  assert.deepEqual(await pi.read("zai"), keyEntry("sk-1"));
  await new PiAuthStore(path).transact(() => ({ result: 0, changes: new Map([["zai", keyEntry("sk-2")]]) }));
  assert.deepEqual(await pi.read("zai"), keyEntry("sk-2"));
});

// ---------------------------------------------------------------- Claude Code

const claudeSim = await import("../../scripts/mesh-lab/mock-token-server/claude-sim.mjs");
const { createMockTokenState, createHandler } = await import("../../scripts/mesh-lab/mock-token-server/server.mjs");

const claudeEntry = (tag: string, expiresAt = LATER) => ({
  accessToken: `at-${tag}`,
  refreshToken: `rt-${tag}`,
  expiresAt,
  refreshTokenExpiresAt: LATER + 30 * 86_400_000,
  scopes: ["user:inference"],
  subscriptionType: "max",
});

test("claude: only claudeAiOauth travels; other keys (MCP tokens) are kept as they are", async () => {
  const dir = scratch();
  const path = join(dir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ [CLAUDE_OAUTH_KEY]: claudeEntry("one"), mcpOAuth: { srv: { token: "t" } } }), { mode: 0o600 });
  const store = new ClaudeCredentialStore(dir);
  const snap = await snapOf(store);
  assert.deepEqual([...snap.entries.keys()], [CLAUDE_OAUTH_KEY]);
  assert.deepEqual([...snap.localOnly], ["mcpOAuth"]);
  await store.transact(() => ({
    result: 0,
    changes: new Map([
      [CLAUDE_OAUTH_KEY, claudeEntry("two")],
      ["mcpOAuth", null],
    ]),
  }));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { [CLAUDE_OAUTH_KEY]: claudeEntry("two"), mcpOAuth: { srv: { token: "t" } } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(path).isSymbolicLink(), false);
});

test("claude: the cleared entry is a dead marker; removing the last entry deletes the file (Claude's logout)", async () => {
  const dir = scratch();
  const path = join(dir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ [CLAUDE_OAUTH_KEY]: { ...claudeEntry("x"), accessToken: "", refreshToken: "", expiresAt: 0 } }));
  const store = new ClaudeCredentialStore(dir);
  assert.equal((await snapOf(store)).entries.get(CLAUDE_OAUTH_KEY)?.dead, true);
  await store.transact(() => ({ result: 0, changes: new Map([[CLAUDE_OAUTH_KEY, null]]) }));
  assert.equal(existsSync(path), false);
});

test("claude: a symlinked store is refused and never written; a missing config dir is refused, not created", async () => {
  const dir = scratch();
  const target = join(scratch(), "elsewhere.json");
  writeFileSync(target, JSON.stringify({ [CLAUDE_OAUTH_KEY]: claudeEntry("x") }));
  symlinkSync(target, join(dir, ".credentials.json"));
  const store = new ClaudeCredentialStore(dir);
  const snap = await store.transact((s) => ({ result: s, changes: new Map([[CLAUDE_OAUTH_KEY, claudeEntry("y")]]) }));
  assert.equal(snap.state, "refused");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { [CLAUDE_OAUTH_KEY]: claudeEntry("x") });

  const absent = join(root, "no-such-claude-dir");
  const s2 = await new ClaudeCredentialStore(absent).transact((s) => ({ result: s, changes: new Map([[CLAUDE_OAUTH_KEY, claudeEntry("y")]]) }));
  assert.equal(s2.state, "refused");
  assert.equal(existsSync(absent), false);
});

test("claude: our write waits for EITHER of Claude Code's two refresh locks", async () => {
  const dir = scratch();
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ [CLAUDE_OAUTH_KEY]: claudeEntry("one") }));
  const holders = [
    () => lockfile.lock(dir, { realpath: false, stale: 60_000, lockfilePath: join(dir, ".oauth_refresh.lock") }),
    () => lockfile.lock(dir, { realpath: false, stale: 60_000, lockfilePath: `${dir}.lock` }),
  ];
  for (const hold of holders) {
    const release = await hold();
    await assert.rejects(
      new ClaudeCredentialStore(dir, { lockDeadlineMs: 250 }).transact(() => ({ result: 0, changes: new Map([[CLAUDE_OAUTH_KEY, claudeEntry("two")]]) })),
      LockBusyError,
    );
    await release();
  }
  assert.equal(JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"))[CLAUDE_OAUTH_KEY].accessToken, "at-one");
  assert.equal(existsSync(join(dir, ".oauth_refresh.lock")), false);
  assert.equal(existsSync(`${dir}.lock`), false);
});

test("claude simulator: refresh rotates, a reused refresh token clears the store only if unchanged", async () => {
  // The mock's own handler, called in-process through the simulator's fetch (over HTTP:
  // logins-stores.integration.test.ts).
  const state = createMockTokenState({ accessTtlS: 90 });
  const handle = createHandler(state) as (req: unknown, res: { writeHead(s: number, h: Record<string, string>): void; end(text: string): void }) => Promise<void>;
  const url = "http://mock-token.test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (!req.url.startsWith(`${url}/`)) return realFetch(input, init);
    const at = new URL(req.url);
    const body = Buffer.from(await req.arrayBuffer());
    const incoming = Object.assign(Readable.from(body.length ? [body] : []), { method: req.method, url: `${at.pathname}${at.search}`, headers: Object.fromEntries(req.headers), socket: { remoteAddress: "127.0.0.1" } });
    return await new Promise<Response>((resolve) => {
      let status = 200;
      let headers: Record<string, string> = {};
      void handle(incoming, { writeHead: (s, h) => ((status = s), (headers = h)), end: (text) => resolve(new Response(text, { status, headers })) });
    });
  }) as typeof fetch;
  const server = { close: () => void (globalThis.fetch = realFetch) };
  try {
    const a = scratch();
    const b = scratch();
    const { lineage } = await claudeSim.login(a, url);
    // Host B holds a copy of the same lineage (as after a sync).
    writeFileSync(join(b, ".credentials.json"), readFileSync(join(a, ".credentials.json")));
    assert.equal(await claudeSim.refresh(a, url), "ok", "90s token is inside the 5-min window");
    assert.equal(await claudeSim.refresh(b, url), "invalid_grant", "B's refresh token was consumed by A");
    const onB = JSON.parse(readFileSync(join(b, ".credentials.json"), "utf8"))[CLAUDE_OAUTH_KEY];
    assert.deepEqual([onB.accessToken, onB.refreshToken, onB.expiresAt], ["", "", 0]);
    assert.equal((await snapOf(new ClaudeCredentialStore(b))).entries.get(CLAUDE_OAUTH_KEY)?.dead, true);
    const sum = state.summary()[lineage]!;
    assert.deepEqual([sum.refreshes, sum.invalidGrants], [1, 1]);
    // Logout revokes the lineage and deletes the file.
    await claudeSim.logout(a, url);
    assert.equal(existsSync(join(a, ".credentials.json")), false);
    assert.equal(state.summary()[lineage]!.revoked, true);
    // The simulator refuses the real ~/.claude outright.
    await assert.rejects(claudeSim.refresh(join(process.env.HOME ?? "/nonexistent", ".claude"), url), /real ~\/\.claude/);
  } finally {
    server.close();
  }
});
