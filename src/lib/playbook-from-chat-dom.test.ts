// Run: pnpm test -- src/lib/playbook-from-chat-dom.test.ts
// Every card value the chat set reads "From the chat" beside it (§chat.playbooks/run-card): a
// member's model, whether it runs, its note, the team's note, an optional stop and the cycle's
// settings, on the setup card and on the record after Start; a value the chat didn't set says
// nothing. (A change of yours still saving hides the label for that value: page state, not drawn here.)
// Drawn with Solid's SSR build
// (src/lib/align-card-ssr.mjs) through the inline card, as the conversation draws it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRunView } from "./playbook-run-view";
import type { PlaybookRunView } from "../../shared/playbook-run";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");

const dir = mkdtempSync(join(tmpdir(), "sova-from-chat-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const components = relative(dir, fileURLToPath(new URL("../components/", import.meta.url)));
const entry = join(dir, "entry.tsx");
writeFileSync(
  entry,
  [
    `import { PlaybookInlineCard } from "${components}/PlaybookInlineCard";`,
    `import { PlaybookInlineContext } from "${components}/PlaybookCard";`,
    `export const inChat = (host: any, run: string) => <PlaybookInlineContext.Provider value={host}><PlaybookInlineCard run={run} /></PlaybookInlineContext.Provider>;`,
  ].join("\n"),
);
const { inChat } = await importSsr(pathToFileURL(entry), (s: string) => import.meta.resolve(s));

const HERE = "/chats/a.jsonl";
const ALL = ["roles.writer.pick", "roles.writer.on", "roles.writer.note", "teams.write.note", "stops.check", "cycle.max", "cycle.until"];
const view = (extra: Partial<PlaybookRunView>): PlaybookRunView =>
  normalizeRunView({
    id: "pr_aaaaaaaaaaaa",
    revision: 3,
    playbook: { source: "sova", id: "ab-cycle", title: "A/B cycle", dir: "/p" },
    state: "draft",
    choices: [],
    teams: [
      {
        id: "write",
        label: "Write",
        goal: "Write the sentence",
        steps: ["round"],
        note: "Keep it short.",
        members: [
          {
            id: "writer",
            label: "Writer",
            brief: "Writes one sentence.",
            count: 1,
            optional: true,
            on: true,
            // "Only these models": its list is the form kit's select, which draws on the server
            // (the model picker for any model needs a window).
            only: true,
            chain: [{ model: "zai/glm-5.3", effort: "low" }],
            models: [{ model: "zai/glm-5.3", effort: "low", label: "GLM 5.3", provider: "zai", usable: true }],
            options: [],
            resolved: { model: "zai/glm-5.3", modelLabel: "GLM 5.3", provider: "zai", effort: "low", source: "card" },
            runnable: true,
            note: "Be calm.",
          },
        ],
      },
    ],
    steps: [
      { id: "round", title: "A round", stop: "never", stopOn: false, teams: ["write"], cycle: true },
      { id: "check", title: "Check the result", stop: "optional", stopOn: true, teams: [] },
    ],
    cycle: { steps: ["round"], max: 3, maxCap: 10, askEvery: 1, until: "rule", rule: "two rounds in a row with no change" },
    howItRuns: "Runs in this chat.",
    commands: [],
    startBlocked: null,
    ...extra,
  } as PlaybookRunView);
const host = (run: PlaybookRunView) => ({
  store: { starting: () => false },
  host: null,
  chat: { path: HERE, now: () => ({ working: false, helpersWorking: 0, needsYou: null }) },
  run: (id: string) => (id === run.id ? run : undefined),
});
const draw = (run: PlaybookRunView) => renderToString(() => solid.createComponent((() => inChat(host(run), run.id)) as never, {} as never)).replace(/<!--[^>]*-->/g, "");
const count = (html: string) => (html.match(/class="pb-from-chat"[^>]*>From the chat</g) ?? []).length;

test("on the setup card, each value the chat set reads From the chat: a member's model, Runs and note, the team's note, a stop, the cycle", () => {
  const html = draw(view({ fromChat: ALL }));
  assert.equal(count(html), ALL.length);
});

test("a value the chat didn't set says nothing: no list, no label", () => {
  assert.equal(count(draw(view({}))), 0);
  // One path alone: one label.
  assert.equal(count(draw(view({ fromChat: ["cycle.max"] }))), 1);
  assert.equal(count(draw(view({ fromChat: ["roles.writer.pick"] }))), 1);
  assert.equal(count(draw(view({ fromChat: ["stops.check"] }))), 1);
});

test("the record after Start keeps the labels the chat had set when it started", () => {
  const started = { at: "2026-11-18T10:04:00.000Z", revision: 3, chat: { id: "a", path: HERE }, newChat: false, folder: "/runs/x" };
  const html = draw(view({ state: "started", startBlocked: "This run has started.", started, fromChat: ALL }));
  assert.equal(count(html), ALL.length);
});
