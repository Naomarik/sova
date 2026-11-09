// What Sova does with Claude Code's model table (§app.claude-code-provider/model-table, /default-test),
// decided in-process: real program-file stats, a stand-in for the child read and for the one-word test.
// The table text is built from three real versions' rows (tests/fixtures/claude-tables); the real
// binary is never read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { offerFromTable, parseClaudeTable, type ClaudeTableParse, type ClaudeTableRow } from "../pi-config/extensions/claude-code/bundle-table.ts";
import { CLAUDE_DEFAULT_WINDOW, CLAUDE_MODELS, claudeContextWindow, compareClaudeVersions, claudeModel, claudeName, claudeOffer, latestClaude, mergeClaudeCatalog, parseClaudeId, resolveClaude, unverifiedClaudeNote } from "../pi-config/extensions/claude-code/catalog.ts";
import { claudeTableStatus, loadClaudeModels, readClaudeModelsFile } from "../pi-config/extensions/claude-code/catalog-store.ts";
import { createClaudeTableCheck, judgeProbe, type ClaudeProbeResult } from "./claude-table";

const DIR = join(import.meta.dirname, "..", "pi-config", "extensions", "claude-code", "tests", "fixtures", "claude-tables");
interface Fixture { version: string; rows: string[]; latestPerFamily: string }
const tables = readdirSync(DIR).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture);
const newest = tables.at(-1)!;
const idOf = (row: string) => /id:"([^"]+)"/.exec(row)![1]!;
const seedIds = new Set(CLAUDE_MODELS.map((m) => m.id));

/** The table as it sits in the program: minified code around the rows. */
const text = (rows: string[], latest: string) => `var a=1;const T=[${rows.join(",")}];var c={best:"opus",latest_per_family:${latest},alias_migration:{}};function R(){}`;
const parsed = (rows: string[], latest: string) => parseClaudeTable(text(rows, latest));
/** A row of `id`, copied from a real one with the id swapped. */
const rowFor = (id: string, from = "claude-fable-5-2") => {
  const src = newest.rows.find((r) => idOf(r) === from)!;
  const family = /^claude-([a-z]+)-/.exec(id)![1]!;
  return src.replaceAll(from, id).replace(/family:"[a-z]+"/, `family:"${family}"`);
};
const latestOf = (over: Record<string, string>) => `{${Object.entries({ ...JSON.parse(newest.latestPerFamily.replace(/(\w+):/g, '"$1":')) as Record<string, string>, ...over }).map(([k, v]) => `${k}:"${v}"`).join(",")}}`;
const FABLE_NEXT = "claude-fable-9-1";
const withNext = () => parsed([...newest.rows, rowFor(FABLE_NEXT)], latestOf({ fable: FABLE_NEXT }));

