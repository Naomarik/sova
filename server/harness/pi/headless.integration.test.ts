// Run: pnpm test:int -- server/harness/pi/headless.integration.test.ts. A chat process without pi's terminal
// drawing code (§app.chat-processes/no-terminal-drawing, quirk P27): a real `bun server/chat-runtime/main.ts`
// with every one of Sova's extensions, a turn on a stub model that runs a bash tool, and the stand-in log
// (SOVA_STANDIN_LOG) printed whole: every drawing module it replaced and every call that reached a
// stand-in. And, in a Bun process of its own with the stand-ins installed, pi-tui still exports every name
// the real one does, its text helpers and pi's theme answer as the real ones do.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_RUNTIME_SETTINGS } from "../../../shared/chat-runtime-wire";
import { awaitFrame, connectLink } from "../../chat-runtime/link";
import { startStreamStub, stubModelsJson } from "../../stream-stub";
import { scratchRoot } from "../../test-scratch";
import { EXTENSION_DEPS, packageFrom } from "./own-code";

const REPO = resolve(import.meta.dirname, "../../..");
const t = scratchRoot("headless-int-");
const kids: ChildProcess[] = [];
after(() => {
  kids.forEach((k) => k.kill("SIGKILL"));
  rmSync(t, { recursive: true, force: true });
});
// Only the stub may answer.
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

/** Every proxy-aware client goes to a closed port; only the stub on 127.0.0.1 answers. */
const closed = "http://127.0.0.1:9";
const NO_NETWORK = { HTTPS_PROXY: closed, HTTP_PROXY: closed, https_proxy: closed, http_proxy: closed, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };

const piDir = packageFrom(join(REPO, "server"), EXTENSION_DEPS[0])!;
const tuiDir = packageFrom(piDir, "@earendil-works/pi-tui")!;

/** Sova's extension entries, as the agent dir links them. */
const entries = (dir: string) =>
  readdirSync(dir)
    .sort()
    .filter((n) => (statSync(join(dir, n)).isDirectory() ? existsSync(join(dir, n, "index.ts")) : n.endsWith(".ts") && !n.endsWith(".test.ts")));

