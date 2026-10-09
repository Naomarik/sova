import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrgBatonRow, OrgGitStatus, Person } from "../../shared/orgs";
import { orgTabsOf, stakeholderToPick } from "./org-tabs";

const git: OrgGitStatus = { remote: null, lastCommit: null, lastError: null, dirty: false };
const baton = (waiting?: OrgBatonRow["waiting"]): OrgBatonRow => ({ sessionId: "s", path: "/p", publicTitle: "t", projectId: "j", state: "open", holder: null, createdAt: "", ...(waiting ? { waiting } : {}) });
const person = (status: Person["status"]): Person => ({ id: "p", orgId: "o", name: "n", status, contact: {}, role: "", decides: [], skills: [], competence: {}, language: "", voice: "" });

test("an empty org: counts 0, History and Workspace uncounted, no dots", () => {
  const tabs = orgTabsOf({ batons: [], roster: [], projectList: [], problems: [], git });
  assert.deepEqual(
    tabs.map((t) => [t.id, t.count, t.waiting, t.waitingText]),
    [
      ["sessions", 0, 0, ""],
      ["people", 0, 0, ""],
      ["projects", 0, 0, ""],
      ["history", null, 0, ""],
      ["workspace", null, 0, ""],
    ],
  );
});

test("each tab counts its own rows and dots what waits inside it", () => {
  const tabs = orgTabsOf({
    batons: [baton("reply"), baton("link"), baton("link"), baton()],
    roster: [person("active"), person("proposed"), person("left")],
    projectList: [{ id: "j1", orgId: "o", name: "P", root: "/r", origin: "manual", createdAt: "" }],
    projectConflicts: { j1: 2 },
    problems: ["roster.json does not parse"],
    git: { ...git, lastError: "push rejected" },
  });
  const by = Object.fromEntries(tabs.map((t) => [t.id, t]));
  assert.equal(by.sessions!.count, 4);
  assert.equal(by.sessions!.waiting, 3);
  assert.equal(by.sessions!.waitingText, "1 to answer · 2 links to send");
  assert.equal(by.people!.count, 3);
  assert.equal(by.people!.waitingText, "1 person to approve");
  assert.equal(by.projects!.waiting, 2);
  assert.equal(by.projects!.waitingText, "2 conflicts to settle");
  assert.equal(by.workspace!.waiting, 2);
  assert.equal(by.workspace!.waitingText, "1 file problem · the last commit or push failed");
});

test("a project whose main stakeholder left waits in Projects until one is picked", () => {
  const cleared = { personId: "p_x", name: "Cy", at: "2026-09-27T10:00:00Z" };
  const project = (over: Record<string, unknown>) => ({ id: "j", orgId: "o", name: "P", root: "/r", origin: "manual" as const, createdAt: "", ...over });
  const tabs = orgTabsOf({
    batons: [],
    roster: [],
    projectList: [project({ id: "j1", stakeholder: null, stakeholderCleared: cleared }), project({ id: "j2", stakeholder: "p_a", stakeholderCleared: cleared }), project({ id: "j3" })],
    projectConflicts: { j3: 1 },
    problems: [],
    git,
  });
  const projects = tabs.find((t) => t.id === "projects")!;
  assert.equal(projects.waiting, 2);
  assert.equal(projects.waitingText, "1 conflict to settle · 1 stakeholder to pick");
  assert.equal(stakeholderToPick({ stakeholder: null, stakeholderCleared: cleared }), true);
  assert.equal(stakeholderToPick({ stakeholder: "p_a", stakeholderCleared: cleared }), false);
  assert.equal(stakeholderToPick({}), false);
});

test("held acts wait in Projects (§app.project-overseer/holds)", () => {
  const tabs = orgTabsOf({ batons: [], roster: [], projectList: [], problems: [], git, needsYou: { replies: 0, links: 0, proposals: 0, conflicts: 0, held: 1 } });
  const projects = tabs.find((t) => t.id === "projects")!;
  assert.equal(projects.waiting, 1);
  assert.equal(projects.waitingText, "1 held act");
});