const scratch = mkdtempSync(join(tmpdir(), "sova-claude-table-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => void mergeClaudeCatalog({ models: [] }));

let worlds = 0;
function world(first: ClaudeTableParse) {
  const dir = join(scratch, `w${++worlds}`);
  const root = join(dir, "state");
  mkdirSync(root, { recursive: true });
  const exe = join(dir, "claude");
  writeFileSync(exe, "#!/bin/sh\n");
  const w = {
    root,
    exe,
    table: first,
    missing: false,
    enabled: true,
    time: 1_000_000,
    reads: 0,
    probes: [] as string[],
    answer: (_id: string): ClaudeProbeResult => ({ ok: true }),
    /** Sova starting: a new check over the same state. */
    start() {
      return createClaudeTableCheck({
        root: () => root,
        enabled: () => w.enabled,
        executable: () => {
          if (w.missing) throw new Error("no claude");
          return exe;
        },
        read: async () => {
          w.reads++;
          return w.table;
        },
        probe: async (id) => {
          w.probes.push(id);
          return w.answer(id);
        },
        clock: { now: () => w.time, setTimeout: () => 0, clearTimeout: () => {} },
      });
    },
    /** The `claude` program replaced by another version. */
    update(table: ClaudeTableParse) {
      w.table = table;
      const later = new Date(statSync(exe).mtimeMs + 60_000);
      utimesSync(exe, later, later);
    },
    file: () => readClaudeModelsFile(root)!,
    load: () => loadClaudeModels(root),
  };
  return w;
}
const offered = () => claudeOffer().map((m) => m.id);

test("from each real table: only what is newer in a current family comes in", async () => {
  for (const t of tables) {
    const w = world(parsed(t.rows, t.latestPerFamily));
    await w.start().checkNow();
    w.load();
    const table = t.rows.map(idOf);
    const notInTable = [...seedIds].filter((id) => !table.includes(id));
    assert.deepEqual([...offered()].sort(), [...seedIds].filter((id) => table.includes(id)).sort(), `${t.version}: the built-in models this table lists, and nothing it adds`);
    assert.deepEqual(offered().filter((id) => /mythos|^claude-\d/.test(id)), [], `${t.version}: no Mythos, no old-order models`);
    assert.deepEqual([...(w.file().dropped ?? [])].sort(), notInTable.sort(), `${t.version}: only the built-in models it doesn't list left`);
  }
});

test("a table row's limits parse as the program states them", () => {
  const r = (body: string) => `{id:"claude-nova-1",family:"nova",display_name:"Nova 1",${body}}`;
  const one = (body: string) => {
    const p = parseClaudeTable(text([r(body)], '{nova:"claude-nova-1"}'));
    assert.ok(p.ok, body);
    return p.table.rows[0]!;
  };
  assert.equal(one("context:{window:2e5}").window, 200_000, "a number in exponent form");
  assert.equal(one("context:{maximum_window:1e6,window:200000}").window, 200_000, "not the maximum, in either order");
  assert.equal(one("context:{window:200000,maximum_window:1e6}").window, 200_000);
  assert.equal(one("pricing:\"x\"").window, CLAUDE_DEFAULT_WINDOW, "no context block");
  assert.deepEqual(one('capabilities:["thinking_disabled_effort_cap","per_turn_effort"]').efforts, [], "a word that only contains effort");
  assert.deepEqual(one('capabilities:["effort","max_effort"]').efforts, ["low", "medium", "high", "max"]);
  assert.equal(one("max_output_tokens:{default:128000,upper:128000}").maxOutput, 128_000);
  const twoRows = parseClaudeTable(text([r("pricing:\"x\""), `{id:"claude-nova-2",family:"nova",display_name:"Nova 2",context:{window:1e6,native_1m:!0}}`], '{nova:"claude-nova-2"}'));
  assert.ok(twoRows.ok);
  assert.equal(twoRows.table.rows[0]!.window, CLAUDE_DEFAULT_WINDOW, "a row with no context doesn't borrow the next row's");
});

test("each real table's rows agree with the built-in list", () => {
  for (const t of tables) {
    const p = parsed(t.rows, t.latestPerFamily);
    if (!p.ok) throw new Error(`${t.version}: ${p.reason}`);
    for (const seed of CLAUDE_MODELS) {
      const row: ClaudeTableRow | undefined = p.table.rows.find((x) => x.id === seed.id);
      if (!row && seed.id === "claude-fable-5-2" && t !== newest) continue; // newer than this Claude Code
      assert.ok(row, `${t.version}: ${seed.id}`);
      assert.deepEqual([row.window, row.maxOutput, row.efforts], [seed.window, seed.maxOutput, [...seed.efforts]], `${t.version}: ${seed.id}`);
    }
  }
});

test("a table the reader can't trust is no data, never no models", async () => {
  const noRows = parseClaudeTable("function R(){return 1}");
  const orphanLatest = parsed(newest.rows, latestOf({ fable: "claude-fable-77" }));
  const cutRow = parseClaudeTable(`${text(newest.rows, newest.latestPerFamily)}{id:"claude-nova-1",family:"nova",display_name:"Nova 1",context:{window:1`);
  const childDied: ClaudeTableParse = { ok: false, reason: "the table reader stopped without an answer" };
  for (const [name, bad] of [["no rows", noRows], ["latest isn't a row", orphanLatest], ["a row cut off", cutRow], ["the child died", childDied]] as const) {
    assert.equal(bad.ok, false, name);
    const w = world(withNext());
    await w.start().checkNow();
    const before = { models: w.file().models, dropped: w.file().dropped };
    w.load();
    const list = offered();

    w.update(bad);
    await w.start().checkNow();
    assert.deepEqual({ models: w.file().models, dropped: w.file().dropped }, before, `${name}: nothing added or removed`);
    w.load();
    assert.deepEqual(offered(), list, `${name}: the same list`);
    assert.equal(claudeTableStatus(w.root).readable, false, `${name}: Settings has its line to show`);

    w.update(withNext());
    await w.start().checkNow();
    assert.equal(claudeTableStatus(w.root).readable, true, `${name}: the line goes at the next good read`);
  }
});

test("no claude program: no line in Settings, the remembered list still stands, nothing is sent", async () => {
  const w = world(withNext());
  await w.start().checkNow();
  w.load();
  const list = offered();
  w.update({ ok: false, reason: "layout changed" });
  await w.start().checkNow();
  assert.equal(claudeTableStatus(w.root).readable, false, "the case this test clears");

  w.missing = true;
  const sent = w.probes.length;
  const reads = w.reads;
  await w.start().checkNow();
  assert.equal(claudeTableStatus(w.root).readable, true);
  assert.equal(w.reads, reads);
  assert.equal(w.probes.length, sent);
  w.load();
  assert.deepEqual(offered(), list);
});

test("no claude program and no store: the built-in list, and no line", async () => {
  const w = world(withNext());
  w.missing = true;
  await w.start().checkNow();
  w.load();
  assert.deepEqual(claudeOffer(), CLAUDE_MODELS);
  assert.equal(claudeTableStatus(w.root).readable, true);
});

test("switched off: the table isn't read and nothing is sent, and the list it has still applies", async () => {
  const w = world(withNext());
  await w.start().checkNow();
  w.load();
  const list = offered();
  const [reads, sent] = [w.reads, w.probes.length];
  w.enabled = false;
  w.update(parsed(newest.rows, newest.latestPerFamily));
  await w.start().checkNow();
  assert.deepEqual([w.reads, w.probes.length], [reads, sent]);
  w.load();
  assert.deepEqual(offered(), list);
});

test("a model the table stops listing leaves the pickers and nothing else, and comes back when listed", async () => {
  const w = world(withNext());
  w.answer = () => ({ ok: true });
  await w.start().checkNow();
  w.load();
  assert.ok(offered().includes(FABLE_NEXT));
  const name = claudeName(FABLE_NEXT);

  const without = newest.rows.filter((r) => idOf(r) !== "claude-opus-4-6");
  // Fable 9.1's row is gone and a newer Fable took over; the built-in Opus 4.6 is gone too.
  const later = "claude-fable-9-2";
  w.update(parsed([...without, rowFor(later)], latestOf({ fable: later })));
  await w.start().checkNow();
  w.load();
  for (const id of [FABLE_NEXT, "claude-opus-4-6"]) {
    assert.ok(!offered().includes(id), `${id} out of the pickers`);
    assert.equal(resolveClaude(id)?.id, id, `${id} still resolves`);
    assert.ok(claudeName(id), `${id} keeps a name`);
    assert.equal(unverifiedClaudeNote(id), undefined, `${id}: no "not verified" on a saved choice`);
  }
  assert.equal(claudeName(FABLE_NEXT), name);

  w.update(withNext());
  await w.start().checkNow();
  w.load();
  assert.ok(offered().includes(FABLE_NEXT), "listed again: back in the pickers");
  assert.ok(offered().includes("claude-opus-4-6"));
});

test("an older Claude Code's table is a full table too: what it lacks leaves the pickers, built in or learned", async () => {
  const w = world(withNext());
  await w.start().checkNow();
  w.load();
  assert.ok(offered().includes(FABLE_NEXT));
  // Older than Sova: no row at or above the built-in Fable.
  const seedCurrent = latestClaude("fable").id === FABLE_NEXT ? CLAUDE_MODELS.find((m) => m.family === "fable" && m.status === "current")!.id : latestClaude("fable").id;
  const rows = newest.rows.filter((r) => !/^claude-fable-5-/.test(idOf(r)));
  w.update(parsed(rows, latestOf({ fable: "claude-fable-5" })));
  await w.start().checkNow();
  w.load();
  for (const id of [FABLE_NEXT, seedCurrent]) {
    assert.ok(!offered().includes(id), `${id}: the table no longer lists it`);
    assert.equal(resolveClaude(id)?.id, id, `${id} still resolves`);
    assert.equal(unverifiedClaudeNote(id), undefined, id);
  }
  assert.equal(latestClaude("fable").id, "claude-fable-5", "the default falls to the newest offered built-in");
});

test("adoption stops at the table's own latest for the family", () => {
  const p = parsed([...newest.rows, rowFor(FABLE_NEXT), rowFor("claude-fable-9-2")], latestOf({ fable: FABLE_NEXT }));
  assert.ok(p.ok);
  const ids = offerFromTable(p.table, null).models.map((m) => m.id);
  assert.ok(ids.includes(FABLE_NEXT), "up to and including the latest");
  assert.ok(!ids.includes("claude-fable-9-2"), "a row past it isn't adopted");
});

test("a family comes in only through its latest_per_family entry", () => {
  const rows = [...newest.rows, rowFor("claude-nova-1-1"), rowFor("claude-nova-1-2")];
  const named = parsed(rows, latestOf({ nova: "claude-nova-1-2" }));
  const unnamed = parsed(rows, newest.latestPerFamily);
  assert.ok(named.ok && unnamed.ok);
  assert.deepEqual(offerFromTable(named.table, null).models.map((m) => m.id).filter((id) => id.includes("nova")), ["claude-nova-1-2"], "its latest only");
  assert.deepEqual(offerFromTable(unnamed.table, null).models.map((m) => m.id).filter((id) => id.includes("nova")), [], "rows alone bring no family in");
});

test("versions compare as numbers, and a zero minor is the same version", () => {
  const adopted = (over: string[], latest: string) => {
    const p = parsed([...newest.rows, ...over.map((id) => rowFor(id))], latestOf({ fable: latest }));
    assert.ok(p.ok, latest);
    return offerFromTable(p.table, null).models.map((m) => m.id).filter((id) => over.includes(id));
  };
  assert.deepEqual(adopted(["claude-fable-5-9", "claude-fable-5-10"], "claude-fable-5-10").sort(), ["claude-fable-5-10", "claude-fable-5-9"], "5-10 is newer than 5-9");
  assert.deepEqual(adopted(["claude-fable-5-9", "claude-fable-5-10"], "claude-fable-5-9"), ["claude-fable-5-9"], "and 5-10 is past a latest of 5-9");
  assert.equal(compareClaudeVersions("5", "5.0"), 0);
  assert.equal(parseClaudeId("claude-fable-5-0")?.version, "5", "5-0 reads as 5");
  assert.ok(compareClaudeVersions("5.10", "5.9") > 0);
});

test("a latest value that is an old-order id brings nothing in and takes nothing away", async () => {
  const w = world(parsed(newest.rows, latestOf({ sonnet: "claude-3-5-sonnet" })));
  await w.start().checkNow();
  w.load();
  assert.deepEqual(offered().filter((id) => /^claude-\d/.test(id)), []);
  for (const m of CLAUDE_MODELS) assert.ok(offered().includes(m.id), m.id);
});

test("a latest value that isn't a plain row: read as its row, or the table counts as unread", async () => {
  for (const [form, value] of [["dated", `${FABLE_NEXT}-20270101`], ["[1m]", `${FABLE_NEXT}[1m]`]] as const) {
    const w = world(parsed([...newest.rows, rowFor(FABLE_NEXT)], latestOf({ fable: value })));
    await w.start().checkNow();
    w.load();
    assert.ok(offered().includes(FABLE_NEXT), `${form}: its row is adopted`);
    assert.deepEqual(offered().filter((id) => id !== FABLE_NEXT && id.startsWith(FABLE_NEXT)), [], `${form}: never the written form`);
    mergeClaudeCatalog({ models: [] });
  }
  for (const [what, value] of [["a dated form of no row", "claude-fable-10-20270101"], ["no row and no standard id", "claude-nova"]] as const) {
    const w = world(withNext());
    await w.start().checkNow();
    w.load();
    const list = offered();
    w.update(parsed(newest.rows, latestOf({ fable: value })));
    await w.start().checkNow();
    w.load();
    assert.deepEqual(offered(), list, `${what}: the last good list`);
    assert.equal(claudeTableStatus(w.root).readable, false, `${what}: counted as unread`);
    mergeClaudeCatalog({ models: [] });
  }
});

test("a table model Sova doesn't offer, typed by hand, counts as unknown", async () => {
  const w = world(parsed(newest.rows, newest.latestPerFamily));
  await w.start().checkNow();
  w.load();
  for (const id of ["claude-mythos-5", "claude-mythos-5-2"]) {
    assert.equal(claudeModel(id), undefined, id);
    assert.equal(claudeContextWindow(id), CLAUDE_DEFAULT_WINDOW, `${id}: the table says 1M, Sova doesn't offer it`);
    assert.ok(unverifiedClaudeNote(id), id);
    assert.equal(claudeName(id), id === "claude-mythos-5" ? "Mythos 5" : "Mythos 5.2", "named by the rule all the same");
  }
});

test("the table's fields reach a built-in entry through a read", async () => {
  const id = "claude-haiku-4-5";
  const row = newest.rows.find((r) => idOf(r) === id)!.replace("max_output_tokens:{default:32000", "max_output_tokens:{default:12345").replace("context:{window:200000", "context:{window:300000").replace("claude-haiku-4-5-20251001", "claude-haiku-4-5-20270101").replace(/capabilities:\[/, 'capabilities:["effort",');
  const w = world(parsed(newest.rows.map((r) => (idOf(r) === id ? row : r)), newest.latestPerFamily));
  await w.start().checkNow();
  w.load();
  const m = claudeModel(id)!;
  assert.deepEqual([m.window, m.maxOutput, [...m.efforts], m.apiIds.includes("claude-haiku-4-5-20270101")], [300_000, 12_345, ["low", "medium", "high"], true]);
});

test("a brand-new family appears, its latest only, with a default once it has passed", async () => {
  const w = world(parsed([...newest.rows, rowFor("claude-nova-1-1"), rowFor("claude-nova-1-2")], latestOf({ nova: "claude-nova-1-2" })));
  w.answer = () => ({ ok: false, reason: "expired" });
  await w.start().checkNow();
  w.load();
  assert.ok(offered().includes("claude-nova-1-2"));
  assert.ok(!offered().includes("claude-nova-1-1"));
  assert.equal(claudeName("claude-nova-1-2"), "Nova 1.2");
  assert.equal(latestClaude("nova"), undefined);
  w.answer = () => ({ ok: true });
  await w.start().checkNow();
  w.load();
  assert.equal(latestClaude("nova")?.id, "claude-nova-1-2");
});

test("restarts with the store present: the same list, ready before any read, read once per start, and no new test", async () => {
  const w = world(withNext());
  await w.start().checkNow();
  w.load();
  const list = JSON.stringify(claudeOffer());
  const sent = w.probes.length;
  const reads = w.reads;
  assert.ok(sent > 0, "the passes this test keeps");
  for (let i = 0; i < 2; i++) {
    mergeClaudeCatalog({ models: [] }); // a new process starts with only the seed
    w.load();
    assert.equal(JSON.stringify(claudeOffer()), list, `restart ${i}: ready before any read`);
    await w.start().checkNow();
    w.load();
    assert.equal(JSON.stringify(claudeOffer()), list, `restart ${i}`);
    assert.equal(w.reads, reads + i + 1, `restart ${i}: read at the start, though the program file is unchanged`);
  }
  assert.equal(w.probes.length, sent);
});

test("a changed claude program reaches a running Sova with no restart", async () => {
  const w = world(parsed(newest.rows, newest.latestPerFamily));
  const check = w.start();
  await check.checkNow();
  w.load();
  assert.ok(!offered().includes(FABLE_NEXT));
  await check.checkNow();
  assert.equal(w.reads, 1, "an unchanged program isn't read again");

  w.update(withNext());
  await check.checkNow();
  assert.equal(w.reads, 2);
  assert.equal(w.load(), true, "the change is reported to whoever redraws");
  assert.ok(offered().includes(FABLE_NEXT));
  assert.equal(w.load(), false, "and only once");
});

test("a failed test keeps the defaults; it is retried only at the next read of the table", async () => {
  const w = world(withNext());
  w.answer = () => ({ ok: false, reason: "Failed to authenticate: OAuth session expired" });
  const check = w.start();
  await check.checkNow();
  const once = w.probes.filter((id) => id === FABLE_NEXT).length;
  assert.equal(once, 1, "one test, once");
  w.load();
  assert.ok(offered().includes(FABLE_NEXT), "still in the pickers");
  assert.notEqual(latestClaude("fable").id, FABLE_NEXT, "the expired login blocks the default move");
  assert.equal(w.file().tested?.includes(FABLE_NEXT) ?? false, false);

  // The timer's plain looks at an unchanged program, however long it runs: no read, so no retry.
  for (const hours of [1, 6, 48]) {
    w.time += hours * 3_600_000;
    await check.checkNow();
    assert.equal(w.probes.filter((id) => id === FABLE_NEXT).length, once, `${hours} h later, no table read happened`);
  }

  // Sova's start: the next read, even minutes after the failure.
  const startup = w.start();
  await startup.checkNow();
  assert.equal(w.probes.filter((id) => id === FABLE_NEXT).length, once + 1, "retried at the next start");

  // A change of the program: the next read, even right away.
  w.update(withNext());
  await startup.checkNow();
  assert.equal(w.probes.filter((id) => id === FABLE_NEXT).length, once + 2, "retried at the next change of claude");
});

test("a pass is remembered across restarts and that model is never tested again", async () => {
  const w = world(withNext());
  await w.start().checkNow();
  w.load();
  assert.equal(latestClaude("fable").id, FABLE_NEXT, "the default moves on a pass");
  assert.ok(w.file().tested?.includes(FABLE_NEXT));
  const sent = w.probes.filter((id) => id === FABLE_NEXT).length;
  assert.equal(sent, 1);
  await w.start().checkNow();
  w.update(withNext());
  await w.start().checkNow();
  assert.equal(w.probes.filter((id) => id === FABLE_NEXT).length, sent);
});

test("each learned model is tested, not only the table's latest; a built-in one never", async () => {
  const older = "claude-fable-9-0";
  const w = world(parsed([...newest.rows, rowFor(older), rowFor(FABLE_NEXT)], latestOf({ fable: FABLE_NEXT })));
  w.answer = (id) => (id === FABLE_NEXT ? { ok: false, reason: "no access yet" } : { ok: true });
  await w.start().checkNow();
  w.load();
  assert.ok(w.probes.includes(older), `tested: ${w.probes.join(", ")}`);
  assert.ok(w.probes.includes(FABLE_NEXT));
  assert.deepEqual(w.probes.filter((id) => seedIds.has(id)), [], "built-in entries need no test");
  assert.equal(latestClaude("fable").id, older, "the default follows the newest that passed");
});

test("what counts as a pass: a reply without an error, from that model", () => {
  const id = "claude-fable-5-2";
  const env = (o: object) => JSON.stringify({ is_error: false, result: "OK", ...o });
  for (const [out, pass, why] of [
    [env({ modelUsage: { [id]: {} } }), true, "that model"],
    [env({ modelUsage: { [`${id}-20270101`]: {} } }), true, "that model, under its dated id"],
    [env({ modelUsage: { [`${id}[1m]`]: {} } }), true, "that model, under its 1M label"],
    [env({ modelUsage: { "claude-opus-5-5": {} } }), false, "another model"],
    [env({ modelUsage: {} }), false, "nothing says which model answered"],
    [env({}), false, "nothing says which model answered"],
    [JSON.stringify({ is_error: true, result: "Failed to authenticate: OAuth session expired", modelUsage: { [id]: {} } }), false, "an error"],
    [env({ result: "", modelUsage: { [id]: {} } }), false, "no answer"],
    ["", false, "no output at all"],
    ["not json", false, "not an envelope"],
  ] as const) assert.equal(judgeProbe(out, id).ok, pass, why);
});
