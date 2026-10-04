// Run: pnpm exec tsx --test server/statechart-migration.test.ts. The one-time move to the statechart
// names (§app.organizations/statechart-migration): an org a master build wrote (fixtures/statechart-migration:
// `charts/`, `org-charts/<org>` with a pending journal, the old snapshot keys, rows' `chart`, the actor
// "chart") moves once at server start, then opens and acts on the new bundle; a second run does nothing;
// the old and the new name together are refused. Throwaway PI_CODING_AGENT_DIR and repos; ~/.pi is never touched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-sc-migrate-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const FIXTURE = join(import.meta.dirname, "fixtures", "statechart-migration");
const ORG = "org_fv6duzwx";
const PROJECT = "prj_vf7kedf7";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** Copy the fixture's old layout to `ws` and `state`, its placeholders filled; `ws` is a repo with it committed. */
function oldLayout(ws: string, state: string, proj: string): void {
  cpSync(join(FIXTURE, "ws"), ws, { recursive: true });
  cpSync(join(FIXTURE, "state"), state, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(ws, "sessions"), { recursive: true });
  writeFileSync(join(ws, "sessions", ".gitkeep"), "");
  const fill = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) fill(f);
      else writeFileSync(f, readFileSync(f, "utf8").replaceAll("@PROJ@", proj).replaceAll("@WS@", ws));
    }
  };
  fill(ws);
  fill(state);
  git(ws, "init", "-q", "-b", "main");
  git(ws, "add", "-A");
  git(ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "old layout");
}

/** Every file's text under `dir`. */
function texts(dir: string): string {
  let out = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    out += e.isDirectory() ? texts(f) : readFileSync(f, "utf8");
  }
  return out;
}

const OLD_MARKS = [":sova.org-charts.", ":chart ", ":chart-key", "sova.charts/", '"chart":', '"by":"chart"', ':by "chart"'];

const m = await import("./statechart-migration");

describe("the snapshot and row rewrite", () => {
  test("EDN: the old keys, the actor and old names in strings; other strings, chars and comments as they are; a migrated text maps to itself", () => {
    const old = `{:sova.org-charts.engine.core/format 1, :chart "person", :wmem {:sova.charts/sends [], :by "chart", "by" "chart", :why ":chart is text", :c \\c, :k :sova.org-charts.charts.base/x, :ev :sova.charts/flush, :who {:by {:kind "operator"}}, :s "sova.charts/flush", :note "chart"} ; :chart\n :chart-key "k"}`;
    const want = `{:sova.statecharts.engine.core/format 1, :statechart "person", :wmem {:sova.statecharts/sends [], :by "statechart", "by" "statechart", :why ":chart is text", :c \\c, :k :sova.statecharts.base/x, :ev :sova.statecharts/flush, :who {:by {:kind "operator"}}, :s "sova.statecharts/flush", :note "chart"} ; :chart\n :statechart-key "k"}`;
    assert.equal(m.migrateEdn(old), want);
    assert.equal(m.migrateEdn(want), want);
  });

  test("a row: `chart` → `statechart` in place, every actor and old name, nothing else", () => {
    const row = { at: 1, session: "p/1", chart: "item", event: "sova.charts/flush", by: "chart", envelope: { by: "chart", note: "chart" }, changed: { "sova.charts/sends": [[], null] } };
    const got = m.migrateRow(row);
    assert.deepEqual(Object.keys(got), ["at", "session", "statechart", "event", "by", "envelope", "changed"]);
    assert.deepEqual(got, { at: 1, session: "p/1", statechart: "item", event: "sova.statecharts/flush", by: "statechart", envelope: { by: "statechart", note: "chart" }, changed: { "sova.statecharts/sends": [[], null] } });
    assert.deepEqual(m.migrateRow(got), got);
  });
});

