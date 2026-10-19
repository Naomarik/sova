// Run: pnpm test -- server/commands-settings.test.ts
// The settings, models, usage and health sweep (§app/settings-commands) against the real app,
// in-process: each entry's request gets exactly the answer the web app's own request to that route
// gets, on the same state, refusals word for word, and an entry that changes something changes it as
// the route does. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written. Nothing here
// starts a chat, the usage helper or the claude CLI, and nothing reaches the network.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildRequest, COMMANDS, findCommand } from "../shared/commands-catalog";
import { OTHER_ENTRIES } from "../shared/commands/other";
import { scratchRoot } from "./test-scratch";

const agentDir = scratchRoot("sova-commands-settings-");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-commands-settings--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const work = join(agentDir, "work");
mkdirSync(join(work, "sub"), { recursive: true });
writeFileSync(join(work, "a.txt"), "a\n");

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { canonicalPath } = await import("./paths");
// The usage routes ask the usage helper; here the in-process ledger answers, prices off (no network).
const { setUsageAsker } = await import("./usage-helper/client");
const { BadRequest, createService } = await import("./usage-helper/service");
const svc = createService({ usageRoot: join(agentDir, "usage", "v1"), stateDir: join(agentDir, "sova", "usage-ledger"), pricesPath: join(agentDir, "sova", "model-prices.json"), log: () => {}, prices: { enabled: false } });
setUsageAsker(async (op, params) => {
  try {
    return { status: 200, body: Buffer.from(JSON.stringify(await svc.answer({ ...params, op }))) };
  } catch (err) {
    return err instanceof BadRequest ? { status: 400, body: Buffer.from(JSON.stringify({ error: err.message })) } : { status: 500, body: Buffer.from(JSON.stringify({ error: "usage-helper-failed" })) };
  }
});
after(() => {
  setUsageAsker(null);
  rmSync(agentDir, { recursive: true, force: true });
});

