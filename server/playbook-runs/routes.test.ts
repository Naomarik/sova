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
const { AUTH_COOKIE, CALLER_HEADER, sovaToken } = await import("../auth");
const { listSessions } = await import("../sessions-index");

after(() => dropScratchAgentDir());

// A playbook of the user's own, with a description.
const pb = join(scratchAgentDir, "sova", "playbooks", "trial");
mkdirSync(pb, { recursive: true });
writeFileSync(join(pb, "PLAYBOOK.md"), "---\ntitle: Trial\ndescription: A trial playbook\n---\nConduct the trial.\n");
writeFileSync(
  join(pb, "playbook.json"),
  JSON.stringify({
    version: 1,
    inputs: [
      { id: "topic", label: "Topic", type: "text", ask: "always", required: true },
      { id: "level", label: "Level", type: "choice", ask: "always", required: true, options: [{ id: "lo", label: "Low" }, { id: "hi", label: "High" }], default: "lo" },
    ],
    teams: {
      lookers: {
        goal: "Look at {{topic}}",
        members: {
          helper: { label: "Helper", brief: "Looks at {{topic}}", kind: "routine", optional: true, models: [{ model: "zai/glm-5.3", effort: "low" }, { model: "zai/glm-5.2", effort: "low" }] },
          keeper: { label: "Keeper", brief: "Keeps the notes", models: [{ model: "zai/glm-5.3", effort: "low" }] },
        },
      },
    },
    steps: [{ id: "look", label: "Look", teams: ["lookers"], stop: "optional" }],
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
/** The operator's own page: the install's cookie, over a socket of the main listener. */
const asPage = (path: string, init: RequestInit) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: `${AUTH_COOKIE}=${sovaToken()}` } }, { incoming: {} });
/** A chat's own call: its caller key beside the token. */
const asChat = (path: string, init: RequestInit) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), [CALLER_HEADER]: "a-chat", "x-sova-token": sovaToken() } }, { incoming: {} });

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

  test("a model this computer has no sign-in for isn't skipped: only Settings → Models turns one off", async () => {
    const v = await open();
    const helper = v.teams[0]!.members.find((m) => m.id === "helper")!;
    assert.equal(helper.resolved?.model, "zai/glm-5.3");
    assert.equal(helper.models[0]!.usable, true);
    assert.equal(helper.resolved?.reason, undefined);
  });

  test("a model Settings → Models turns off is skipped, and the reason reads in words", async () => {
    const { writeModelPolicy } = await import("../model-policy");
    writeModelPolicy({ disabledProviders: [], disabledModels: ["zai/glm-5.3"], subagentDisabledProviders: [], subagentDisabledModels: [] });
    try {
      const v = await open();
      const helper = ((await (await app.request(`/api/playbook-runs/${v.id}`)).json()) as PlaybookRunView).teams[0]!.members.find((m) => m.id === "helper")!;
      assert.equal(helper.resolved?.model, "zai/glm-5.2");
      assert.equal(helper.resolved?.reason, "Glm-5.3 · z.ai is turned off in Settings → Models, so glm-5.2 · z.ai");
    } finally {
      writeModelPolicy({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] });
    }
  });

  test("an edit saves against the revision shown; a stale revision is refused with the card as it is", async () => {
    const v = await open();
    const res = await asPage(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { topic: "parsing" }, roles: { helper: { on: true, note: "Be brief." } }, teams: { lookers: { note: "Quick look only." } }, stops: { look: false } } }));
    assert.equal(res.status, 200);
    const next = (await res.json()) as PlaybookRunView;
    assert.equal(next.revision, v.revision + 1);
    assert.equal(next.choices[0]!.origin, "you");
    const team = next.teams[0]!;
    const helper = team.members.find((m) => m.id === "helper")!;
    assert.deepEqual([team.goal, team.note, helper.on, helper.brief, helper.note], ["Look at parsing", "Quick look only.", true, "Looks at parsing", "Be brief."]);
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
      [{ roles: { ghost: { on: true } } }, /no member "ghost"/],
      [{ roles: { keeper: { on: false } } }, /Keeper can't be turned off/],
      [{ roles: { helper: { note: "one\ntwo" } } }, /Helper's note must be one line/],
      [{ teams: { ghost: { note: "x" } } }, /no team "ghost"/],
      [{ teams: { lookers: { note: "one\ntwo" } } }, /The note for lookers must be one line/],
      [{ teams: { lookers: { goal: "mine" } } }, /edits.teams.lookers has no "goal"/],
      [{ stops: { look: "yes" } }, /must be true or false/],
      [{ cycle: { max: 2 } }, /no cycle/],
      [{ choices: { level: 3 } }, /isn't a choice value/],
    ] as const) {
      const res = await asPage(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits }));
      assert.equal(res.status, 400, JSON.stringify(edits));
      assert.match(((await res.json()) as { error: string }).error, want);
    }
  });

  test("Start is the person's own click only, on the revision shown: a script's or a chat's call, or a stale revision, starts nothing", async () => {
    const v = await open();
    const script = await app.request(`/api/playbook-runs/${v.id}/start`, json({ revision: v.revision }));
    assert.equal(script.status, 403);
    assert.deepEqual(await script.json(), { error: "Only the user starts a playbook run. Ask them to press Start on its card in Sova's page. Nothing was started.", yourClick: true });
    assert.equal((await asChat(`/api/playbook-runs/${v.id}/start`, json({ revision: v.revision }))).status, 403);
    const stale = await asPage(`/api/playbook-runs/${v.id}/start`, json({ revision: v.revision - 1 }));
    assert.equal(stale.status, 409);
    const body = (await stale.json()) as { error: string; run: PlaybookRunView };
    assert.match(body.error, /changed since you saw it/);
    assert.equal(body.run.revision, v.revision);
    assert.equal(store.runById(v.id)!.state, "draft");
  });

  test("a chat or a script can't close the person's card", async () => {
    const v = await open();
    for (const call of [app.request(`/api/playbook-runs/${v.id}`, { method: "DELETE" }), asChat(`/api/playbook-runs/${v.id}`, { method: "DELETE" })]) {
      const res = await call;
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /Only the person closes a playbook card/);
    }
    assert.equal(store.runById(v.id)!.closed, undefined);
    assert.equal((await app.request(`/api/playbook-runs/${v.id}`)).status, 200);
  });

  test("a chat fills in choices; models, members, notes, stops and cycles are the person's", async () => {
    const v = await open();
    const roles = await asChat(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { roles: { helper: { on: true } } } }));
    assert.equal(roles.status, 403);
    assert.equal((await asChat(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { teams: { lookers: { note: "from the chat" } } } }))).status, 403, "a team's note is the person's too");
    assert.equal(store.runById(v.id)!.revision, v.revision);
    const choices = await asChat(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { topic: "from the chat" } } }));
    assert.equal(choices.status, 200);
    assert.equal(((await choices.json()) as PlaybookRunView).revision, v.revision + 1);
  });

  test("the chat's cards list it, its news reaches the chat, and a closed draft leaves the list", async () => {
    const v = await open();
    const heard: { sessionId: string; type: string; id: string; closed?: boolean }[] = [];
    const off = onPlaybookRunNews((n) => heard.push({ sessionId: n.sessionId, type: n.event.type, id: (n.event.run as PlaybookRunView).id, ...((n.event.run as PlaybookRunView).closed ? { closed: true } : {}) }));
    const listed = (await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(chatPath)}`)).json()) as { runs: PlaybookRunView[] };
    assert.ok(listed.runs.some((r) => r.id === v.id));
    assert.equal((await asPage(`/api/playbook-runs/${v.id}`, { method: "DELETE" })).status, 200);
    const after = (await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(chatPath)}`)).json()) as { runs: PlaybookRunView[] };
    assert.ok(!after.runs.some((r) => r.id === v.id));
    await new Promise((r) => setTimeout(r, 300));
    off();
    assert.deepEqual(heard.at(-1), { sessionId: "chat-a", type: PLAYBOOK_RUN_EVENT, id: v.id, closed: true });
  });

  test("a started run put away leaves the chat's cards but still answers by its id, marked closed; a closed draft doesn't", async () => {
    const listedIds = async () => ((await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(chatPath)}`)).json()) as { runs: PlaybookRunView[] }).runs.map((r) => r.id);
    const started = await open();
    store.changeRun(started.id, (x) => {
      x.state = "started";
    });
    assert.equal((await app.request(`/api/playbook-runs/${started.id}`, { method: "DELETE" })).status, 403, "still only the person's click");
    assert.equal((await asPage(`/api/playbook-runs/${started.id}`, { method: "DELETE" })).status, 200);
    assert.ok(!(await listedIds()).includes(started.id));
    const record = await app.request(`/api/playbook-runs/${started.id}`);
    assert.equal(record.status, 200);
    assert.deepEqual(((await record.json()) as PlaybookRunView & { closed?: boolean }).closed, true);
    assert.equal((await asPage(`/api/playbook-runs/${started.id}`, { method: "DELETE" })).status, 404, "put away once");
    const draft = await open();
    assert.equal((await asPage(`/api/playbook-runs/${draft.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await app.request(`/api/playbook-runs/${draft.id}`)).status, 404);
  });

  describe("a chat runs one playbook", () => {
    const other = join(scratchAgentDir, "sova", "playbooks", "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "PLAYBOOK.md"), "---\ntitle: Other\ndescription: Another playbook\n---\nConduct the other.\n");
    writeFileSync(join(other, "playbook.json"), JSON.stringify({ version: 1, steps: [{ id: "go", label: "Go" }] }));
    let n = 0;
    const chat = () => {
      const id = `chat-one-${++n}`;
      const path = join(scratchAgentDir, "sessions", "--proj--", `2026-11-16T00-01-0${n}-000Z_${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-16T00:01:00.000Z", cwd: scratchAgentDir })}\n`);
      return { id, path };
    };
    const openIn = (path: string, id: string) => app.request("/api/playbook-runs", json({ playbook: { source: "user", id }, cwd: scratchAgentDir, path }));
    const listed = async (path: string) => ((await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(path)}`)).json()) as { runs: PlaybookRunView[] }).runs.map((r) => r.id);
    const started = (id: string, conducting: { id: string; path: string }) =>
      store.changeRun(id, (x) => {
        x.state = "started";
        x.started = { at: new Date().toISOString(), revision: x.revision, chat: conducting, newChat: false, folder: scratchAgentDir };
      });

    test("a card of another playbook replaces the chat's card not yet started", async () => {
      const c = chat();
      const heard: { sessionId: string; id: string; closed?: boolean }[] = [];
      const off = onPlaybookRunNews((m) => heard.push({ sessionId: m.sessionId, id: (m.event.run as PlaybookRunView).id, ...((m.event.run as PlaybookRunView).closed ? { closed: true } : {}) }));
      const first = (await (await openIn(c.path, "trial")).json()) as PlaybookRunView;
      const second = (await (await openIn(c.path, "other")).json()) as PlaybookRunView;
      assert.notEqual(second.id, first.id);
      assert.equal(store.runById(first.id)!.closed, true);
      assert.deepEqual(await listed(c.path), [second.id]);
      await new Promise((r) => setTimeout(r, 300));
      off();
      assert.ok(heard.some((h) => h.sessionId === c.id && h.id === first.id && h.closed), "the chat hears the replaced card closed");
      const list = (await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(c.path)}`)).json()) as { holding: unknown };
      assert.equal(list.holding, null, "a draft holds no chat");
    });

    test("a chat that conducts a run opens no other card, its card put away or not", async () => {
      const c = chat();
      const run = (await (await openIn(c.path, "trial")).json()) as PlaybookRunView;
      started(run.id, c);
      for (const id of ["other", "trial"]) {
        const res = await openIn(c.path, id);
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: "This chat already runs the playbook Trial, and a chat runs one playbook. Start this one in a new chat.", holding: run.id });
      }
      assert.equal((await asPage(`/api/playbook-runs/${run.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await openIn(c.path, "other")).status, 409, "put away, the run still runs in this chat");
      assert.deepEqual(await listed(c.path), []);
      const list = (await (await app.request(`/api/playbook-runs?path=${encodeURIComponent(c.path)}`)).json()) as { holding: unknown };
      assert.deepEqual(list.holding, { id: run.id, title: "Trial" }, "the chat's list still says which run holds it");
    });

    test("a chat whose card started a run in another chat opens no other card until that card is put away", async () => {
      const c = chat();
      const elsewhere = chat();
      const run = (await (await openIn(c.path, "trial")).json()) as PlaybookRunView;
      started(run.id, elsewhere);
      assert.equal((await openIn(c.path, "other")).status, 409);
      assert.equal((await openIn(elsewhere.path, "other")).status, 409, "the chat conducting it");
      assert.equal((await asPage(`/api/playbook-runs/${run.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await openIn(c.path, "other")).status, 201);
    });
  });

  test("Save as My Defaults gives the next card those values, marked as your standing answer", async () => {
    const v = await open();
    const edited = (await (await app.request(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { level: "hi" } } }))).json()) as PlaybookRunView;
    assert.equal((await app.request(`/api/playbook-runs/${v.id}/defaults`, json({ revision: edited.revision }))).status, 403, "only the person's click saves defaults");
    assert.equal((await asPage(`/api/playbook-runs/${v.id}/defaults`, json({ revision: edited.revision }))).status, 200);
    await asPage(`/api/playbook-runs/${v.id}`, { method: "DELETE" });
    const next = await open();
    assert.notEqual(next.id, v.id);
    assert.deepEqual(next.choices.find((c) => c.id === "level")!, { ...next.choices.find((c) => c.id === "level")!, value: "hi", origin: "standing" });
  });

  test("a chat with no message yet is listed while it shows a card, and hidden again once the card is closed", async () => {
    const path = join(scratchAgentDir, "sessions", "--proj--", "2026-11-16T00-00-09-000Z_chat-empty.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "chat-empty", timestamp: "2026-11-16T00:00:09.000Z", cwd: scratchAgentDir })}\n`);
    const row = async () => (await listSessions()).find((r) => r.id === "chat-empty");
    assert.equal(await row(), undefined, "an empty chat is an abandoned stub");
    const res = await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "trial" }, cwd: scratchAgentDir, path }));
    const v = (await res.json()) as PlaybookRunView;
    assert.equal((await row())?.draftPreview, "Playbook: Trial");
    await asPage(`/api/playbook-runs/${v.id}`, { method: "DELETE" });
    assert.equal(await row(), undefined);
  });

  test("/ rows: one per playbook with a description, a broken one included; opening the broken one says its fault", async () => {
    const broken = join(scratchAgentDir, "sova", "playbooks", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "PLAYBOOK.md"), "---\ntitle: Broken\n---\nBody.\n");
    writeFileSync(join(broken, "playbook.json"), JSON.stringify({ version: 1, nope: true }));
    const { playbookCommandRows } = await import("./commands");
    const rows = await playbookCommandRows(scratchAgentDir);
    assert.deepEqual(rows.filter((r) => r.name === "broken" || r.name === "trial").map((r) => [r.name, r.source, r.playbook]), [["broken", "builtin", { source: "user", id: "broken" }], ["trial", "builtin", { source: "user", id: "trial" }]]);
    const res = await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "broken" }, cwd: scratchAgentDir, path: chatPath }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^The playbook's description can't be read: .*nope/);
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

