#!/usr/bin/env node
// The team-bar demonstration on two linked throwaway Sova copies (never the live Sova, never ~/.pi):
//
//   node examples/extensions/team-bar/demo/run-demo.mjs [--root <dir>] [--no-seed] [--seed-only]
//
// - "server": plays the team's shared server. It runs the host-mode part (../host), which labels each chat with
//   its owner and asks Sova to record who typed each message (`records: ["senders"]`).
// - "kim": plays Kim's own Sova. It runs the user part (../user), which declares the people and the owner key,
//   so Kim's session bar gets the person menu and the owner avatars.
// The two are paired through the mesh (a LAN pairing on loopback: the server is the relay, Kim's Sova dials it),
// the server granting Kim's Sova `sessions`. Each copy is server/testing/hermetic-server.ts: its own port, its own
// agent dir and sentinel HOME, the scripted stand-in model, and SOVA_EXTENSIONS_FILE, so the list entries this
// script writes count as approved. The parts' programs are started by this script (the list entry's `api` shape,
// "where you run the backend yourself"), with the environment Sova would give them.
//
// Seeding, all through Sova's own routes where one exists:
// - Kim's chats on the server: started and typed from Kim's Sova through its /peer/server/ proxy, so the server
//   records `peer:<Kim's node id>` and the host part labels them Kim's on its own.
// - Ravi's chats: started and typed on the server's own page (the operator's token), so `operator`, which the
//   people file gives to Ravi.
// - Lee's and Ana's chats: no computer of theirs is in this demo, so they are made with the extension's key (no
//   person), given an owner through the labels route, and their messages appended to the closed session file with
//   the who-typed marker beside each, as Sova's own tests append state to a closed file.
// - One chat waits on an open question, one is kept working on request (see the control file), one is local to
//   Kim's Sova (no owner).
//
// It writes <root>/demo.json (each copy's URL, unlock URL, token and agent dir) and then waits. Control by file:
// write "stop" to <root>/control to stop everything, "work" to start a 30 s turn in Kim's working chat,
// "off" / "on" to turn the user part off or on on Kim's Sova. SIGINT/SIGTERM stop everything too.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { startHermeticServer } from "../../../../server/testing/hermetic-server.ts";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(arg("--root") ?? join(ROOT, ".cache", "team-bar-demo"));
const noSeed = args.includes("--no-seed");
const EXT = "team-bar";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[demo ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function until(what, fn, ms = 60_000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

/** The key file's name (§app.extensions/backend-key): the id in lower case, "-", 8 hex of sha256(id), ".key". */
const keyFileName = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}.key`;

/** One call to a copy, with its token unless `headers` names another. */
async function call(copy, method, path, body, headers = {}) {
  const res = await fetch(`${copy.base}${path}`, {
    method,
    headers: { "x-sova-token": copy.token, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}
async function ok(copy, method, path, body, headers) {
  const r = await call(copy, method, path, body, headers);
  if (r.status >= 300) throw new Error(`${copy.name}: ${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ---- the copies -----------------------------------------------------------------------------------------

const children = [];
const copies = {};

async function startCopy(name) {
  const hs = await startHermeticServer({ root, keep: true, bootTimeoutMs: 90_000 });
  const copy = { name, ...hs, base: hs.base, token: hs.token };
  copies[name] = copy;
  log(`${name}: ${hs.base} (agent dir ${hs.agentDir})`);
  return copy;
}

/** The part's list entry (approved: the copy names its list file) and its program, started here. */
async function installPart(copy, part, people) {
  const desc = JSON.parse(readFileSync(join(HERE, "..", part, "sova-extension.json"), "utf8"));
  const port = await freePort();
  const stateRoot = join(copy.agentDir, "sova");
  const dataDir = join(stateRoot, "extension-data", EXT);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "people.json"), `${JSON.stringify(people, null, 2)}\n`);
  const entry = { id: desc.id, title: desc.title, description: desc.description, icon: desc.icon, needsContract: desc.needsContract, api: `http://127.0.0.1:${port}` };
  for (const k of ["screens", "records", "commands"]) if (desc[k] !== undefined) entry[k] = desc[k];
  copy.entry = entry;
  copy.listFile = join(stateRoot, "extensions.json");
  writeList(copy, false);
  const keyFile = join(stateRoot, "extension-keys", keyFileName(EXT));
  copy.keyFile = keyFile;
  const out = join(root, `${copy.name}-${part}.log`);
  const child = spawn(process.execPath, [join(HERE, "..", part, "server.mjs")], {
    cwd: join(HERE, "..", part),
    env: { PATH: process.env.PATH ?? "", HOME: copy.home, PORT: String(port), SOVA_URL: copy.base, SOVA_EXTENSION_ID: EXT, SOVA_EXTENSION_KEY_FILE: keyFile, SOVA_EXTENSION_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => appendFileSync(out, d));
  child.stderr.on("data", (d) => appendFileSync(out, d));
  children.push(child);
  await until(`${copy.name}'s ${part} part answering`, async () => (await fetch(`${entry.api}/api/health`)).ok);
  copy.key = await until(`${copy.name}'s key for ${EXT}`, async () => existsSync(keyFile) && readFileSync(keyFile, "utf8").trim());
  log(`${copy.name}: ${part} part on ${entry.api}`);
}

function writeList(copy, off) {
  writeFileSync(copy.listFile, `${JSON.stringify({ version: 1, extensions: [{ ...copy.entry, ...(off ? { off: true } : {}) }] }, null, 2)}\n`);
}

/** The server is the relay on loopback; Kim's Sova dials it. The server grants Kim's Sova `sessions`. */
async function pair(server, kim) {
  const serverPin = (await ok(server, "POST", "/api/mesh/lan/key")).fingerprint;
  const kimPin = (await ok(kim, "POST", "/api/mesh/lan/key")).fingerprint;
  const relayPort = await freePort();
  await ok(server, "PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: relayPort } });
  await ok(server, "POST", "/api/mesh/lan/pairings", { id: "kim", label: "Kim's laptop", role: "accept", pin: kimPin, grant: "sessions" });
  await ok(kim, "POST", "/api/mesh/lan/pairings", { id: "server", label: "Team server", role: "dial", pin: serverPin, host: "127.0.0.1", port: relayPort });
  await until("the pairing's channels", async () => {
    const p = (await ok(kim, "GET", "/api/mesh/lan")).pairings?.find((x) => x.id === "server");
    return p?.channels?.answer?.state === "connected" && p?.channels?.ask?.state === "connected";
  });
  // Made-up display names: a copy otherwise calls itself by this machine's host name.
  for (const [copy, label] of [[server, "Team server"], [kim, "Kim's laptop"]]) {
    const self = JSON.parse(readFileSync(join(copy.agentDir, "sova", "peers.json"), "utf8")).self;
    await ok(copy, "PUT", "/api/mesh/label", { id: self.id, label });
  }
  const hex = (pin) => pin.replace(/[\s-]/g, "").toLowerCase();
  return { kimNode: `lan:${hex(kimPin)}`, serverNode: `lan:${hex(serverPin)}` };
}

// ---- seeding ----------------------------------------------------------------------------------------

const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** A chat's state settles: not busy any more (or the timeout). */
async function idle(copy, id, viaPeer = "") {
  await until(`chat ${id} idle`, async () => {
    const r = await call(copy, "GET", `${viaPeer}/api/sessions/by-id/${encodeURIComponent(id)}`);
    return r.status === 200 && !r.body?.busy && r.body?.activity?.state !== "working" ? r.body : undefined;
  }, 90_000, 500);
}

/** A chat made by `copy` (on itself, or on the server through `viaPeer`), its first prompt typed there. */
async function realChat(copy, { viaPeer = "", cwd, title, prompts }) {
  const made = await ok(copy, "POST", `${viaPeer}/api/sessions`, { cwd });
  for (const [i, text] of prompts.entries()) {
    if (i) await idle(copy, made.id, viaPeer);
    await ok(copy, "POST", `${viaPeer}/api/sessions/prompt`, { path: made.path, text });
  }
  await idle(copy, made.id, viaPeer);
  await ok(copy, "POST", `${viaPeer}/api/sessions/title`, { path: made.path, title });
  return made;
}

let seq = 0;
const entryId = () => `seed${(++seq).toString(16).padStart(4, "0")}`;

/**
 * A chat of someone with no computer in this demo: made with the extension's key (so it has no starter that
 * names a person), owned through the labels route, and its conversation appended to the closed file, each typed
 * message with the who-typed marker beside it.
 */
async function seededChat(server, { owner, by, label, title, turns, question }) {
  const made = await ok(server, "POST", "/api/sessions", { cwd: server.work }, { "x-sova-token": server.key });
  await ok(server, "POST", "/api/sessions/labels", { id: made.id, labels: { owner } }, { "x-sova-token": server.key });
  const all = lines(made.path);
  let parent = all.at(-1)?.type === "session" ? null : (all.at(-1)?.id ?? null);
  const t0 = Date.now() - (20 + 10 * seq) * 60_000;
  let n = 0;
  const at = () => new Date(t0 + (n++) * 20_000).toISOString();
  const put = (e) => {
    appendFileSync(made.path, `${JSON.stringify(e)}\n`);
    parent = e.id;
  };
  put({ type: "model_change", id: entryId(), parentId: parent, timestamp: at(), provider: "mock", modelId: "m1" });
  for (const turn of turns) {
    const ts = at();
    const user = { type: "message", id: entryId(), parentId: parent, timestamp: ts, message: { role: "user", content: [{ type: "text", text: turn.user }], timestamp: Date.parse(ts) } };
    put(user);
    put({ type: "custom", customType: "sova-member-sent", data: { v: 1, targetId: user.id, by, ...(label ? { label } : {}) }, id: entryId(), parentId: user.id, timestamp: ts });
    const ats = at();
    put({
      type: "message",
      id: entryId(),
      parentId: parent,
      timestamp: ats,
      message: { role: "assistant", content: [{ type: "text", text: turn.reply }], api: "openai-completions", provider: "mock", model: "m1", usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 1020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse(ats) },
    });
  }
  if (question) await appendQuestion(made.path, () => parent, (id) => (parent = id), at());
  // Nobody wrote this but the seeding: aged, so Sova doesn't read it as another process still writing.
  const old = new Date(t0 + n * 20_000);
  utimesSync(made.path, old, old);
  await ok(server, "POST", "/api/sessions/title", { path: made.path, title });
  return made;
}

/** An open alignment question, as the align tool's result records one (the chat then waits on the user). */
async function appendQuestion(path, parentOf, setParent, ts) {
  const { applyAlignCall } = await import("../../../../pi-config/extensions/mode/align.ts");
  const { details } = applyAlignCall([], { ops: [{ op: "create", title: "Export format", summary: "Pick the export's file format", questions: [{ topic: "Format", ask: "CSV or JSON for the monthly export?", recommendation: { choice: "CSV", why: "the finance sheet opens it as is" } }] }] }, { now: ts, readFile: () => "" });
  const e = { type: "message", id: entryId(), parentId: parentOf(), timestamp: ts, message: { role: "toolResult", toolCallId: "align1", toolName: "align", content: [{ type: "text", text: "Asked: CSV or JSON for the monthly export?" }], details, timestamp: Date.parse(ts) } };
  appendFileSync(path, `${JSON.stringify(e)}\n`);
  setParent(e.id);
}

async function seed(server, kim, nodes) {
  const leeNode = "lan:1ee0000000000000000000000000beef";
  const anaNode = "lan:a0a0000000000000000000000000cafe";
  const people = {
    self: "kim",
    people: [
      { id: "kim", name: "Kim Ortega", initials: "KO", callers: [`peer:${nodes.kimNode}`] },
      { id: "lee", name: "Lee Varga", initials: "LV", callers: [`peer:${leeNode}`] },
      { id: "ana", name: "Ana Moreno", initials: "AM", callers: [`peer:${anaNode}`] },
      { id: "ravi", name: "Ravi Solberg", initials: "RS", callers: ["operator"] },
    ],
  };
  await installPart(server, "host", people);
  await installPart(kim, "user", people);

  const via = "/peer/server";
  const made = {};
  log("seeding Kim's chats (typed on Kim's Sova, through the mesh)");
  made.kimLogin = await realChat(kim, { viaPeer: via, cwd: server.work, title: "Fix the login redirect loop", prompts: ["The login page redirects forever after a password reset. Find the loop.", "Add a test that covers the reset path too."] });
  made.kimWork = await realChat(kim, { viaPeer: via, cwd: server.work, title: "Draft the release notes", prompts: ["Draft release notes for this week's changes."] });
  log("seeding Ravi's chats (typed on the server's own page)");
  made.raviDeps = await realChat(server, { cwd: server.work, title: "Upgrade the build tooling", prompts: ["Check which build dependencies are out of date."] });
  log("seeding Lee's and Ana's chats (labels route, appended markers)");
  made.leeOnboard = await seededChat(server, {
    owner: "lee",
    by: `peer:${leeNode}`,
    label: "Lee's laptop",
    title: "Update the onboarding checklist",
    turns: [
      { user: "Our onboarding checklist still mentions the old VPN. Update it.", reply: "Updated the checklist: the VPN steps are replaced by the new single sign-on steps." },
      { user: "Also add a line about the shared server.", reply: "Added: 'Ask a teammate to link your Sova to the team server.'" },
    ],
  });
  made.leeExport = await seededChat(server, { owner: "lee", by: `peer:${leeNode}`, label: "Lee's laptop", title: "Monthly export for finance", turns: [{ user: "Build the monthly export for finance.", reply: "Before I build it, one question about the format." }], question: true });
  made.anaSearch = await seededChat(server, { owner: "ana", by: `peer:${anaNode}`, label: "Ana's desktop", title: "Investigate slow search", turns: [{ user: "Search takes seconds on large projects. Profile it.", reply: "Most of the time goes to re-reading every file; an index would fix it." }] });
  log("Kim types into Lee's chat (a mixed conversation)");
  await ok(kim, "POST", `${via}/api/sessions/prompt`, { path: made.leeOnboard.path, text: "Kim here: please also link the new laptop guide." });
  await idle(kim, made.leeOnboard.id, via);
  log("a chat local to Kim's Sova");
  made.kimLocal = await realChat(kim, { cwd: kim.work, title: "Personal scratch notes", prompts: ["Keep a list of what I learn this week."] });
  return made;
}

// ---- main -------------------------------------------------------------------------------------------

let stopping = false;
async function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  log("stopping");
  for (const c of children) c.kill("SIGTERM");
  await Promise.all(Object.values(copies).map((c) => c.stop().catch(() => [])));
  log("stopped");
  process.exit(code);
}
process.on("SIGINT", () => void stopAll());
process.on("SIGTERM", () => void stopAll());

try {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const [server, kim] = [await startCopy("server"), await startCopy("kim")];
  const nodes = await pair(server, kim);
  log(`paired: Kim's Sova is ${nodes.kimNode} on the server`);
  const made = noSeed ? {} : await seed(server, kim, nodes);
  const state = {
    server: { base: server.base, unlock: `${server.base}/#t=${server.token}`, token: server.token, agentDir: server.agentDir, work: server.work },
    kim: { base: kim.base, unlock: `${kim.base}/#t=${kim.token}`, token: kim.token, agentDir: kim.agentDir, work: kim.work, listFile: kim.listFile },
    nodes,
    chats: Object.fromEntries(Object.entries(made).map(([k, v]) => [k, { id: v.id, path: v.path }])),
  };
  writeFileSync(join(root, "demo.json"), `${JSON.stringify(state, null, 2)}\n`);
  log(`ready: ${join(root, "demo.json")}`);
  const control = join(root, "control");
  writeFileSync(control, "");
  for (;;) {
    await sleep(500);
    const cmd = readFileSync(control, "utf8").trim();
    if (!cmd) continue;
    writeFileSync(control, "");
    if (cmd === "stop") await stopAll();
    else if (cmd === "off" || cmd === "on") {
      writeList(kim, cmd === "off");
      log(`Kim's user part turned ${cmd}`);
    } else if (cmd === "work" && made.kimWork) {
      await ok(kim, "POST", "/peer/server/api/sessions/prompt", { path: made.kimWork.path, text: "[[slow]] Add a section on the new person filter." });
      log("Kim's release notes chat is working (30 s)");
    } else log(`unknown control: ${cmd}`);
  }
} catch (err) {
  console.error(err);
  for (const c of Object.values(copies)) console.error(`--- ${c.name} log tail ---\n${c.log?.().slice(-3000)}`);
  await stopAll(1);
}
