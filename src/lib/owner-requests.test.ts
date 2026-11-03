import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerRequest } from "../../shared/project-assistant";
import { closedLine, emptyLine, filterCounts, filterShowing, groupRequests, needsGotIt, openRequestsLine, REQUEST_FILTERS, STATUS_TONE, STATUS_WORD, statusWord, underFilter } from "./owner-requests";

const req = (id: string, status: OwnerRequest["status"], projectId: string, createdAt: string): OwnerRequest => ({ id, projectId, kind: "bug", title: id, text: "", status, createdAt, updatedAt: createdAt });
const projects = [
  { projectId: "p1", name: "Shop" },
  { projectId: "p2", name: "Site" },
];

test("the filters: Open is with-team and started, Done, Declined and Closed by Owner their own, All everything", () => {
  assert.deepEqual(
    REQUEST_FILTERS.map((f) => f.label),
    ["Open", "Done", "Declined", "Closed by Owner", "All"],
  );
  const statuses = ["with-team", "started", "done", "declined", "closed"] as const;
  const under = (f: (typeof REQUEST_FILTERS)[number]["id"]) => statuses.filter((s) => underFilter({ status: s }, f));
  assert.deepEqual(under("open"), ["with-team", "started"]);
  assert.deepEqual(under("done"), ["done"]);
  assert.deepEqual(under("declined"), ["declined"]);
  assert.deepEqual(under("closed"), ["closed"]);
  assert.deepEqual(under("all"), [...statuses]);
  assert.deepEqual(filterCounts(statuses.map((s) => ({ status: s }))), { open: 2, done: 1, declined: 1, closed: 1, all: 5 });
});

test("a request the owner closed: its chip names them, its line says how, Got It only for one closed during work", () => {
  const by = (kind: "owner" | "assistant") => ({ by: { kind, personId: "p1" }, at: "2026-10-24T00:00:00Z", prior: "started" as const });
  assert.equal(statusWord({ status: "closed" }, "Omar Haddad"), "Closed by Omar");
  assert.equal(statusWord({ status: "done" }, "Omar Haddad"), "Done");
  assert.equal(closedLine({ closed: by("owner") }, "Omar Haddad", "2h ago"), "Closed 2h ago · by Omar");
  assert.equal(closedLine({ closed: by("assistant") }, "Omar Haddad", "2h ago"), "Closed 2h ago · through the Project Assistant");
  assert.equal(closedLine({}, "Omar", "now"), null);
  assert.equal(needsGotIt({ status: "closed", closed: by("owner") }), true);
  assert.equal(needsGotIt({ status: "closed", closed: { ...by("owner"), noted: true } }), false);
  assert.equal(needsGotIt({ status: "closed", closed: { ...by("owner"), prior: "with-team" } }), false);
  assert.equal(filterShowing({ status: "closed" }, "open"), "closed");
  assert.equal(emptyLine([{ status: "with-team" }], "closed", "Omar Haddad"), "1 open request. Omar hasn't closed any.");
});

test("a focused request outside the filter switches to the filter that shows it", () => {
  assert.equal(filterShowing({ status: "done" }, "open"), "done");
  assert.equal(filterShowing({ status: "declined" }, "open"), "declined");
  assert.equal(filterShowing({ status: "started" }, "done"), "open");
  assert.equal(filterShowing({ status: "done" }, "all"), "all", "already shown: kept");
});

test("rows group under their project, newest first; the group with the newest request leads", () => {
  const rs = [req("a", "with-team", "p1", "2026-10-01T00:00:00Z"), req("b", "started", "p2", "2026-10-03T00:00:00Z"), req("c", "with-team", "p1", "2026-10-02T00:00:00Z"), req("d", "done", "p2", "2026-10-04T00:00:00Z"), req("e", "with-team", "gone", "2026-09-01T00:00:00Z")];
  const g = groupRequests(rs, "open", projects);
  assert.deepEqual(
    g.map((x) => [x.name, x.rows.map((r) => r.id)]),
    [
      ["Site", ["b"]],
      ["Shop", ["c", "a"]],
      ["A project", ["e"]],
    ],
  );
  assert.deepEqual(
    groupRequests(rs, "done", projects).map((x) => x.rows.map((r) => r.id)),
    [["d"]],
  );
});

test("each status has a word and a chip tone; with the team is the warn one", () => {
  assert.equal(STATUS_WORD["with-team"], "With the team");
  assert.equal(STATUS_WORD.started, "Being worked on");
  assert.equal(STATUS_TONE["with-team"], "warn");
  assert.equal(STATUS_TONE.declined, undefined);
});

test("empty states say a live fact first; the owner card's line counts open requests", () => {
  const rs = [{ status: "done" as const }, { status: "done" as const }, { status: "declined" as const }];
  assert.equal(emptyLine(rs, "open", "Omar Haddad"), "2 done. Nothing open from Omar right now.");
  assert.equal(emptyLine([], "open", "Omar"), "0 done. Nothing open from Omar right now.");
  assert.equal(emptyLine([{ status: "started" }], "done", "Omar"), "1 open request. None marked done yet.");
  assert.equal(openRequestsLine(1, "Omar Haddad"), "1 open request from Omar");
  assert.equal(openRequestsLine(3, "Omar"), "3 open requests from Omar");
});
