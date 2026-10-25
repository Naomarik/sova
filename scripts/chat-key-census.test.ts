// Run: pnpm test -- scripts/chat-key-census.test.ts
// The chat key census (scripts/chat-key-census.mjs) over synthetic session files written here: each
// kind of call a chat makes to Sova with the operator's key is found and counted per chat, what is no
// tool call (a user's own command, text that names one) is not, routes lose their ids and query
// values, nothing secret or private is printed, and the input is never written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error: a plain .mjs script, no declarations
import { census, classify, loadRoutes, routeOf, sessionFiles, toMarkdown, unquoted } from "./chat-key-census.mjs";

const tmp = mkdtempSync(join(tmpdir(), "sova-census-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const FAKE_TOKEN = "fake-token-0000-test-only";
const PROMPT = "please rename my private project Wobblefish";

let n = 0;
const call = (name: string, args: unknown) => ({ type: "message", id: `m${++n}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name, arguments: args }] } });
const bash = (command: string) => call("bash", { command });
const write = (file: string, entries: unknown[]) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const dir = join(tmp, "sessions");
write(join(dir, "--a--", "one.jsonl"), [
  { type: "session", id: "s1" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: PROMPT }] } },
  bash("node scripts/sova-project.mjs status --project p1"),
  bash(`curl -s -H "x-sova-token: ${FAKE_TOKEN}" http://127.0.0.1:4800/api/sessions/title?path=/home/x/s.jsonl -X POST -d '{"title":"${PROMPT}"}'`),
  bash("curl -s 'http://127.0.0.1:4800/api/projects/acme-secret/files?path=/home/x' && curl http://127.0.0.1:4800/api/acme-family/x"),
  bash("node scripts/sova.mjs run wobble.secret.id && node scripts/sova-project.mjs secretverb"),
  bash("cat ~/.pi/agent/sova/auth-token"),
  call("link_send", { to: "x", text: PROMPT }),
  // Text that names a command, and a grep for one: not calls.
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "run sova-project approve next" }] } },
  bash('grep -rn "sova-project approve" docs/ && rg "127.0.0.1:4800/api/sessions" server'),
]);
write(join(dir, "--b--", "two.jsonl"), [
  bash("SOVA_PORT=4810 node scripts/sova.mjs run session.title.set --session abc --title x && sova token"),
  bash("curl -s http://localhost:4810/api/health; node -e 'fetch(\"http://127.0.0.1:4800/api/models\")'"),
  call("read", { path: "/home/u/.pi/agent/sova/auth-token" }),
  call("read", { path: "/home/u/notes.md" }),
  // A user's own `!` command is no tool call.
  { type: "message", message: { role: "bashExecution", command: "sova-project down", output: "" } },
  // Nor is a tool call shaped part of anything but the model's own message (a pasted transcript).
  { type: "message", message: { role: "user", content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "sova-project down" } }] } },
]);
// A link out of the directory is never followed.
const outside = join(tmp, "outside");
write(join(outside, "three.jsonl"), [bash("node scripts/sova-project.mjs teardown")]);
symlinkSync(outside, join(dir, "linked"));

const kind = (r: { kinds: Array<{ kind: string; calls: number; chats: number; what: Array<{ what: string; calls: number; chats: number }> }> }, k: string) => r.kinds.find((x) => x.kind === k)!;

