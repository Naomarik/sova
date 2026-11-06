// Run: pnpm test -- src/lib/home-projects-keyed.browser.test.ts (Solid's reactive build).
// Home's project cards (§app.projects/home-cards) are drawn the way OverviewProjects draws them: projectCards →
// visibleCards → ForKey by project id. A session-list update mints every card row afresh; keyed by id, each card is
// built once and keeps what it built (an open ⋯ menu, focus), while its accessor sees the new counts. A plain <For>
// over the same rows builds every card again: the failure this guards against.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSX } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import type { ProjectSummary } from "../../shared/projects";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { ForKey } = await import("./for-key");
const { CARD_LIMIT, projectCards, visibleCards } = await import("./home-projects");
type Card = import("./home-projects").ProjectCard;

const project = (id: string, name: string): ProjectSummary => ({ id, name, root: `/code/${name}`, origin: "folder", createdAt: "2026-01-01T00:00:00.000Z", space: { kind: "standalone" } });
const chat = (projectId: string, busy: boolean): SessionSummary =>
  ({ path: `/s/${projectId}.jsonl`, id: projectId, cwd: "/code", title: "t", createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-02-01T00:00:00.000Z", live: null, busy, archived: false, origin: "web", project: { projectId, projectName: projectId, kind: "coding" } }) as unknown as SessionSummary;
const PROJECTS = ["a", "b", "c"].map((x) => project(`prj_${x}`, x.toUpperCase()));

function draw(keyed: boolean) {
  const [sessions, setSessions] = solid.createSignal<SessionSummary[]>([chat("prj_a", false), chat("prj_b", false)]);
  const builds: string[] = [];
  /** What each built card reads now: its id, working and open counts. */
  const reads: (() => string)[] = [];
  solid.createRoot(() => {
    const shown = solid.createMemo(() => visibleCards(projectCards(PROJECTS, sessions(), undefined, "badge"), { limit: CARD_LIMIT, expanded: false, filter: "" }));
    const build = (c: () => Card): JSX.Element => {
      builds.push(c().project.id);
      reads.push(() => `${c().project.id}:${c().working}:${c().open}`);
      return null as unknown as JSX.Element;
    };
    const view = keyed
      ? ForKey<Card>({ get each() { return shown(); }, by: (c) => c.project.id, children: (c) => build(c) })
      : solid.createComponent(solid.For, { get each() { return shown(); }, children: (c: Card) => build(() => c) });
    solid.createRenderEffect(() => (view as unknown as () => unknown)());
  });
  return { setSessions, builds, reads };
}

test("keyed by project id: a chat that starts working keeps every card's DOM, and the card reads the new count", () => {
  const v = draw(true);
  assert.deepEqual(v.builds.sort(), ["prj_a", "prj_b", "prj_c"]);
  v.setSessions([chat("prj_a", true), chat("prj_b", false)]);
  assert.equal(v.builds.length, 3, "no card was built again (an open menu and focus survive)");
  assert.ok(v.reads.map((r) => r()).includes("prj_a:1:1"), "the built card follows the fresh row");
  // A chat archived: the card's open count follows, still without a rebuild.
  v.setSessions([{ ...chat("prj_a", false), archived: true } as SessionSummary, chat("prj_b", false)]);
  assert.equal(v.builds.length, 3);
  assert.ok(v.reads.map((r) => r()).includes("prj_a:0:0"), "open drops to 0");
});

test("a plain <For> over the same rows rebuilds every card: the failure the key prevents", () => {
  const v = draw(false);
  v.setSessions([chat("prj_a", true), chat("prj_b", false)]);
  assert.ok(v.builds.length > 3);
});
