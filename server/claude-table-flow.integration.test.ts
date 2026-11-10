// The whole flow on a throwaway Sova server (§app.claude-code-provider/model-table, /default-test): a
// stand-in `claude` program whose file holds real table rows, its timer shortened. No real Claude
// Code is ever read and no real login is used: the one-word test is the stand-in's answer.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

const ROOT = join(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(join(ROOT, "pi-config/extensions/claude-code/tests/fixtures/claude-tables/2.1.321.json"), "utf8")) as { rows: string[]; latestPerFamily: string };
const FAKE = join(ROOT, "scripts", "fake-claude.mjs");
const dir = mkdtempSync(join(tmpdir(), "sova-table-flow-"));
const exe = join(dir, "claude");
const failMark = join(dir, "login-expired");
const probeLog = join(dir, "probes.log");

const idOf = (row: string) => /id:"([^"]+)"/.exec(row)![1]!;
const rowFor = (id: string) => {
  const from = "claude-fable-5-2";
  return fixture.rows.find((r) => idOf(r) === from)!.replaceAll(from, id);
};
const NEXT = "claude-fable-9-1";
const LATER = "claude-fable-9-2";
const latest = (fable: string) => fixture.latestPerFamily.replace(/fable:"[^"]+"/, `fable:"${fable}"`);

let revision = 0;
/** The program as a new version of Claude Code: its file replaced, as an update replaces it. */
function install(table: string): void {
  // One line in a comment: the reader looks at the text and never runs it. The rest answers the one-word test.
  const script = `#!/bin/sh
# revision ${++revision} ${table}
for a in "$@"; do if [ "$prev" = "--model" ]; then model="$a"; fi; prev="$a"; done
case " $* " in
  *" stream-json "*) ;;
  *" -p "*" --output-format json "*)
    cat >/dev/null
    echo "$model" >> ${JSON.stringify(probeLog)}
    if [ -e ${JSON.stringify(failMark)} ]; then
      echo '{"is_error":true,"result":"Failed to authenticate: OAuth session expired"}'
    else
      printf '{"is_error":false,"result":"OK","modelUsage":{"%s":{}}}\\n' "$model"
    fi
    exit 0;;
esac
exec node ${JSON.stringify(FAKE)} "$@"
`;
  const tmp = `${exe}.${revision}`;
  writeFileSync(tmp, script);
  chmodSync(tmp, 0o755);
  renameSync(tmp, exe);
}
const table = (rows: string[], latestValue: string) => `const T=[${rows.join(",")}];var c={latest_per_family:${latestValue}};`;
const withModels = (...ids: string[]) => table([...fixture.rows, ...ids.map(rowFor)], latest(ids.at(-1)!));

/** PATH with no `claude` but the stand-in's folder first: removing the file leaves none at all. */
const PATH = [dir, ...(process.env.PATH ?? "").split(":").filter((d) => d && !existsSync(join(d, "claude")))].join(":");

let s: HermeticServer | undefined;
after(async () => {
  await s?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(what: string, read: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${s?.log().slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
interface Store { models: { id: string }[]; dropped?: string[]; tested?: string[]; unreadable?: unknown; probes?: Record<string, { ok: boolean; reason?: string }> }
const store = (): Store | null => {
  try {
    return JSON.parse(readFileSync(join(s!.agentDir, "sova", "claude-models.json"), "utf8")) as Store;
  } catch {
    return null;
  }
};
const get = async (path: string) => {
  const r = await fetch(`${s!.base}${path}`, { headers: { "x-sova-token": s!.token } });
  assert.equal(r.status, 200, path);
  return r.json() as Promise<any>;
};
const claudeList = async (): Promise<{ id: string; contextWindow?: number }[]> => ((await get("/api/models")) as { provider: string; id: string; contextWindow?: number }[]).filter((m) => m.provider === "claude-code-cli");
const has = async (id: string) => (await claudeList()).some((m) => m.id === id);
const probes = (id: string) => (existsSync(probeLog) ? readFileSync(probeLog, "utf8").split("\n").filter((l) => l === id).length : 0);

test("a model arrives, waits on its test, survives a bad table and restarts, and leaves when the table drops it", async () => {
  writeFileSync(failMark, "");
  install(withModels(NEXT));
  s = await startHermeticServer({ extensions: ["claude-code"], env: { PATH, SOVA_MODELS_FETCH: "on", SOVA_CLAUDE_TABLE: "on", SOVA_CLAUDE_TABLE_POLL_MS: "100" } });

  // Learned at start; the login has expired, so it is in the lists and no default moves to it.
  await waitFor("the failed test recorded", () => store()?.probes?.[NEXT]?.reason?.includes("OAuth"));
  await waitFor("the list to take it", () => has(NEXT));
  assert.deepEqual(store()!.tested ?? [], []);
  assert.equal((await claudeList()).find((m) => m.id === NEXT)!.contextWindow, 1_000_000, "the table's window");
  assert.equal((await get("/api/claude/catalog")).lastKnown, false);

  // The list doesn't move between asks (the name is the rule's: catalog-name-rule.test.ts).
  const asks = new Set<string>();
  for (let i = 0; i < 5; i++) asks.add(JSON.stringify(await claudeList()));
  assert.equal(asks.size, 1);

  // Claude Code updates with the login working again, no Sova restart: the new model and a retry.
  rmSync(failMark);
  const before = probes(NEXT);
  install(withModels(NEXT, LATER));
  await waitFor("the newer model listed", () => has(LATER));
  await waitFor("both passing", () => [NEXT, LATER].every((id) => store()?.tested?.includes(id)));
  assert.equal(probes(NEXT), before + 1, "retried once at the change of claude");

  // A layout it can't read: the last good list, the one quiet line, no "no models".
  const listBefore = (await claudeList()).map((m) => m.id);
  install("function R(){return 1}");
  await waitFor("the table reported unreadable", async () => (await get("/api/claude/catalog")).lastKnown === true);
  assert.deepEqual((await claudeList()).map((m) => m.id), listBefore);

  // Two restarts on it: ready at once, the same list, and a passed model is never tested again.
  const passed = probes(LATER);
  for (let i = 0; i < 2; i++) {
    await s.restart();
    await waitFor("the provider's warm-up", async () => (await claudeList()).length > 0);
    assert.deepEqual((await claudeList()).map((m) => m.id), listBefore, `restart ${i}: the remembered list as soon as there is a list`);
  }
  assert.equal(probes(LATER), passed);
  assert.equal((await get("/api/claude/catalog")).lastKnown, true, "still the last known list");

  // A good table that no longer lists Fable 9.1: it leaves, its identity stays, the line goes.
  install(table([...fixture.rows, rowFor(LATER)], latest(LATER)));
  await waitFor("the dropped model gone", async () => !(await has(NEXT)));
  assert.ok(store()!.dropped?.includes(NEXT));
  assert.ok(await has(LATER));
  await waitFor("the line gone", async () => (await get("/api/claude/catalog")).lastKnown === false);

  // No program at all, at the next start: the list stands and there's nothing to complain about.
  const listed = (await claudeList()).map((m) => m.id);
  rmSync(exe);
  await s.restart();
  await waitFor("the provider's warm-up", async () => (await claudeList()).length > 0);
  assert.deepEqual((await claudeList()).map((m) => m.id), listed);
  assert.equal((await get("/api/claude/catalog")).lastKnown, false);

  assert.deepEqual(await s.stop(), [], "nothing outside the scratch root was touched");
});
