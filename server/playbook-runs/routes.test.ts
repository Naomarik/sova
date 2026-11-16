// The playbook card's routes in process: a card opens as a run of its own, edits save against the revision
// shown, a stale one is refused with the card as it is now, Start is the person's own click only, and the
// store reads back after a restart.
import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { PlaybookRunView } from "../../shared/playbook-run";

const { mountPlaybookRunRoutes } = await import("./routes");
const store = await import("./store");
const { PLAYBOOK_RUN_EVENT } = await import("../../shared/playbook-run");
const { onPlaybookRunNews } = await import("./news");

after(() => dropScratchAgentDir());

// A playbook of the user's own, with a description.
const pb = join(scratchAgentDir, "sova", "playbooks", "trial");
mkdirSync(join(pb, "roles"), { recursive: true });
writeFileSync(join(pb, "PLAYBOOK.md"), "---\ntitle: Trial\ndescription: A trial playbook\n---\nConduct the trial.\n");
writeFileSync(join(pb, "roles", "helper.md"), "Look at {{topic}}.\n");
writeFileSync(
  join(pb, "playbook.json"),
  JSON.stringify({
    version: 1,
    inputs: [
      { id: "topic", label: "Topic", type: "text", ask: "always", required: true },
      { id: "level", label: "Level", type: "choice", ask: "always", required: true, options: [{ id: "lo", label: "Low" }, { id: "hi", label: "High" }], default: "lo" },
    ],
    roles: { main: { label: "Main chat" }, helper: { label: "Helper", prompt: "roles/helper.md", kind: "routine", optional: true } },
    steps: [{ id: "look", label: "Look", roles: ["main", "helper"], stop: "optional" }],
  }),
);
// A chat to show the card in.
const chatPath = join(scratchAgentDir, "sessions", "--proj--", "2026-11-16T00-00-00-000Z_chat-a.jsonl");
mkdirSync(join(chatPath, ".."), { recursive: true });
writeFileSync(chatPath, `${JSON.stringify({ type: "session", version: 3, id: "chat-a", timestamp: "2026-11-16T00:00:00.000Z", cwd: scratchAgentDir })}\n`);

const app = new Hono();
mountPlaybookRunRoutes(app, { contents: () => [] });
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });

async function open(): Promise<PlaybookRunView> {
  const res = await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "trial" }, cwd: scratchAgentDir, path: chatPath, text: "about the parser" }));
  assert.ok(res.status === 201 || res.status === 200, `open answered ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as PlaybookRunView;
}

describe("a playbook card", () => {
  test("opens as a draft run of its own, with its choices' origins and Start off until a required choice is filled", async () => {
    const v = await open();
    assert.match(v.id, /^pr_[a-z0-9]{12}$/);
    assert.equal(v.state, "draft");
    assert.equal(v.revision, 1);
    assert.deepEqual(v.choices.map((c) => [c.id, c.value, c.origin]), [["topic", null, "default"], ["level", "lo", "default"]]);
    assert.equal(v.startBlocked, "Fill in Topic first.");
    // Opening it again in the same chat gives the same draft.
    assert.equal((await open()).id, v.id);
  });

  test("an edit saves against the revision shown; a stale revision is refused with the card as it is", async () => {
    const v = await open();
    const res = await app.request(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { topic: "parsing" }, roles: { helper: { on: true, note: "Be brief." } }, stops: { look: false } } }));
    assert.equal(res.status, 200);
    const next = (await res.json()) as PlaybookRunView;
    assert.equal(next.revision, v.revision + 1);
    assert.equal(next.choices[0]!.origin, "you");
    const helper = next.roles.find((r) => r.id === "helper")!;
    assert.equal(helper.on, true);
    assert.equal(helper.prompt, "Look at parsing.\n\nNote for this run: Be brief.\n");
    assert.equal(next.steps[0]!.stopOn, false);
    const stale = await app.request(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { topic: "other" } } }));
    assert.equal(stale.status, 409);
    const body = (await stale.json()) as { error: string; run: PlaybookRunView };
    assert.equal(body.run.revision, next.revision);
    assert.equal(body.run.choices[0]!.value, "parsing");
  });

  test("edits naming what the playbook lacks are refused, saying what", async () => {
    const v = await open();
    for (const [edits, want] of [
      [{ choices: { nope: "x" } }, /no choice "nope"/],
      [{ roles: { ghost: { on: true } } }, /no role "ghost"/],
      [{ roles: { main: { on: false } } }, /can't be turned off/],
      [{ stops: { look: "yes" } }, /must be true or false/],
      [{ cycle: { max: 2 } }, /no cycle/],
      [{ choices: { level: 3 } }, /isn't a choice value/],
    ] as const) {
      const res = await app.request(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits }));
      assert.equal(res.status, 400, JSON.stringify(edits));
      assert.match(((await res.json()) as { error: string }).error, want);
    }
  });

  test("Start is the person's own click only: a script's call starts nothing", async () => {
    const v = await open();
    const res = await app.request(`/api/playbook-runs/${v.id}/start`, json({ revision: v.revision }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Only the user starts a playbook run. Ask them to press Start on its card in Sova's page. Nothing was started.", yourClick: true });
    assert.equal(store.runById(v.id)!.state, "draft");
  });

  test("the chat's cards list it, its news reaches the chat, and a closed draft leaves the list", async () => {
    const v = await open();
    const heard: { sessionId: string; type: string; id: string; closed?: boolean }[] = [];
    const off = onPlaybookRunNews((n) => heard.push({ sessionId: n.sessionId, type: n.event.type, id: (n.event.run as PlaybookRunView).id, ...((n.event.run as PlaybookRunView).closed ? { closed: true } : {}) }));
    const listed = (await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(chatPath)}`)).json()) as { runs: PlaybookRunView[] };
    assert.ok(listed.runs.some((r) => r.id === v.id));
    assert.equal((await app.request(`/api/playbook-runs/${v.id}`, { method: "DELETE" })).status, 200);
    const after = (await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(chatPath)}`)).json()) as { runs: PlaybookRunView[] };
    assert.ok(!after.runs.some((r) => r.id === v.id));
    await new Promise((r) => setTimeout(r, 300));
    off();
    assert.deepEqual(heard.at(-1), { sessionId: "chat-a", type: PLAYBOOK_RUN_EVENT, id: v.id, closed: true });
  });

  test("Save as My Defaults gives the next card those values, marked as your standing answer", async () => {
    const v = await open();
    const edited = (await (await app.request(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { level: "hi" } } }))).json()) as PlaybookRunView;
    assert.equal((await app.request(`/api/playbook-runs/${v.id}/defaults`, json({ revision: edited.revision }))).status, 200);
    await app.request(`/api/playbook-runs/${v.id}`, { method: "DELETE" });
    const next = await open();
    assert.notEqual(next.id, v.id);
    assert.deepEqual(next.choices.find((c) => c.id === "level")!, { ...next.choices.find((c) => c.id === "level")!, value: "hi", origin: "standing" });
  });

  test("a run reads back after a restart; one stopped while starting is a draft again, saying so", async () => {
    const v = await open();
    store.changeRun(v.id, (r) => {
      r.state = "starting";
    });
    store.forgetPlaybookRuns();
    const back = store.runById(v.id)!;
    assert.equal(back.state, "draft");
    assert.match(back.startError ?? "", /Sova stopped while this run was starting/);
  });
});
