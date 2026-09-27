// Run: npx tsx --test src/lib/org-region.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, SessionOrg, SessionSummary } from "../../shared/protocol";
import {
  finishedOpen,
  NO_PROJECT,
  orgCount,
  orgNeedsYouRows,
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

test("inside a project: the current overseer first, then newest activity; Finished holds done, cleared and archived", () => {
  const o = orgSections([
    session("newest", { org: org(), lastActiveAt: at(9) }),
    session("po", { org: org({ kind: "overseer" }), lastActiveAt: at(1) }),
    session("older", { org: org(), lastActiveAt: at(5) }),
    session("cleared", { org: org({ kind: "overseer", finished: true }), lastActiveAt: at(8) }),
    session("done", { org: org({ finished: true }), lastActiveAt: at(3) }),
    session("archived", { org: org(), archived: true, lastActiveAt: at(7) }),
  ])[0]!;
  const p = o.projects[0]!;
  assert.deepEqual(p.active.map((s) => s.id), ["po", "newest", "older"], "the hub is pinned though it is the oldest");
  assert.deepEqual(p.finished.map((s) => s.id), ["cleared", "archived", "done"], "a cleared overseer is never pinned");
  assert.equal(projectCount(p), 6);
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
