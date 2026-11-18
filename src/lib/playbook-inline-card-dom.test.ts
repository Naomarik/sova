// Run: pnpm test -- src/lib/playbook-inline-card-dom.test.ts
// A playbook's card standing in the conversation (§chat.playbooks/run-card, run-record), drawn with
// Solid's SSR build (src/lib/align-card-ssr.mjs) from one entry that imports the card and its context
// together. Before Start it is the setup card: Start and Close Card are on it, and nothing of the
// floating card (no Minimize, no dialog). After Start the same card is the read-only record: no
// Start, no stop's answers, no Close Card. Outside a chat that shows cards it draws nothing.
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

const dir = mkdtempSync(join(tmpdir(), "sova-inline-card-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const components = relative(dir, fileURLToPath(new URL("../components/", import.meta.url)));
const entry = join(dir, "entry.tsx");
writeFileSync(
  entry,
  [
    `import { PlaybookInlineCard } from "${components}/PlaybookInlineCard";`,
    `import { PlaybookCard, PlaybookInlineContext } from "${components}/PlaybookCard";`,
    `export const inChat = (host: any, run: string) => <PlaybookInlineContext.Provider value={host}><PlaybookInlineCard run={run} /></PlaybookInlineContext.Provider>;`,
    `export const inWatch = (run: string) => <PlaybookInlineCard run={run} />;`,
    `export const floating = (props: any) => <PlaybookCard {...props} />;`,
  ].join("\n"),
);
const { inChat, inWatch, floating } = await importSsr(pathToFileURL(entry), (s: string) => import.meta.resolve(s));

const HERE = "/chats/a.jsonl";
const view = (extra: Partial<PlaybookRunView>): PlaybookRunView =>
  normalizeRunView({
    id: "pr_aaaaaaaaaaaa",
    revision: 3,
    playbook: { source: "sova", id: "ab-cycle", title: "A/B cycle", dir: "/p" },
    state: "draft",
    choices: [{ id: "what", label: "What to test", type: "text", value: "the chart picker", origin: "message", required: true, ask: "always" }],
    steps: [{ id: "baseline", title: "Baseline", stop: "never", stopOn: false, teams: [] }],
    cycle: null,
    howItRuns: "Runs in this chat.",
    commands: [],
    startBlocked: null,
    ...extra,
  } as PlaybookRunView);
const started = { at: "2026-11-18T10:04:00.000Z", revision: 3, chat: { id: "a", path: HERE }, newChat: false, folder: "/runs/x" };
/** A chat's side of the card, as far as drawing it goes. */
const host = (run: PlaybookRunView) => ({
  store: { starting: () => false },
  host: null,
  chat: { path: HERE, now: () => ({ working: false, helpersWorking: 0, needsYou: "Pick the winner." }) },
  run: (id: string) => (id === run.id ? run : undefined),
});
const draw = (fn: () => unknown) => renderToString(() => solid.createComponent(fn as never, {} as never)).replace(/<!--[^>]*-->/g, "");
const button = (label: string) => new RegExp(`<button[^>]*>(?:<[^>]*>|\\s)*${label}`);

test("before Start: the setup card in the conversation carries Start and Close Card, and nothing of the floating card", () => {
  const run = view({});
  const html = draw(() => inChat(host(run), run.id));
  assert.match(html, /class="card pb-card pb-inline"/);
  assert.match(html, /data-pb-inline="pr_aaaaaaaaaaaa"/);
  assert.match(html, /data-state="draft"/);
  assert.match(html, /Ready to start/);
  assert.match(html, button("Start"));
  assert.match(html, button("Save as My Defaults"));
  assert.match(html, button("Close Card"));
  assert.match(html, /<details class="pb-section pb-steps" open/, "the steps are open while it is set up");
  assert.doesNotMatch(html, /Minimize/);
  assert.doesNotMatch(html, /data-folded|Show Card|Hide Card/, "a setup card never folds");
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, / id="pb-card-/, "the strip's popup id is the floating card's alone");
});

const ELSEWHERE = { ...started, chat: { id: "b", path: "/chats/b.jsonl", title: "A/B cycle (playbook)" }, newChat: true };

test("after Start, in the chat whose card started a run elsewhere: the read-only record says it started, once", () => {
  const run = view({ state: "started", started: ELSEWHERE });
  const html = draw(() => inChat(host(run), run.id));
  assert.match(html, /class="card pb-card pb-inline"/);
  assert.match(html, /data-state="started"/);
  assert.match(html, /This is the card as you started it\./);
  assert.match(html, />Started</, "its state is that it started, never how the chat stands now");
  assert.doesNotMatch(html, /Needs you|Pick the winner/);
  for (const label of ["Start", "Save as My Defaults", "Continue", "Stop Here", "Close Card", "Minimize"]) assert.doesNotMatch(html, button(label), label);
  assert.doesNotMatch(html, /<(input|textarea|select)\b/, "nothing on a record can be edited");
  assert.doesNotMatch(html, /<details class="pb-section pb-steps" open/, "a record read again starts with its steps folded");
  // Drawn already started (the chat opened again): folded to its head and when it started, Show Card opens it.
  assert.match(html, /data-folded/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>(?:<[^>]*>|\s)*Show Card/);
});

test("in the run's own chat the record never says Started: the conversation's start row does, so it is said once", () => {
  const run = view({ state: "started", started });
  const html = draw(() => inChat(host(run), run.id));
  assert.match(html, /data-state="started"/);
  assert.match(html, /The card as you set it up: revision 3\./);
  assert.doesNotMatch(html, /Started/, "no Started chip and no Started line");
  assert.doesNotMatch(html, /class="chip/, "no state chip at all: the strip says how the run stands");
  for (const label of ["Start", "Continue", "Stop Here", "Close Card"]) assert.doesNotMatch(html, button(label), label);
  assert.match(html, /Show Card/);
});

test("a put-away run's record says its strip was put away and that the run wasn't changed", () => {
  const run = view({ state: "started", started, closed: true });
  assert.match(draw(() => inChat(host(run), run.id)), /The card as you set it up: revision 3\. You put its strip away; the run was not changed\./);
});

test("a broken playbook's fault is printed once: in the card's error line, which Start is described by, not again beside Start", () => {
  const fault = "The playbook's description can't be read: playbook.json: isn't valid JSON.";
  const run = view({ error: fault, startBlocked: fault });
  const html = draw(() => inChat(host(run), run.id));
  // What is printed on the card (hover titles aside): the fault, once.
  const printed = html.replace(/<[^>]*>/g, " ");
  assert.equal(printed.split("isn't valid JSON").length - 1, 1);
  assert.match(html, /<p class="pb-error" role="alert" id="([^"]+)">The playbook's description can't be read/);
  const errorId = /<p class="pb-error" role="alert" id="([^"]+)">/.exec(html)![1]!;
  assert.match(html, new RegExp(`<button[^>]*pb-start[^>]*aria-describedby="${errorId}"`));
  assert.match(html, /<span class="pb-foot-hint"[^>]*><\/span>/);
  // A reason that isn't the error line's stays beside Start.
  const other = draw(() => inChat(host(view({ startBlocked: "Work out The failure to fix with the chat first." })), "pr_aaaaaaaaaaaa"));
  assert.match(other, /<span class="pb-foot-hint"[^>]*>Work out The failure to fix with the chat first\.<\/span>/);
});

test("the floating card of the same run keeps its dialog, Minimize, the stop's answers and Close Card", () => {
  const run = view({ state: "started", started });
  const html = draw(() =>
    floating({ run, store: { starting: () => false }, host: null, here: HERE, shown: true, status: { label: "Needs you", tone: "warn", detail: "Pick the winner.", answer: true }, answer: { send: () => true, blocked: () => null }, onMinimize: () => {} }),
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, / id="pb-card-pr_aaaaaaaaaaaa"/);
  assert.doesNotMatch(html, /pb-inline/);
  for (const label of ["Minimize", "Continue", "Stop Here", "Close Card"]) assert.match(html, button(label), label);
  assert.match(html, /Progress comes in the chat's messages\./);
});

test("a row whose run the chat doesn't hold, and a view with no cards (a read-only watch), draw nothing", () => {
  const run = view({});
  assert.equal(draw(() => inChat(host(run), "pr_other")), "");
  assert.equal(draw(() => inWatch(run.id)), "");
});