test("each kind of call is found and counted per chat, and nothing that is no tool call", async () => {
  const before = readdirSync(dir, { recursive: true }).map((f) => [f, statSync(join(dir, String(f))).mtimeMs]);
  const { files } = sessionFiles(dir);
  assert.equal(files.length, 2);
  const r = await census(files);
  assert.deepEqual(kind(r, "sova-project").what, [{ what: "<other>", calls: 1, chats: 1 }, { what: "status", calls: 1, chats: 1 }]);
  assert.deepEqual(kind(r, "sova.mjs").what, [{ what: "run <other>", calls: 1, chats: 1 }, { what: "run session.title.set", calls: 1, chats: 1 }]);
  assert.deepEqual(kind(r, "sova launcher").what, [{ what: "token", calls: 1, chats: 1 }]);
  assert.deepEqual(kind(r, "http live").what.map((w: { what: string }) => w.what).sort(), ["GET /api/models", "GET /api/projects/:pid/files", "GET <unmatched>", "POST /api/sessions/title"]);
  assert.deepEqual(kind(r, "http other").what, [{ what: "GET /api/health (port 4810)", calls: 1, chats: 1 }]);
  assert.equal(kind(r, "http live").chats, 2);
  assert.deepEqual(
    kind(r, "token read").what.map((w: { what: string }) => w.what).sort(),
    ["read tool", "reads the file", "sova token"],
  );
  assert.deepEqual(kind(r, "link tool").what, [{ what: "link_send", calls: 1, chats: 1 }]);
  assert.equal(r.chats, 2);
  const after = readdirSync(dir, { recursive: true }).map((f) => [f, statSync(join(dir, String(f))).mtimeMs]);
  assert.deepEqual(after, before, "the sessions are never written");
});

test("the output never carries a token, a prompt, a path or a command line", async () => {
  const r = await census(sessionFiles(dir).files);
  for (const text of [toMarkdown(r), JSON.stringify(r)]) {
    for (const leak of [FAKE_TOKEN, "Wobblefish", "/home/", "s.jsonl", "acme", "wobble", "secretverb", "path", "--project", "x-sova-token"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  }
});

test("a URL is printed only as the route it reaches, never its own segments or query", () => {
  const routes = loadRoutes();
  assert.equal(routeOf("GET", "/api/projects/acme-secret/files?path=/home/x", routes), "GET /api/projects/:pid/files");
  assert.equal(routeOf("GET", "/api/sessions/by-id/0123abcd", routes), "GET /api/sessions/by-id/:id");
  assert.equal(routeOf("GET", "/peer/laptop-name/api/health", routes), "GET /peer/:id/api/*");
  assert.equal(routeOf("GET", "/api/sessions/acme-nothing", routes), "GET <unmatched /api/sessions/…>");
  assert.equal(routeOf("GET", "/api/acme-family", routes), "GET <unmatched>");
  assert.equal(routeOf("GET", "/#t=abc", routes), "GET <page>");
  assert.equal(routeOf("GET", "/orgs/acme/projects", routes), "GET <page>");
  assert.equal(routeOf("WS", "/ws/chat?path=/x", routes), "WS /ws/chat");
});

test("quoted words are never commands; requests need a requester", () => {
  assert.equal(unquoted(`echo "sova token" 'x'`), `echo "          " ' '`);
  assert.deepEqual(classify("bash", { command: 'grep "|sova server on" log' }), []);
  assert.deepEqual(classify("bash", { command: "ls http://127.0.0.1:4800/api/x" }), []);
  assert.deepEqual(classify("bash", { command: "wget -qO- http://127.0.0.1:$SOVA_PORT/api/sessions" }), [{ kind: "http other", what: "GET /api/sessions (port $var)" }]);
  assert.deepEqual(classify("fetch_content", { url: "http://localhost:4800/api/health" }), [{ kind: "http live", what: "GET /api/health" }]);
  assert.deepEqual(classify("bash", { command: "websocat ws://127.0.0.1:4800/ws/events" }), [{ kind: "http live", what: "WS /ws/events" }]);
  for (const c of ["curl -X SECRETWORD http://127.0.0.1:4800/api/health", "node -e 'fetch(\"http://127.0.0.1:4800/api/models\", { method: \"secretword\" })'"])
    assert.ok(!JSON.stringify(classify("bash", { command: c })).toLowerCase().includes("secretword"), c);
  assert.equal(classify("bash", { command: "curl -X patch http://127.0.0.1:4800/api/health" })[0]!.what.split(" ")[0], "PATCH");
  assert.deepEqual(classify("bash", { command: "~/webapps/sova/scripts/sova-project apply --json" }), [{ kind: "sova-project", what: "apply" }]);
});