test("a chat process with every extension runs a turn with the drawing code replaced, and logs each stand-in call", { timeout: 120_000 }, async () => {
  const stub = await startStreamStub({ payload: "letters", perDelta: 100, tool: "bash", args: JSON.stringify({ command: "echo standin-probe" }) });
  after(() => stub.close());
  const agentDir = join(t, "agent");
  const cwd = join(t, "cwd");
  const sessions = join(agentDir, "sessions", "--cwd--");
  for (const d of [sessions, join(agentDir, "sessions", "live"), join(agentDir, "extensions"), cwd]) mkdirSync(d, { recursive: true });
  const ext = join(REPO, "pi-config", "extensions");
  for (const n of entries(ext)) symlinkSync(join(ext, n), join(agentDir, "extensions", n));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "runaway", defaultThinkingLevel: "off", theme: "dark" }));
  const id = "01a0-headless";
  const path = join(sessions, `2026-10-14T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-14T00:00:00.000Z", cwd })}\n`);
  const log = join(t, "standins.log");
  const sock = join(t, "s", "c.sock");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, SOVA_CHAT_SOCK: sock, SOVA_CHAT_PATH: path, SOVA_CHAT_ID: id, SOVA_CHAT_UNIT: "u-test", SOVA_CHAT_BUILD: "b1", SOVA_PRICES_FETCH: "off", SOVA_STANDIN_LOG: log, ...NO_NETWORK };
  for (const k of ["SOVA_CHAT_LIVE_ROOT", "SOVA_CHAT_COPIES_ROOT", "SOVA_CHAT_STATE_ROOT"]) delete env[k];
  let out = "";
  const child = spawn(process.execPath, [join(REPO, "server/chat-runtime/main.ts")], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(child);
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.once("exit", r));

  const { link, hello } = await connectLink(sock, { epoch: 1, build: "b1", settings: DEFAULT_RUNTIME_SETTINGS, since: null, retryForMs: 30_000, retryEveryMs: 50, log: () => {} });
  // As a server would, minimally: nothing to say to any of the chat's questions.
  const asked: string[] = [];
  link.on("ask", (f) => (asked.push(f.method), link.send({ t: "answer", id: f.id, ok: true, result: null })));
  // No workers here: a list is empty, anything else is refused.
  link.on("wk", (f) => link.send(f.op === "list" ? { t: "wk.result", id: f.id, ok: true, result: [] } : { t: "wk.result", id: f.id, ok: false, error: { message: "no workers in this test" } }));
  if (hello.state !== "ready") await awaitFrame(link, "hello", 60_000, (h) => h.state === "ready");
  const opened = awaitFrame(link, "opened", 60_000);
  link.send({ t: "open", id: "o1", path, force: true, link: null, served: [] });
  assert.equal((await opened).ok, true, out);
  const sent: string[] = [];
  link.on("client.send", (f) => sent.push(f.json));
  link.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1", wire: 2 } });
  // The pane's hello first, as a browser's prompt comes after it.
  for (let i = 0; i < 300 && !sent.some((j) => JSON.parse(j).type === "hello"); i++) await new Promise((r) => setTimeout(r, 50));
  link.send({ t: "client.msg", clientId: "k1", msg: { type: "prompt", text: "run the probe", clientId: "p1" } });
  const lines = () => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const done = () => lines().some((e) => e.type === "message" && e.message?.role === "assistant" && JSON.stringify(e.message.content).includes("Done."));
  for (let i = 0; i < 600 && !done(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(done(), `the turn ended with the stub's reply:\n${out.slice(-3000)}\n${sent.map((j) => j.slice(0, 300)).join("\n").slice(-4000)}\n${readFileSync(path, "utf8").slice(-2000)}\nasked: ${asked.join(",")}\nstub requests: ${stub.stats.requests}\nkinds: ${sent.map((j) => JSON.parse(j).type + (JSON.parse(j).request?.method ? ":" + JSON.parse(j).request.method : "")).join(",")}`);
  const result = lines().find((e) => e.type === "message" && e.message?.role === "toolResult");
  assert.match(JSON.stringify(result?.message?.content), /standin-probe/, "the bash tool ran");
  link.send({ t: "client.detach", clientId: "k1" });
  const exit = awaitFrame(link, "exit", 30_000);
  link.send({ t: "drain", id: "d1", reason: "idle", force: true });
  await exit;
  await exited;

  const logged = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  console.log(`[headless] stand-in log of a chat process with ${entries(ext).length} extensions and one turn:\n${logged.join("\n")}`);
  const loads = logged.filter((l) => l.startsWith("load ")).map((l) => l.slice(5));
  const replaced = (re: RegExp) => loads.some((p) => re.test(p));
  for (const re of [/\/pi-tui\/dist\/tui\.js$/, /\/pi-tui\/dist\/components\/text\.js$/, /\/marked\/lib\/marked\.esm\.js$/, /\/pi-coding-agent\/dist\/modes\/interactive\/interactive-mode\.js$/, /\/pi-coding-agent\/dist\/modes\/interactive\/components\/index\.js$/, /\/pi-coding-agent\/dist\/utils\/syntax-highlight\.js$/])
    assert.ok(replaced(re), `replaced: ${re}`);
  for (const p of loads) assert.doesNotMatch(p, /\/pi-tui\/dist\/(?:utils|keys|keybindings|fuzzy|colors|oklab|terminal-colors|terminal-image|index)\.js$|\/modes\/interactive\/theme\//, "the text, key and colour helpers and pi's theme stay real");
  // Every call that reached a stand-in, in the turn included: construction at load (an extension's or pi's
  // own component classes) only, never a drawing call (render, a terminal write, a highlighter).
  const calls = logged.filter((l) => l.startsWith("call ")).map((l) => l.slice(5));
  assert.deepEqual(calls.filter((c) => !/^new [A-Za-z]+$/.test(c)), [], "no stand-in was called but to construct one");
});

test("with the stand-ins installed, pi-tui exports every name the real one does; its text helpers and pi's theme are the real ones", { timeout: 60_000 }, async () => {
  const realTui = await import(join(tuiDir, "dist", "index.js"));
  const probe = join(t, "parity.ts");
  writeFileSync(
    probe,
    `import { installHeadless, standInCalls } from ${JSON.stringify(join(REPO, "server/harness/pi/headless.ts"))};
installHeadless({});
const tui = await import(${JSON.stringify(join(tuiDir, "dist", "index.js"))});
const pi = await import(${JSON.stringify(join(piDir, "dist", "index.js"))});
pi.initTheme("dark");
const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
console.log("RESULT " + JSON.stringify({
  names: Object.keys(tui).sort(),
  width: tui.visibleWidth("a\\u4e2db"), cut: tui.truncateToWidth("abcdefgh", 5), wrap: tui.wrapTextWithAnsi("one two three", 7),
  key: tui.matchesKey("\\x1b", "escape"), accent: theme.fg("accent", "x"), stub: typeof tui.Text, calls: [...standInCalls().keys()],
}));
`,
  );
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { cwd: t, env: { ...process.env, PI_CODING_AGENT_DIR: join(t, "agent2") }, timeout: 60_000 });
  const r = JSON.parse(stdout.split("\n").find((l) => l.startsWith("RESULT "))!.slice(7));
  assert.deepEqual(r.names, Object.keys(realTui).sort(), "fixed?: pi-tui exports a name the stand-ins lack, or lacks one they give");
  assert.equal(r.width, realTui.visibleWidth("a\u4e2db"));
  assert.equal(r.cut, realTui.truncateToWidth("abcdefgh", 5));
  assert.deepEqual(r.wrap, realTui.wrapTextWithAnsi("one two three", 7));
  assert.equal(r.key, true);
  assert.match(r.accent, /\x1b\[38;[25];.*mx\x1b\[39m/, "the theme colours text");
  assert.equal(r.stub, "function");
  assert.deepEqual(r.calls, [], "loading pi called no stand-in");
});
