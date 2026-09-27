// Run: npx tsx --test src/lib/org-region.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, SessionOrg, SessionSummary } from "../../shared/protocol";
import {
  eyeLabel,
  finishedOpen,
  inOrgRegion,
  NO_PROJECT,
  overseerEye,
  regionCount,
  orgRows,
  orgCount,
  orgNeedsYouRows,
  orgProjectItems,
  orgPlaceLabel,
  orgSearchText,
  orgSectionOpen,
  orgSections,
  orgsRegionOpen,
  orgTitle,
  projectCount,
  storedOrgsOpen,
  UNKNOWN_PROJECT,
} from "./org-region";

const org = (o: Partial<SessionOrg> = {}): SessionOrg => ({ orgId: "o1", orgName: "Mamluk Arabia", projectId: "p1", projectName: "Rakiba site", kind: "gathering", ...o });

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/w/ws",
    title: id,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    model: null,
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...extra,
  }) as SessionSummary;

const at = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;

test("org → project → rows; orgs and projects by name, Other last; ordinary sessions never enter", () => {
  const sections = orgSections([
    session("plain", { lastActiveAt: at(9) }),
    session("z1", { org: org({ orgId: "o2", orgName: "Zeta", projectId: "p9", projectName: "Alpha" }) }),
    session("a1", { org: org({ projectId: "p2", projectName: "Beta" }) }),
    session("a2", { org: org() }),
    session("a3", { org: org({ projectId: undefined, projectName: undefined, kind: "other" }) }),
    session("a4", { org: org({ projectId: "gone", projectName: undefined }) }),
  ]);
  assert.deepEqual(sections.map((o) => o.name), ["Mamluk Arabia", "Zeta"]);
  assert.deepEqual(sections[0]!.projects.map((p) => p.name), ["Beta", "Rakiba site", UNKNOWN_PROJECT, NO_PROJECT]);
  assert.equal(orgCount(sections[0]!), 4);
  assert.ok(!sections.flatMap((o) => o.projects.flatMap((p) => p.active)).some((s) => s.id === "plain"));
});

test("inside a project: the current overseer is the heading's eye, never a row; Finished holds done and archived only", () => {
  const o = orgSections([
    session("newest", { org: org(), lastActiveAt: at(9) }),
    session("po", { org: org({ kind: "overseer" }), lastActiveAt: at(1) }),
    session("older", { org: org(), lastActiveAt: at(5) }),
    session("cleared", { org: org({ kind: "overseer", finished: true }), lastActiveAt: at(8) }),
    session("done", { org: org({ finished: true }), lastActiveAt: at(3) }),
    session("archived", { org: org(), archived: true, lastActiveAt: at(7) }),
  ])[0]!;
  const p = o.projects[0]!;
  assert.equal(p.overseer?.id, "po");
  assert.deepEqual(p.active.map((s) => s.id), ["newest", "older"], "no pin: rows by activity, the overseer not among them");
  assert.deepEqual(p.finished.map((s) => s.id), ["archived", "done"], "a cleared overseer conversation is not in Finished");
  const drawn = [...p.active, ...p.finished].map((s) => s.id);
  assert.ok(!drawn.includes("po") && !drawn.includes("cleared"), "neither overseer conversation is a row");
  assert.equal(projectCount(p), 4, "counts are rows: the eye and a cleared conversation are not counted");
  assert.equal(orgCount(o), 4);
  assert.deepEqual(orgRows(o).map((s) => s.id).sort(), ["archived", "done", "newest", "older", "po"], "the section still holds its overseer (forced open, working dot)");
});

test("a project with only an overseer is a heading with an eye and no rows; with only cleared ones it is not drawn", () => {
  const onlyEye = orgSections([session("po", { org: org({ kind: "overseer" }) })]);
  assert.equal(onlyEye[0]?.projects[0]?.overseer?.id, "po");
  assert.equal(projectCount(onlyEye[0]!.projects[0]!), 0);
  assert.deepEqual(orgSections([session("c", { org: org({ kind: "overseer", finished: true }) })]), [], "a cleared conversation alone makes no org");
  // An archived current overseer is still the current one: the eye, not a Finished row.
  const archivedPo = orgSections([session("po", { org: org({ kind: "overseer" }), archived: true })])[0]!.projects[0]!;
  assert.equal(archivedPo.overseer?.id, "po");
  assert.equal(archivedPo.finished.length, 0);
});

test("two current overseers in one project: the newest is the eye, the other stays a row", () => {
  const p = orgSections([
    session("old", { org: org({ kind: "overseer" }), lastActiveAt: at(2) }),
    session("new", { org: org({ kind: "overseer" }), lastActiveAt: at(6) }),
  ])[0]!.projects[0]!;
  assert.equal(p.overseer?.id, "new");
  assert.deepEqual(p.active.map((s) => s.id), ["old"]);
});

test("inOrgRegion: org sessions, minus cleared overseer conversations", () => {
  assert.equal(inOrgRegion(session("plain")), false);
  assert.equal(inOrgRegion(session("g", { org: org() })), true);
  assert.equal(inOrgRegion(session("po", { org: org({ kind: "overseer" }) })), true);
  assert.equal(inOrgRegion(session("c", { org: org({ kind: "overseer", finished: true }) })), false);
  assert.equal(inOrgRegion(session("d", { org: org({ finished: true }) })), true, "a finished hand-off stays, in Finished");
  assert.equal(regionCount(orgSections([session("po", { org: org({ kind: "overseer" }) }), session("g", { org: org() })])), 1, "the region counts rows, not the eye");
});