async function send(method: string, url: string, body?: unknown): Promise<[number, unknown]> {
  const res = await app.request(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  return [res.status, await res.json()];
}
const viaId = (id: string, values: Record<string, unknown>) => {
  const r = buildRequest(findCommand(id)!, values);
  return send(r.method, r.url, r.body);
};
const q = (p: string) => encodeURIComponent(p);
/** An answer with its clocks (`at`, `checkedAt`, `generatedAt`, `asOf`) taken out: the moment it answered. */
const timeless = ([s, b]: [number, unknown]) => [s, JSON.parse(JSON.stringify(b, (k, v) => (["at", "checkedAt", "generatedAt", "asOf"].includes(k) ? undefined : v)))];

function session(): string {
  const path = join(sessionsDir, "2026-10-17T00-00-00-000Z_settings-1.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "settings-1", timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" })}\n`);
  return canonicalPath(path);
}

describe("the area", () => {
  test("every entry here is in COMMANDS, and nothing that grants power or reveals a secret is", () => {
    for (const c of OTHER_ENTRIES) assert.ok(COMMANDS.includes(c), c.id);
    const writes = OTHER_ENTRIES.filter((c) => c.id.startsWith("settings.") && c.effect === "changes").map((c) => c.id).sort();
    assert.deepEqual(writes, ["settings.align.set"]);
    const forbidden = /\/api\/(profiles|schedules|claude|auth|settings\/decisions|settings\/claude-status)(\/|$)|approve|login/;
    for (const c of COMMANDS) assert.doesNotMatch(c.route.path, forbidden, c.id);
  });
});

describe("answers: the route's own, on the same state", () => {
  test("reads answer as their route does", async () => {
    const path = session();
    const reads: [string, Record<string, unknown>, string][] = [
      ["targets.list", {}, "/api/targets"],
      ["folders.list", { path: work }, `/api/folders?path=${q(work)}`],
      ["cwds.list", {}, "/api/cwds"],
      ["files.list", { cwd: work }, `/api/files?cwd=${q(work)}`],
      ["usage.costs", { range: "7d", tz: "UTC" }, "/api/usage/costs?range=7d&tz=UTC"],
      ["usage.performance", {}, "/api/usage/performance"],
      ["usage.today", { tz: "UTC" }, "/api/usage/today?tz=UTC"],
      ["usage.session", { sid: "settings-1" }, "/api/usage/session?sid=settings-1"],
      ["usage.prices", {}, "/api/usage/prices"],
      ["insights.usage", {}, "/api/insights/usage"],
      ["insights.usage.history", { series: "s", window: "5h" }, "/api/insights/usage/history?series=s&window=5h"],
      ["insights.agents", {}, "/api/insights/agents"],
      ["insights.worktrees", { paths: [path] }, `/api/insights/worktrees?paths=${q(path)}`],
      ["insights.session.workers", { session: path }, `/api/insights/session/workers?path=${q(path)}`],
      ["sova.health", {}, "/api/health"],
      ...["sova", "models", "provider-limits", "align", "delegate", "spec", "team", "summarizer", "overseer", "memory", "subagents"].map(
        (d) => [`settings.${d}.get`, {}, d === "sova" ? "/api/settings" : `/api/settings/${d}`] as [string, Record<string, unknown>, string],
      ),
    ];
    for (const [id, values, route] of reads) {
      const got = await viaId(id, values);
      assert.equal(got[0], 200, `${id}: ${JSON.stringify(got[1]).slice(0, 200)}`);
      assert.deepEqual(timeless(got), timeless(await send("GET", route)), id);
    }
    const [s, sessions] = await viaId("usage.sessions", { sids: ["settings-1"] });
    assert.deepEqual(timeless([s, sessions]), timeless(await send("POST", "/api/usage/sessions", { sids: ["settings-1"] })));
  });

  test("refusals are the route's own, word for word", async () => {
    assert.deepEqual(await viaId("folders.list", { path: join(work, "nope") }), await send("GET", `/api/folders?path=${q(join(work, "nope"))}`));
    assert.equal((await viaId("folders.list", { path: join(work, "nope") }))[0] >= 400, true);
    assert.deepEqual(await viaId("insights.session.workers", { session: join(sessionsDir, "missing.jsonl") }), [404, { error: "Session file not found" }]);
    assert.deepEqual(await viaId("usage.sessions", { sids: 7 }), [400, { error: "sids must be a list" }]);
    assert.deepEqual(await viaId("models.favorite", { ref: "nope", favorite: true }), [400, { error: "Not a provider/id model ref: nope" }]);
    assert.deepEqual(await viaId("settings.align.set", { style: 7 }), await send("PUT", "/api/settings/align", { style: 7, version: 1 }));
    assert.equal((await viaId("settings.align.set", { style: 7 }))[0], 400);
    // No contact address saved: the Send Test button's own refusal, before any device is reached.
    assert.deepEqual(await viaId("push.test", {}), await send("POST", "/api/push/test", {}));
    assert.equal((await viaId("push.test", {}))[0], 409);
  });

  test("models.favorite stars and unstars, in the picker's own store", async () => {
    assert.equal((await viaId("models.favorite", { ref: "zai/glm-5.3", favorite: true }))[0], 200);
    assert.match(readFileSync(join(agentDir, "model-favorites.json"), "utf8"), /glm-5\.3/);
    assert.equal((await viaId("models.favorite", { ref: "zai/glm-5.3", favorite: false }))[0], 200);
    assert.doesNotMatch(readFileSync(join(agentDir, "model-favorites.json"), "utf8"), /glm-5\.3/);
  });

  test("settings.align.set saves what Settings → Alignment saves, read back", async () => {
    const [s, saved] = await viaId("settings.align.set", { style: "default", visuals: true });
    assert.equal(s, 200, JSON.stringify(saved));
    assert.deepEqual((await send("GET", "/api/settings/align"))[1], saved);
    assert.equal((saved as { settings: { visuals: boolean } }).settings.visuals, true);
  });
});
