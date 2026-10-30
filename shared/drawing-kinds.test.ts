import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkExtDrawing, distPathError, normalizeDrawingDecl, ownKindWordError, parseKindFile, parseOwnDrawing, type DrawingDecl } from "./drawing-kinds";
import { checkExtCard } from "./transcript-cards";

// A project's or an extension's own drawing kinds (§chat.transcript-cards/drawing-kinds): the
// declaration's strict checks and a fence's body read against its kind.

const k = (over: Partial<DrawingDecl> = {}): DrawingDecl => ({ kind: "project.gantt", accepts: "text", toolkit: 1, guide: "", ...over });

describe("kind.json", () => {
  test("strict: unknown keys, a bad version, a missing view or guide, data only for data", () => {
    const ok = (o: unknown, view = true, guide = true) => parseKindFile("gantt", JSON.stringify(o), view, guide);
    assert.deepEqual(ok({ version: 1, toolkit: 1, accepts: "text", height: 120 }), { ok: true, decl: { kind: "project.gantt", accepts: "text", height: 120, toolkit: 1 } });
    assert.match((ok({ version: 1, toolkit: 1, accepts: "text", title: "x" }) as { error: string }).error, /"title" is not a key/);
    assert.match((ok({ version: 2, toolkit: 1, accepts: "text" }) as { error: string }).error, /version must be 1/);
    assert.match((ok({ version: 1, toolkit: 1, accepts: "text" }, false) as { error: string }).error, /view\.tsx is missing/);
    assert.match((ok({ version: 1, toolkit: 1, accepts: "text" }, true, false) as { error: string }).error, /GUIDE\.md is missing/);
    assert.match((ok({ version: 1, toolkit: 1, accepts: "data" }) as { error: string }).error, /needs data/);
    assert.match((ok({ version: 1, toolkit: 1, accepts: "text", data: { type: "object" } }) as { error: string }).error, /only for a kind that accepts data/);
    assert.match((ok({ version: 1, toolkit: 1, accepts: "svg" }) as { error: string }).error, /accepts must be/);
    assert.match((ok({ version: 1, toolkit: 1, accepts: "text", height: 5000 }) as { error: string }).error, /height/);
    assert.equal(parseKindFile("Gantt", "{}", true, true).ok, false);
  });
});

describe("an extension's declarations (§app.extensions/views)", () => {
  test("drawings: namespaced by the id, paths inside dist", () => {
    const r = checkExtDrawing("Notes", { name: "mindmap", accepts: "text", view: "d/m.js", guide: "d/m.md", toolkit: 1 });
    assert.ok(r.ok);
    assert.equal(r.ok && r.decl.kind, "notes.mindmap");
    for (const p of ["/abs.js", "../up.js", "a//b.js", "https://x/y.js", "a\\b.js", ""]) assert.ok(distPathError(p), p);
    assert.equal(checkExtDrawing("n", { name: "m", accepts: "text", view: "../x.js", guide: "g.md", toolkit: 1 }).ok, false);
  });
  test("cards: a card.json's rules, view inside dist, typed <id>.<name>", () => {
    const ext = { id: "notes", title: "Notes" };
    const ok = checkExtCard(ext, { name: "review", title: "Review", draws: "view", view: "c/r.js", toolkit: 1, data: { type: "object" } }, () => true);
    assert.ok(ok.ok);
    assert.deepEqual(ok.ok && [ok.decl.type, ok.decl.ext], ["notes.review", { id: "notes", title: "Notes", view: "c/r.js" }]);
    assert.match((checkExtCard(ext, { name: "r", title: "R", draws: "view", view: "c/r.js", toolkit: 1, data: { type: "object" } }, () => false) as { error: string }).error, /isn't in dist/);
    assert.match((checkExtCard(ext, { name: "r", title: "R", draws: "status", answer: "at-once", toolkit: 1 }, () => true) as { error: string }).error, /takes no answer/);
    assert.match((checkExtCard(ext, { name: "r", title: "R", draws: "table", view: "x.js", toolkit: 1 }, () => true) as { error: string }).error, /view is only for/);
    assert.match((checkExtCard(ext, { name: "r", title: "R", draws: "table", toolkit: 1, version: 1 }, () => true) as { error: string }).error, /"version" is not a key/);
  });
});

describe("names", () => {
  test("an own kind always has an owner and a dot; Sova's words never pass", () => {
    for (const w of ["flow", "chart", "html", ".gantt", "project.", "project.Gantt", "project.1x"]) assert.ok(ownKindWordError(w), w);
    for (const w of ["project.gantt", "notes.mindmap", "a.b.c-d"]) assert.equal(ownKindWordError(w), null, w);
    assert.equal(normalizeDrawingDecl({ kind: "flow", accepts: "text", toolkit: 1, guide: "" }), null);
  });
});

describe("a fence's body (§chat.transcript-cards/drawing-kinds, What it draws)", () => {
  test("text: the body, with an optional title and caption line", () => {
    const r = parseOwnDrawing(k(), "title: Plan\nA\nB\ncaption: Two steps\n");
    assert.deepEqual(r, { ok: true, drawing: { kind: "project.gantt", title: "Plan", caption: "Two steps", data: "A\nB" } });
    assert.equal(parseOwnDrawing(k(), "title: Only\n").ok, false);
  });
  test("data: JSON that fits the kind's shape, else the line and what to write", () => {
    const d = k({ accepts: "data", data: { type: "object", properties: { tasks: { type: "array", items: { type: "string" } } }, required: ["tasks"] } });
    assert.deepEqual(parseOwnDrawing(d, '{"tasks": ["a"]}'), { ok: true, drawing: { kind: "project.gantt", data: { tasks: ["a"] } } });
    const notJson = parseOwnDrawing(d, '{"tasks":\n ["a",]}');
    assert.equal(notJson.ok, false);
    const misfit = parseOwnDrawing(d, '{"tasks": [1]}');
    assert.equal(misfit.ok, false);
    assert.match((misfit as { message: string }).message, /doesn't fit project\.gantt/);
  });
});