describe("an org a master build wrote", async () => {
  const ws = join(root, "ws");
  const state = join(agentDir, "sova");
  oldLayout(ws, state, join(root, "proj"));
  writeFileSync(join(state, "orgs.json"), JSON.stringify({ version: 1, operator: { name: "Operator" }, orgs: [{ id: ORG, dir: ws, attachedAt: "2026-09-30T00:00:00.000Z" }] }));
  const oldHead = git(ws, "rev-parse", "HEAD");

  const orgs = await import("./orgs");
  const { hostOf, closeOrgHost } = await import("./org-engine");
  const { settled } = await import("./workspace-git");
  await orgs.openAttachedOrgs();
  after(async () => {
    await closeOrgHost(ORG).catch(() => {});
    await settled(ws);
  });

  test("moves once at start, before the org opens: both folders, one commit, no old name left", () => {
    assert.ok(!existsSync(join(ws, "charts")) && statSync(join(ws, "statecharts")).isDirectory());
    assert.ok(!existsSync(join(state, "org-charts")) && statSync(join(state, "statecharts", ORG)).isDirectory());
    assert.equal(git(ws, "log", "-1", "--format=%s"), m.MIGRATION_MESSAGE);
    assert.equal(git(ws, "rev-parse", "HEAD~1"), oldHead);
    assert.equal(git(ws, "ls-files", "--", "charts"), "");
    assert.equal(git(ws, "show", "--stat", "--format=", "HEAD").includes("statecharts/org/"), true);
    for (const dir of [join(ws, "statecharts"), join(state, "statecharts", ORG)]) {
      const all = texts(dir);
      for (const mark of OLD_MARKS) assert.ok(!all.includes(mark), `${dir} still has ${mark}`);
    }
  });

  test("the pending journal replayed on the new paths and keys", () => {
    assert.deepEqual(readdirSync(join(state, "statecharts", ORG, "journal")), []);
    assert.deepEqual(
      orgs.readRoster(ORG).map((p) => p.name),
      ["Ana Journal"],
    );
    const rows = readFileSync(join(ws, "statecharts", "log", "2026-09.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const replayed = rows.find((r) => r.j === "001790796500000-1-000001")!;
    assert.equal(replayed.statechart, "person");
    assert.equal(replayed.by, "statechart");
    assert.equal(replayed.event, "sova.statecharts/flush");
  });

  test("the org opens and acts on the new bundle; new rows carry `statechart`", async () => {
    assert.equal(orgs.readOrg(ORG).name, "Old Layout");
    const before = hostOf(ORG).statechartOf(`project/${ORG}/${PROJECT}`);
    assert.equal(before, "project");
    await orgs.addPerson(ORG, { name: "Bo New", role: "Engineer" } as never);
    assert.deepEqual(orgs.readRoster(ORG).map((x) => x.name).sort(), ["Ana Journal", "Bo New"]);
    const last = readFileSync(join(ws, "statecharts", "log", "2026-09.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).at(-1)!;
    assert.equal(last.statechart, "person", "Bo New's");
    assert.ok(!("chart" in last));
  });

  test("a second run does nothing", async () => {
    const head = git(ws, "rev-parse", "HEAD");
    const again = await m.migrateOrg(ORG, ws, state);
    assert.deepEqual(again, { moved: [], rewritten: 0, committed: false });
    assert.equal(git(ws, "rev-parse", "HEAD"), head);
  });
});

describe("refusals and a run cut short", () => {
  test("the old and the new workspace folder together: refused, nothing changes", async () => {
    const ws = join(root, "both-ws");
    const state = join(root, "both-state");
    oldLayout(ws, state, join(root, "both-proj"));
    mkdirSync(join(ws, "statecharts"));
    await assert.rejects(() => m.migrateOrg(ORG, ws, state), (err: Error) => err instanceof m.StatechartMigrationError && err.message.includes(join(ws, "charts")) && err.message.includes(join(ws, "statecharts")));
    assert.ok(existsSync(join(ws, "charts", "org")) && existsSync(join(state, "org-charts", ORG, "journal")), "neither step ran");
    assert.ok(texts(join(ws, "charts")).includes(":sova.org-charts."), "nothing rewritten");
  });

  test("both host-local folders: refused before the workspace moves", async () => {
    const ws = join(root, "both2-ws");
    const state = join(root, "both2-state");
    oldLayout(ws, state, join(root, "both2-proj"));
    mkdirSync(join(state, "statecharts", ORG), { recursive: true });
    await assert.rejects(() => m.migrateOrg(ORG, ws, state), m.StatechartMigrationError);
    assert.ok(existsSync(join(ws, "charts")) && !existsSync(join(ws, "statecharts")));
  });

  test("the start refuses that org only: it stays closed, the log says why", async () => {
    const { isOrgHostOpen } = await import("./org-engine");
    const orgs = await import("./orgs");
    const ws = join(root, "both3-ws");
    oldLayout(ws, join(root, "both3-state"), join(root, "both3-proj"));
    mkdirSync(join(ws, "statecharts"));
    const index = JSON.parse(readFileSync(join(agentDir, "sova", "orgs.json"), "utf8")) as { orgs: { id: string; dir: string }[] };
    writeFileSync(join(agentDir, "sova", "orgs.json"), JSON.stringify({ ...index, orgs: [...index.orgs, { id: "org_other", dir: ws, attachedAt: "" }] }));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await orgs.openAttachedOrgs();
    } finally {
      console.error = orig;
      writeFileSync(join(agentDir, "sova", "orgs.json"), JSON.stringify(index));
    }
    assert.ok(errors.some((e) => e.includes("org_other") && e.includes("never overwrites")), errors.join("\n"));
    assert.equal(isOrgHostOpen("org_other"), false);
    assert.equal(isOrgHostOpen(ORG), true);
  });

  test("a move renamed but not committed: the next run commits it", async () => {
    const ws = join(root, "cut-ws");
    const state = join(root, "cut-state");
    oldLayout(ws, state, join(root, "cut-proj"));
    renameSync(join(ws, "charts"), join(ws, "statecharts"));
    const r = await m.migrateWorkspace(ws);
    assert.deepEqual(r, { moved: [], rewritten: 0, committed: true });
    assert.equal(git(ws, "log", "-1", "--format=%s"), m.MIGRATION_MESSAGE);
    assert.equal(git(ws, "status", "--porcelain", "--", "charts", "statecharts"), "");
  });
});