test("the eye: one mark, working before a failed turn before a new reply; none of the last two while open", () => {
  const po = (extra: Partial<SessionSummary> = {}) => session("po", { org: org({ kind: "overseer" }), ...extra });
  const err = { at: 1, message: "boom" } as unknown as SessionSummary["turnError"];
  const cases: [string, ReturnType<typeof overseerEye>][] = [
    ["idle", overseerEye(po(), { selected: null, busy: false })],
    ["working", overseerEye(po({ unread: true, turnError: err }), { selected: null, busy: true })],
    ["error", overseerEye(po({ unread: true, turnError: err }), { selected: null, busy: false })],
    ["unread", overseerEye(po({ unread: true }), { selected: null, busy: false })],
    ["open", overseerEye(po({ unread: true, turnError: err }), { selected: "/s/po.jsonl", busy: false })],
    ["open, working", overseerEye(po(), { selected: "/s/po.jsonl", busy: true })],
  ];
  assert.deepEqual(
    cases.map(([, e]) => [e.mark, e.current]),
    [
      [null, false],
      ["working", false],
      ["error", false],
      ["unread", false],
      [null, true],
      ["working", true],
    ],
  );
  const labels = cases.slice(0, 4).map(([, e]) => eyeLabel("Rakiba site", e.mark));
  assert.equal(new Set(labels).size, 4, "each state names itself differently");
  for (const l of labels) assert.ok(l.startsWith("Open the Rakiba site overseer"), l);
  assert.equal(labels[0], "Open the Rakiba site overseer");
  assert.match(labels[1]!, /working/);
  assert.match(labels[2]!, /failed/);
  assert.match(labels[3]!, /new reply/);
});

test("the region's Needs you: org digest items plus baton waits the digest lacks; never an ordinary or finished row", () => {
  const item = (id: string, since: number): AttentionItem =>
    ({ id, path: `/s/${id}.jsonl`, title: id, where: "~", tier: "act", kind: "needs-input", since, href: "", detail: "Waiting on a dialog." }) as AttentionItem;
  const rows = orgNeedsYouRows({ items: [item("dialog", 5), item("plain", 9)] }, [
    session("plain"),
    session("dialog", { org: org({ kind: "coding" }) }),
    session("asks", { org: org(), baton: { holder: null, state: "open", needsYou: { from: "Sara", question: "Which logo?", since: 7 } } as SessionSummary["baton"] }),
    session("link", { org: org(), baton: { holder: "Ali", state: "open", sendLink: { to: "Ali", question: "Hours?", since: 2 } } as SessionSummary["baton"] }),
    session("gone", { org: org({ finished: true }), baton: { holder: null, state: "done", needsYou: { from: "X", question: "?", since: 99 } } as SessionSummary["baton"] }),
  ]);
  assert.deepEqual(rows.map((r) => r.session.id), ["asks", "dialog", "link"]);
  assert.equal(rows[0]?.detail, "Sara → you: Which logo?");
  assert.equal(rows[2]?.detail, "Send Ali their link: Hours?");
});

test("labels, titles and search text", () => {
  assert.equal(orgPlaceLabel(session("a", { org: org() })), "Mamluk Arabia · Rakiba site");
  assert.equal(orgPlaceLabel(session("a", { org: org({ projectId: undefined, projectName: undefined }) })), "Mamluk Arabia");
  assert.equal(orgPlaceLabel(session("a")), "");
  assert.equal(orgTitle("Mamluk Arabia", 5, 1), "5 sessions in Mamluk Arabia. 1 waiting on you.");
  assert.equal(orgTitle("M", 1, 0), "1 session in M.");
  const text = orgSearchText(session("a", { org: org(), baton: { holder: "Sara", state: "open" } as SessionSummary["baton"] })).toLowerCase();
  for (const q of ["mamluk", "rakiba", "sara"]) assert.ok(text.includes(q), q);
  assert.equal(orgSearchText(session("plain")), "", "an ordinary row gains nothing");
});

test("open state: the region opens by default and remembers a collapse; forced open without touching it", () => {
  assert.equal(storedOrgsOpen(null), true);
  assert.equal(storedOrgsOpen("0"), false);
  const shut = { stored: false, searching: false, holdsSelected: false };
  assert.equal(orgsRegionOpen(shut), false);
  assert.equal(orgsRegionOpen({ ...shut, searching: true }), true);
  assert.equal(orgsRegionOpen({ ...shut, holdsSelected: true }), true);
  assert.equal(orgSectionOpen({ chosen: undefined, searching: false, holdsSelected: false }), true, "orgs open by default");
  assert.equal(orgSectionOpen({ chosen: false, searching: false, holdsSelected: true }), true);
  assert.equal(finishedOpen({ chosen: undefined, searching: false, holdsSelected: false }), false, "Finished starts closed");
  assert.equal(finishedOpen({ chosen: false, searching: false, holdsSelected: true }), true);
});

test("orgProjectItems: projects to pick a main stakeholder for, newest first, narrowed by a search", () => {
  const it = (id: string, since: number, title: string, kind = "project-stakeholder") =>
    ({ id, path: "", title, where: "Acme", tier: "decide", kind, since, href: `#/orgs/o/projects/${id}`, detail: `Pick a main stakeholder for ${title}: Cy left the organization.` }) as AttentionItem;
  const digest = { items: [it("a", 1, "Portal"), it("b", 5, "Site"), it("c", 9, "Other", "roster-proposal")] };
  assert.deepEqual(orgProjectItems(digest).map((x) => x.id), ["b", "a"]);
  assert.deepEqual(orgProjectItems(digest, "port").map((x) => x.id), ["a"]);
  assert.deepEqual(orgProjectItems(digest, "acme").map((x) => x.id), ["b", "a"]);
  assert.deepEqual(orgProjectItems(undefined), []);
});
