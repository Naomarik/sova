// Run: pnpm test -- scripts/sova.test.ts
// The command line's own logic, in-process (§app.commands/cli): this machine only, the exit classes,
// the arguments, and what list and describe print (extensions' commands read from the manifest file
// itself). No request is made here: the real server and the real process are
// server/sova-cli.integration.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error: a plain .mjs script, no declarations
import { allEntries, CliError, coerce, EXIT, exitForAnswer, listLines, main, mergeJson, parseRunArgs, serverBase } from "./sova.mjs";
import { COMMANDS, findCommand } from "../shared/commands-catalog";

const tmp = mkdtempSync(join(tmpdir(), "sova-cli-unit-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const manifest = join(tmp, "extensions.json");
writeFileSync(manifest, JSON.stringify({ version: 1, extensions: [{ id: "notes", dist: "/x", api: "http://127.0.0.1:1", commands: [{ name: "snap", label: "Take Snapshot", params: { n: { type: "integer" } } }] }] }));
const env = { SOVA_EXTENSIONS_FILE: manifest } as Record<string, string>;

const refusedWith = (fn: () => unknown, code: number, re: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof CliError && (err as { code: number }).code === code && re.test((err as Error).message));

test("this machine only: loopback hosts pass, any other is refused (exit 2) before a request", () => {
  assert.equal(serverBase(undefined, {}), "http://127.0.0.1:4800");
  assert.equal(serverBase(undefined, { SOVA_PORT: "4811" }), "http://127.0.0.1:4811");
  assert.equal(serverBase(undefined, { SOVA_URL: "http://localhost:9/" }), "http://localhost:9");
  assert.equal(serverBase("http://[::1]:4800", {}), "http://[::1]:4800");
  for (const u of ["http://example.com:4800", "http://10.0.0.2:4800", "http://127.0.0.1.nip.io:4800", "http://user@evil.test:4800"]) refusedWith(() => serverBase(u, {}), EXIT.refused, /not this machine/);
  refusedWith(() => serverBase("ftp://127.0.0.1", {}), EXIT.invalid, /http/);
  refusedWith(() => serverBase("not a url", {}), EXIT.invalid, /not a URL/);
});

test("exit classes: a project result by its own code, else by HTTP status", () => {
  assert.equal(exitForAnswer(200, { ok: true }), 0);
  assert.equal(exitForAnswer(201, {}), 0);
  assert.equal(exitForAnswer(409, { error: "refused" }), 2);
  assert.equal(exitForAnswer(403, {}), 2);
  assert.equal(exitForAnswer(401, {}), 2);
  assert.equal(exitForAnswer(400, { error: "bad" }), 3);
  assert.equal(exitForAnswer(404, { error: "Session file not found" }), 3);
  assert.equal(exitForAnswer(423, {}), 4);
  assert.equal(exitForAnswer(500, { error: "x" }), 1);
  assert.equal(exitForAnswer(502, undefined), 1);
  // A project verb's result: its code decides (busy → 4, needs-confirm → 2, start-failed → 1).
  assert.equal(exitForAnswer(423, { error: { code: "busy", message: "" } }), 4);
  assert.equal(exitForAnswer(409, { error: { code: "needs-confirm", message: "" } }), 2);
  assert.equal(exitForAnswer(502, { error: { code: "start-failed", message: "" } }), 1);
  assert.equal(exitForAnswer(400, { error: { code: "invalid-request", message: "" } }), 3);
});

test("arguments: typed per param, unknown ones invalid, booleans may stand alone", () => {
  const up = findCommand("project.verb.up")!;
  const a = parseRunArgs(up, ["--slot", "2", "--restart", "--services", "web, db", "--project", "rel/dir", "--url", "http://127.0.0.1:1"]);
  assert.deepEqual({ ...a.values, project: a.values.project.endsWith("/rel/dir") }, { slot: 2, restart: true, services: ["web", "db"], project: true });
  assert.equal(a.url, "http://127.0.0.1:1");
  refusedWith(() => parseRunArgs(up, ["--slot", "x"]), EXIT.invalid, /whole number/);
  refusedWith(() => parseRunArgs(up, ["--nope", "1"]), EXIT.invalid, /no param --nope/);
  refusedWith(() => parseRunArgs(up, ["--session", "abc"]), EXIT.invalid, /takes no session/);
  refusedWith(() => parseRunArgs(up, ["stray"]), EXIT.invalid, /unexpected argument/);
  refusedWith(() => parseRunArgs(findCommand("session.title.set")!, ["--title"]), EXIT.invalid, /needs a value/);
  const tags = findCommand("session.tags.set")!;
  assert.deepEqual(parseRunArgs(tags, ["--tags", "null", "--session", "s1"]), { values: { tags: null }, session: "s1", json: undefined, url: undefined });
  refusedWith(() => coerce("thinking", findCommand("session.configure")!.params.thinking, "huge"), EXIT.invalid, /one of/);
  assert.equal(coerce("restart", up.params.restart, "false"), false);
});

test("--json merges under the flags; a session given there is taken too", () => {
  const set = findCommand("session.title.set")!;
  assert.deepEqual(mergeJson(set, '{"title":"from json","session":"abc"}', { title: "from flag" }), { values: { title: "from flag" }, session: "abc" });
  refusedWith(() => mergeJson(set, "[1]", {}), EXIT.invalid, /JSON object/);
  refusedWith(() => mergeJson(set, '{"nope":1}', {}), EXIT.invalid, /no param nope/);
});

test("list and describe: core entries, then the manifest's own; describe prints the entry as JSON", async () => {
  const entries = allEntries(env);
  assert.equal(entries.length, COMMANDS.length + 1);
  assert.equal(entries.at(-1).id, "ext.notes.snap");
  const lines = listLines(entries);
  assert.match(lines[0], /^session\.list\s+looks\s+List Sessions$/);
  assert.match(lines.at(-1), /^ext\.notes\.snap\s+changes\s+Take Snapshot$/);
  const written: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((s: string) => (written.push(s), true)) as typeof process.stdout.write;
  try {
    assert.equal(await main(["describe", "session.title.set"], env), 0);
    assert.equal(await main(["describe", "ext.notes.snap"], env), 0);
    assert.equal(await main(["list", "--json"], env), 0);
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual(JSON.parse(written[0]!), findCommand("session.title.set"));
  assert.equal(JSON.parse(written[1]!).route.path, "/ext/notes/api/commands/snap");
  assert.equal(JSON.parse(written[2]!).length, COMMANDS.length + 1);
  await assert.rejects(main(["describe", "nope"], env), (e: unknown) => e instanceof CliError && (e as { code: number }).code === EXIT.invalid);
  await assert.rejects(main(["frobnicate"], env), (e: unknown) => e instanceof CliError && (e as { code: number }).code === EXIT.invalid);
  // Refused before any request: list, run and watch alike.
  for (const argv of [["list", "--url", "http://example.com"], ["run", "session.list", "--url", "http://example.com"], ["watch", "--url", "http://example.com"]])
    await assert.rejects(main(argv, env), (e: unknown) => e instanceof CliError && (e as { code: number }).code === EXIT.refused, argv.join(" "));
});

test("a changing entry never takes the chat's session by default; a looking one does", async () => {
  // session.archive without --session, in a chat: invalid, before anything is sent.
  await assert.rejects(main(["run", "session.archive", "--url", "http://127.0.0.1:1"], { ...env, SOVA_CHAT_ID: "chat-1" }), /needs --session/);
});