describe("the session list", () => {
  test("reads again when a card opens or closes, never for an edit", async () => {
    const { storesGeneration } = await import("../list-generation");
    const path = join(scratchAgentDir, "sessions", "--proj--", "2026-11-16T00-00-08-000Z_chat-gen.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "chat-gen", timestamp: "2026-11-16T00:00:08.000Z", cwd: scratchAgentDir })}\n`);
    let g = storesGeneration();
    const v = (await (await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "trial" }, cwd: scratchAgentDir, path }))).json()) as PlaybookRunView;
    assert.notEqual(storesGeneration(), g, "a card opened");
    g = storesGeneration();
    await asPage(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { topic: "typed" } } }));
    assert.equal(storesGeneration(), g, "an edit changes nothing the list reads");
    await asPage(`/api/playbook-runs/${v.id}`, { method: "DELETE" });
    assert.notEqual(storesGeneration(), g, "a card closed");
  });
});

describe("a choice worked out with the chat", () => {
  const dir = join(scratchAgentDir, "sova", "playbooks", "chatty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAYBOOK.md"), "---\ntitle: Chatty\ndescription: Works a choice out with the chat\n---\nConduct it.\n");
  writeFileSync(
    join(dir, "playbook.json"),
    JSON.stringify({
      version: 1,
      inputs: [
        { id: "failure", label: "The failure to fix", type: "text", multiline: true, ask: "chat", required: true, help: "What goes wrong today" },
        { id: "level", label: "Level", type: "choice", ask: "always", required: true, options: [{ id: "lo", label: "Low" }, { id: "hi", label: "High" }], default: "lo" },
      ],
      steps: [{ id: "go", label: "Go" }],
    }),
  );
  let n = 0;
  const chat = () => {
    const id = `chat-chatty-${++n}`;
    const path = join(scratchAgentDir, "sessions", "--proj--", `2026-11-16T00-02-0${n}-000Z_${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-16T00:02:00.000Z", cwd: scratchAgentDir })}\n`);
    return { id, path };
  };
  const openIn = async (path: string, extra: Record<string, unknown> = {}) => (await (await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "chatty" }, cwd: scratchAgentDir, path, ...extra }))).json()) as PlaybookRunView;

  test("keeps Start off until the chat fills it; the person's page can't, the chat's own call can", async () => {
    const c = chat();
    const v = await openIn(c.path);
    assert.equal(v.choices.find((x) => x.id === "failure")!.ask, "chat");
    assert.equal(v.startBlocked, "Work out The failure to fix with the chat first.");
    const page = await asPage(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { failure: "mine" } } }));
    assert.equal(page.status, 400);
    assert.deepEqual(await page.json(), { error: "The failure to fix is worked out with the chat: ask it there. Nothing was changed." });
    assert.equal((await asPage(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { level: "hi" } } }))).status, 200, "the short choices stay the person's");
    const filled = await asChat(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision + 1, edits: { choices: { failure: "The read tool loses the last line." } } }));
    assert.equal(filled.status, 200);
    const after = (await filled.json()) as PlaybookRunView;
    assert.equal(after.choices.find((x) => x.id === "failure")!.value, "The read tool loses the last line.");
    assert.equal(after.startBlocked, null);
  });

  test("the chat is told in its own context which card waits on it and the command that fills it, until it's filled", async () => {
    const { playbookCardNote } = await import("./note");
    const c = chat();
    assert.equal(await playbookCardNote(c.id), null, "no card, no note");
    const v = await openIn(c.path);
    const note = (await playbookCardNote(c.id))!;
    assert.ok(note.startsWith(`This chat shows the card of the playbook "Chatty" (run ${v.id}), not started.`), note);
    assert.ok(note.includes("- The failure to fix [failure], text, several lines, required before Start: What goes wrong today"), note);
    assert.ok(note.includes("If the request is ambiguous about one of them and align mode is on, you may open an alignment first"), note);
    assert.ok(note.includes(`run playbook.run.edit --run ${v.id} --json '{"revision": <its revision>, "edits": {"choices": {"<choice id>": <value>}}}'`), note);
    assert.ok(!note.includes("[level]"), "only the choices the chat works out");
    await asChat(`/api/playbook-runs/${v.id}`, patch({ revision: v.revision, edits: { choices: { failure: "x" } } }));
    assert.equal(await playbookCardNote(c.id), null, "filled: nothing waits on the chat");
  });

  test("a card stands where it was opened: the page's last item and the time, kept on reopening, taken anew by a card replacing it", async () => {
    const c = chat();
    const v = await openIn(c.path, { after: "item-7" });
    assert.equal(v.anchor?.after, "item-7");
    assert.match(v.anchor?.at ?? "", /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual((await openIn(c.path, { after: "item-9" })).anchor, v.anchor, "the same card reopened keeps its place");
    const other = (await (await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "trial" }, cwd: scratchAgentDir, path: c.path, after: "item-9" }))).json()) as PlaybookRunView;
    assert.equal(other.anchor?.after, "item-9");
    assert.equal((await app.request("/api/playbook-runs", json({ playbook: { source: "user", id: "chatty" }, cwd: scratchAgentDir, path: c.path, after: 5 }))).status, 400);
  });
});
