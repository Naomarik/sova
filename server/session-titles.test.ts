// Run: npx tsx --test server/session-titles.test.ts
// Renaming a session in Sova only:
// the store, the route, and the one thing the feature promises — the .jsonl is never written.
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-titles-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
process.env.PORT = "0"; // an ephemeral listener: the route tests use app.request, not the socket
const sessionsDir = join(agentDir, "sessions", "--tmp-titles--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { app, server } = await import("./index");
const { cleanSessionTitle, dropSessionTitles, readSessionTitles, SESSION_TITLE_MAX, setSessionTitle } = await import("./session-titles");
const { getSessionSummary, listSessions } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  rmSync(agentDir, { recursive: true, force: true });
});

const file = join(agentDir, "sova", "session-titles.json");
const ID_A = "01234567-89ab-7cde-8f01-2345678900a1";
const ID_B = "01234567-89ab-7cde-8f01-2345678900a2";

const header = (id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
const userMessage = (text: string) =>
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: text } });

function session(id: string, firstMessage: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id), userMessage(firstMessage)].join("\n")}\n`);
  return canonicalPath(path);
}

const request = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const pathA = session(ID_A, "derived title A");
const pathB = session(ID_B, "derived title B");

test("cleanSessionTitle: trims, collapses whitespace, refuses empty, control characters and over-long", () => {
  assert.equal(cleanSessionTitle("  Rename  me  "), "Rename me");
  assert.equal(cleanSessionTitle("two\nlines"), "two lines");
  assert.equal(cleanSessionTitle(""), null);
  assert.equal(cleanSessionTitle("   "), null);
  assert.equal(cleanSessionTitle("bell\u0007"), null);
  assert.equal(cleanSessionTitle("x".repeat(SESSION_TITLE_MAX)), "x".repeat(SESSION_TITLE_MAX));
  assert.equal(cleanSessionTitle("x".repeat(SESSION_TITLE_MAX + 1)), null);
  assert.equal(cleanSessionTitle(7), null);
  assert.equal(cleanSessionTitle(null), null);
});

test("setSessionTitle stores, clears, and keeps another server instance's titles", () => {
  setSessionTitle(ID_A, "Mine");
  assert.deepEqual({ ...readSessionTitles() }, { [ID_A]: "Mine" });
  const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; titles: Record<string, string> };
  assert.equal(raw.version, 1);
  // Another server writes while we hold our copy: our next write must not drop its entry.
  raw.titles["from-another-server"] = "Theirs";
  writeFileSync(file, JSON.stringify(raw));
  setSessionTitle(ID_B, "Second");
  assert.deepEqual({ ...readSessionTitles() }, { [ID_A]: "Mine", "from-another-server": "Theirs", [ID_B]: "Second" });
  setSessionTitle(ID_A, null);
  assert.deepEqual(Object.keys(readSessionTitles()).sort(), [ID_B, "from-another-server"].sort());
  dropSessionTitles([ID_B, "from-another-server"]);
  assert.deepEqual({ ...readSessionTitles() }, {});
});

test("a corrupt store, and a bad value in a good one, cost nothing but themselves", () => {
  writeFileSync(file, "{not json");
  assert.deepEqual({ ...readSessionTitles() }, {});
  writeFileSync(file, JSON.stringify({ version: 1, titles: { [ID_A]: "Kept", [ID_B]: { nope: true }, empty: "   " } }));
  assert.deepEqual({ ...readSessionTitles() }, { [ID_A]: "Kept" });
  setSessionTitle(ID_A, null);
});

test("the list and one summary show the override, and carry the derived title as originalTitle", async () => {
  const before = await getSessionSummary(pathA);
  assert.equal(before?.title, "derived title A");
  assert.equal(before?.originalTitle, undefined);
  setSessionTitle(ID_A, "Renamed in Sova");
  const after = await getSessionSummary(pathA);
  assert.equal(after?.title, "Renamed in Sova");
  assert.equal(after?.originalTitle, "derived title A");
  const listed = (await listSessions()).find((s) => s.path === pathA);
  assert.equal(listed?.title, "Renamed in Sova");
  assert.equal(listed?.originalTitle, "derived title A");
  // Only the renamed one: a shared store must not leak a title onto its neighbour.
  const other = (await listSessions()).find((s) => s.path === pathB);
  assert.equal(other?.title, "derived title B");
  assert.equal(other?.originalTitle, undefined);
  // An override equal to the derived title is no override at all: no stale originalTitle.
  setSessionTitle(ID_A, "derived title A");
  assert.equal((await getSessionSummary(pathA))?.originalTitle, undefined);
  setSessionTitle(ID_A, null);
  assert.equal((await getSessionSummary(pathA))?.title, "derived title A");
});

test("POST /api/sessions/title renames, clears, and answers with the session's new summary", async () => {
  const set = await request("/api/sessions/title", { path: pathA, title: "  From the route  " });
  assert.equal(set.status, 200);
  const summary = (await set.json()) as { title: string; originalTitle?: string; id: string };
  assert.equal(summary.title, "From the route");
  assert.equal(summary.originalTitle, "derived title A");
  assert.equal(summary.id, ID_A); // keyed by the HEADER id, not the file name
  assert.deepEqual({ ...readSessionTitles() }, { [ID_A]: "From the route" });
  const cleared = await request("/api/sessions/title", { path: pathA, title: null });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as { title: string }).title, "derived title A");
  assert.deepEqual({ ...readSessionTitles() }, {});
});

test("the route refuses bad input and paths outside the sessions dir, and writes nothing", async () => {
  const outside = join(tmpdir(), "not-a-session.jsonl");
  writeFileSync(outside, `${header(ID_A)}\n`);
  const cases: { body: unknown; status: number }[] = [
    { body: { path: pathA, title: "" }, status: 400 },
    { body: { path: pathA, title: "   " }, status: 400 },
    { body: { path: pathA, title: "x".repeat(SESSION_TITLE_MAX + 1) }, status: 400 },
    { body: { path: pathA, title: "bell\u0007" }, status: 400 },
    { body: { path: pathA, title: 7 }, status: 400 },
    { body: { path: pathA }, status: 400 },
    { body: { title: "no path" }, status: 400 },
    { body: { path: outside, title: "outside" }, status: 400 },
    { body: { path: `${sessionsDir}/../../escape.jsonl`, title: "escape" }, status: 400 },
    { body: { path: join(agentDir, "sessions", "live", "x.jsonl"), title: "live dir" }, status: 400 },
    { body: { path: join(sessionsDir, "2026-09-21T00-00-00-000Z_missing.jsonl"), title: "gone" }, status: 404 },
  ];
  for (const { body, status } of cases) {
    const res = await request("/api/sessions/title", body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(((await res.json()) as { error: string }).error, /\S/);
  }
  // Valid JSON that is not an object: every one of these used to reach `body.title` and come back
  // a 500 with a TypeError in it. A malformed request is the client's mistake, and says so: 400.
  for (const raw of ["null", "7", '"a string"', "[]", "[1,2]", "true", "", "{oops"]) {
    const res = await app.request("/api/sessions/title", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(res.status, 400, `body ${raw || "(empty)"}`);
    assert.match(((await res.json()) as { error: string }).error, /Expected JSON body/);
  }
  assert.deepEqual({ ...readSessionTitles() }, {});
  rmSync(outside, { force: true });
});

test("renaming writes no byte of the session file, and no file in the sessions dir at all", async () => {
  const bytes = readFileSync(pathA);
  const st = statSync(pathA);
  const listing = () => [...readFileSync(pathA)].length;
  const set = await request("/api/sessions/title", { path: pathA, title: "Still untouched" });
  assert.equal(set.status, 200);
  await request("/api/sessions/title", { path: pathA, title: null });
  assert.deepEqual([...readFileSync(pathA)], [...bytes]);
  assert.equal(listing(), bytes.length);
  assert.equal(statSync(pathA).mtimeMs, st.mtimeMs);
  assert.equal(statSync(pathA).size, st.size);
});
