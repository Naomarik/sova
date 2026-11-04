import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionDigest, AttentionItem, SessionSummary } from "../../shared/protocol";
import type { ProjectSummary } from "../../shared/projects";
import { CARD_LIMIT, CARD_LIMIT_NARROW, freezeOrder, projectCards, shortFolder, showsFilter, visibleCards } from "./home-projects";

const project = (id: string, name: string, createdAt = "2026-01-01T00:00:00.000Z", extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name,
  root: `/code/${name}`,
  origin: "folder",
  createdAt,
  space: { kind: "standalone" },
  ...extra,
});

let n = 0;
const chat = (projectId: string | null, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    path: `/s/${n++}.jsonl`,
    id: `s${n}`,
    cwd: "/code",
    title: `chat ${n}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    live: null,
    busy: false,
    archived: false,
    origin: "web",
    ...(projectId ? { project: { projectId, projectName: projectId, kind: "coding" } } : {}),
    ...extra,
  }) as unknown as SessionSummary;

const act = (path: string): AttentionItem => ({ id: `a-${path}`, path, kind: "dialog", tier: "act", since: 1, title: "t", where: "w" }) as unknown as AttentionItem;
const digest = (...paths: string[]): Pick<AttentionDigest, "items"> => ({ items: paths.map(act) });

test("joins each project's chats: needs you, working, last activity; other projects' and no project's chats don't count", () => {
  const a = project("prj_a", "Alpha");
  const b = project("prj_b", "Beta");
  const waiting = chat("prj_a");
  const working = chat("prj_a", { busy: true, lastActiveAt: "2026-03-01T00:00:00.000Z" });
  const other = chat("prj_b");
  const loose = chat(null, { busy: true });
  const cards = projectCards([a, b], [waiting, working, other, loose], digest(waiting.path, loose.path), "badge");
  const alpha = cards.find((c) => c.project.id === "prj_a")!;
  assert.equal(alpha.needsYou, 1);
  assert.equal(alpha.working, 1);
  assert.equal(alpha.lastActivity, Date.parse("2026-03-01T00:00:00.000Z"));
  const beta = cards.find((c) => c.project.id === "prj_b")!;
  assert.deepEqual([beta.needsYou, beta.working], [0, 0]);
  // A live chat's own record says whether it works, not the server's busy flag.
  const liveIdle = chat("prj_b", { busy: true, live: { pid: 1 } as unknown as SessionSummary["live"] });
  assert.equal(projectCards([b], [liveIdle], undefined, "badge")[0]!.working, 0);
});

test("needs you is 0 for every card while proactivity is off or unknown", () => {
  const a = project("prj_a", "Alpha");
  const s = chat("prj_a");
  assert.equal(projectCards([a], [s], digest(s.path), "off")[0]!.needsYou, 0);
  assert.equal(projectCards([a], [s], digest(s.path), undefined)[0]!.needsYou, 0);
  assert.equal(projectCards([a], [s], digest(s.path), "badge")[0]!.needsYou, 1);
});

test("archived projects are skipped; archived chats and workers don't count", () => {
  const a = project("prj_a", "Alpha");
  const gone = project("prj_z", "Zed", undefined, { archived: { at: "2026-01-02T00:00:00.000Z" } });
  const cards = projectCards([a, gone], [chat("prj_a", { archived: true, busy: true }), chat("prj_a", { workerSession: true, busy: true })], undefined, "badge");
  assert.deepEqual(cards.map((c) => c.project.id), ["prj_a"]);
  assert.equal(cards[0]!.working, 0);
  assert.equal(cards[0]!.lastActivity, null);
});

test("order: needs you first, then most recent activity (or when added), then name", () => {
  const old = project("prj_1", "Old", "2025-01-01T00:00:00.000Z");
  const fresh = project("prj_2", "Fresh", "2026-04-01T00:00:00.000Z"); // no chats: its added time
  const busy = project("prj_3", "Busy", "2024-01-01T00:00:00.000Z");
  const needy = project("prj_4", "Needy", "2024-01-01T00:00:00.000Z");
  const twinA = project("prj_5", "Bravo", "2023-01-01T00:00:00.000Z");
  const twinB = project("prj_6", "Alpha", "2023-01-01T00:00:00.000Z");
  const waiting = chat("prj_4", { lastActiveAt: "2024-01-01T00:00:00.000Z" });
  const sessions = [chat("prj_1", { lastActiveAt: "2026-01-01T00:00:00.000Z" }), chat("prj_3", { lastActiveAt: "2026-05-01T00:00:00.000Z" }), waiting];
  const cards = projectCards([old, fresh, busy, needy, twinA, twinB], sessions, digest(waiting.path), "badge");
  assert.deepEqual(
    cards.map((c) => c.project.name),
    ["Needy", "Busy", "Fresh", "Old", "Alpha", "Bravo"],
  );
});

test("freezeOrder keeps the ids seen and appends new ones in sorted order; gone ones drop out", () => {
  const rows = (names: string[]) => names.map((name) => ({ project: project(`prj_${name}`, name), needsYou: 0, working: 0, lastActivity: null }));
  const now = rows(["C", "A", "New1", "B", "New2"]);
  const frozen = freezeOrder(["prj_A", "prj_B", "prj_Gone", "prj_C"], now);
  assert.deepEqual(frozen.map((r) => r.project.name), ["A", "B", "C", "New1", "New2"]);
});

test("visibleCards: limit 8 (6 narrow), Show all, and a filter that shows every match", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ project: project(`prj_${i}`, i % 3 === 0 ? `Shop ${i}` : `Site ${i}`), needsYou: 0, working: 0, lastActivity: null }));
  assert.equal(visibleCards(rows, { limit: CARD_LIMIT, expanded: false, filter: "" }).length, 8);
  assert.equal(visibleCards(rows, { limit: CARD_LIMIT_NARROW, expanded: false, filter: "" }).length, 6);
  assert.equal(visibleCards(rows, { limit: CARD_LIMIT, expanded: true, filter: "" }).length, 12);
  const site = visibleCards(rows, { limit: CARD_LIMIT_NARROW, expanded: false, filter: "  SITE " });
  assert.equal(site.length, 8, "the filter ignores the limit");
  assert.deepEqual(visibleCards(rows, { limit: CARD_LIMIT, expanded: false, filter: "nothing" }), []);
});

test("shortFolder shortens the home folder only at a boundary", () => {
  assert.equal(shortFolder("/home/me/code/acme", "/home/me"), "~/code/acme");
  assert.equal(shortFolder("/home/me", "/home/me"), "~");
  assert.equal(shortFolder("/home/meg/x", "/home/me"), "/home/meg/x");
  assert.equal(shortFolder("/srv/x", null), "/srv/x");
});

test("the filter field counts live projects only: 7 live + 2 archived shows none; 9 live shows it", () => {
  const live = Array.from({ length: 7 }, (_, i) => project(`prj_l${i}`, `Live ${i}`));
  const gone = Array.from({ length: 2 }, (_, i) => project(`prj_a${i}`, `Old ${i}`, undefined, { archived: { at: "2026-01-02T00:00:00.000Z" } }));
  assert.equal(showsFilter(projectCards([...live, ...gone], [], undefined, "badge")), false);
  const more = [...live, project("prj_l7", "Live 7"), project("prj_l8", "Live 8")];
  assert.equal(showsFilter(projectCards([...more, ...gone], [], undefined, "badge")), true);
});
