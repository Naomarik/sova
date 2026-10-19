// Run: pnpm test:int -- scripts/sova-host.integration.test.ts
// `sova run <id> --host <peer>` (§mesh.peers/remote-commands), against a stub of this machine's
// server: the run goes to this machine's /peer/<peer>/api/commands/<id> with the params as one JSON
// object, --session is looked up on the peer, a path must be absolute, and a 404 or 403 says what it
// means. No real server and no ~/.pi: the token comes from SOVA_TOKEN.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { CliError, EXIT, main } from "./sova.mjs";

process.env.SOVA_TOKEN = "stub-token";
delete process.env.SOVA_CALLER_KEY;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let seen: Seen[] = [];
/** How the stub answers each request; the default is 200 `{ ok: true }`. */
let answer: (req: Seen, res: ServerResponse) => void = (_r, res) => json(res, 200, { ok: true });
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    seen.push(s);
    answer(s, res);
  });
});
let url = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const env = () => ({ SOVA_TOKEN: "stub-token", SOVA_EXTENSIONS_FILE: "/nonexistent/extensions.json" }) as NodeJS.ProcessEnv;

/** main(), with what it printed. */
async function sova(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  seen = [];
  let out = "";
  let err = "";
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => ((err += c), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv, env()), out, err };
  } catch (x) {
    if (x instanceof CliError) return { code: (x as unknown as { code: number }).code, out, err: err + x.message };
    throw x;
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

test("a remote run is one POST to this machine's /peer/<peer>/api/commands/<id>, the params as one object", async () => {
  answer = (_r, res) => json(res, 200, { title: "T" });
  const r = await sova(["run", "session.title.set", "--session", "/far/s.jsonl", "--title", "T", "--host", "b", "--url", url]);
  assert.equal(r.code, EXIT.done, r.err);
  assert.equal(seen.length, 1);
  const [s] = seen;
  assert.equal(s!.method, "POST");
  assert.equal(s!.url, "/peer/b/api/commands/session.title.set");
  assert.deepEqual(JSON.parse(s!.body), { session: "/far/s.jsonl", title: "T" });
  assert.equal(s!.headers["x-sova-command"], "session.title.set");
  assert.equal(s!.headers["x-sova-token"], "stub-token");
  assert.deepEqual(JSON.parse(r.out), { title: "T" });
  // The same with --host first.
  const lead = await sova(["--host", "b", "run", "session.title.set", "--session", "/far/s.jsonl", "--title", "T", "--url", url]);
  assert.equal(lead.code, EXIT.done, lead.err);
  assert.equal(seen[0]!.url, "/peer/b/api/commands/session.title.set");
});

test("--session is looked up on the peer, through the same proxy", async () => {
  answer = (r, res) => (r.url === "/peer/b/api/sessions" ? json(res, 200, [{ id: "s9", path: "/far/s9.jsonl" }]) : json(res, 200, { ok: true }));
  const r = await sova(["run", "session.tags.set", "--session", "/far/s9.jsonl", "--tags", "a,b", "--host", "b", "--url", url]);
  assert.equal(r.code, EXIT.done, r.err);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["GET /peer/b/api/sessions", "POST /peer/b/api/commands/session.tags.set"]);
  assert.deepEqual(JSON.parse(seen[1]!.body), { session: "s9", tags: ["a", "b"] });
});

test("refused before any request: a bad peer id, --host on anything but run, a relative path", async () => {
  for (const argv of [
    ["run", "session.list", "--host", "B!", "--url", url],
    ["run", "session.list", "--host", "--url", url],
    ["--host", "b", "list", "--url", url],
    ["--host", "b", "describe", "session.list"],
    ["--host"],
    ["list", "--host", "b", "--url", url],
    ["describe", "session.list", "--host", "b"],
    ["watch", "--host", "b", "--url", url],
    ["run", "project.create", "--root", "rel/dir", "--host", "b", "--url", url],
    ["run", "project.create", "--host", "b", "--root", "./x", "--url", url],
    ["run", "project.create", "--json", "{\"root\":\"rel\"}", "--host", "b", "--url", url],
  ]) {
    const r = await sova(argv);
    assert.equal(r.code, EXIT.invalid, `${argv.join(" ")}: ${r.err}`);
    assert.equal(seen.length, 0, argv.join(" "));
  }
  // An absolute path goes as given.
  const ok = await sova(["run", "project.create", "--root", "/far/proj", "--host", "b", "--url", url]);
  assert.equal(ok.code, EXIT.done, ok.err);
  assert.deepEqual(JSON.parse(seen[0]!.body), { root: "/far/proj" });
});

test("what a 404 or 403 means, in its own sentence", async () => {
  const cases: Array<[number, unknown, number, RegExp]> = [
    [404, { error: "Not found" }, EXIT.invalid, /b doesn't run remote commands \(an older Sova\?\)/],
    [404, { error: "Unknown peer" }, EXIT.invalid, /no peer b in this host's mesh/],
    [404, { error: "no command session.list on this host" }, EXIT.invalid, /no command session\.list on this host/],
    [403, { error: "not shared with this host" }, EXIT.refused, /b doesn't grant this host what session\.list needs/],
    [502, { error: "peer down", id: "b" }, EXIT.failed, /answered 502 on b/],
  ];
  for (const [status, body, code, line] of cases) {
    answer = (_r, res) => json(res, status, body);
    const r = await sova(["run", "session.list", "--host", "b", "--url", url]);
    assert.equal(r.code, code, `${status} ${JSON.stringify(body)}`);
    assert.match(r.err, line);
  }
  // The older-peer sentence is not the door's own.
  answer = (_r, res) => json(res, 404, { error: "no command x on this host" });
  assert.doesNotMatch((await sova(["run", "session.list", "--host", "b", "--url", url])).err, /older Sova/);
});

test("an in-chat action run remotely keeps exit 5 for an unknown outcome", async () => {
  answer = (_r, res) => json(res, 202, { outcome: "unknown" });
  const r = await sova(["run", "chat.stop", "--session", "/far/c.jsonl", "--host", "b", "--url", url]);
  assert.equal(r.code, EXIT.unknown, r.err);
  assert.equal(seen[0]!.url, "/peer/b/api/commands/chat.stop");
  // A connection that opened and broke before the answer: exit 5 too.
  answer = (_r, res) => res.socket?.destroy();
  const broke = await sova(["run", "chat.stop", "--session", "/far/c.jsonl", "--host", "b", "--url", url]);
  assert.equal(broke.code, EXIT.unknown, broke.err);
  // And an entry that is no in-chat action is exit 1 for the same break.
  const other = await sova(["run", "session.list", "--host", "b", "--url", url]);
  assert.equal(other.code, EXIT.failed, other.err);
});

test("without --host, a run is the entry's own request, as before", async () => {
  answer = (_r, res) => json(res, 200, { title: "T" });
  const r = await sova(["run", "session.title.set", "--session", "/far/s.jsonl", "--title", "T", "--url", url]);
  assert.equal(r.code, EXIT.done, r.err);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["POST /api/sessions/title"]);
  assert.deepEqual(JSON.parse(seen[0]!.body), { path: "/far/s.jsonl", title: "T" });
});
