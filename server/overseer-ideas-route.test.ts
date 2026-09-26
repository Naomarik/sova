// Run: npx tsx --test server/overseer-ideas-route.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. The server is imported
// with PORT=0 so it binds an ephemeral port instead of the dev port.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { OverseerIdeaDetail, OverseerIdeasInfo } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-ideas-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";

const { app, server } = await import("./index");
const { disposeAllChats } = await import("./chat-manager");
const ideas = await import("./overseer-ideas");

after(async () => {
  server.close();
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

const patch = (id: string, body: unknown) =>
  app.request(`/api/overseer/idea?id=${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the ideas routes", () => {
  test("GET ideas: the ToC, every record and the link edges, no prose", async () => {
    ideas.addIdea({ id: "mesh/retry", title: "Retry", text: "PROSE-ONLY-IN-DETAIL" });
    ideas.addIdea({ id: "mesh/health", title: "Health", links: ["mesh/retry"] });
    const res = await app.request("/api/overseer/ideas");
    assert.equal(res.status, 200);
    const info = (await res.json()) as OverseerIdeasInfo;
    assert.equal(info.toc.total, 2);
    assert.deepEqual(info.edges, [{ from: "§mesh/health", to: "§mesh/retry" }]);
    assert.equal(info.dir, join(agentDir, "sova", "ideas"));
    assert.doesNotMatch(JSON.stringify(info), /PROSE-ONLY-IN-DETAIL/);
  });

  test("GET idea: the detail with prose, scope and linkedBy; § optional; 404 unknown, 400 malformed", async () => {
    const res = await app.request(`/api/overseer/idea?id=${encodeURIComponent("mesh/retry")}`);
    assert.equal(res.status, 200);
    const d = (await res.json()) as OverseerIdeaDetail;
    assert.equal(d.idea.id, "§mesh/retry");
    assert.match(d.text, /PROSE-ONLY-IN-DETAIL/);
    assert.deepEqual(d.linkedBy, ["§mesh/health"]);
    assert.equal((await app.request("/api/overseer/idea?id=%C2%A7mesh%2Fnope")).status, 404);
    assert.equal((await app.request("/api/overseer/idea?id=Not%20an%20id")).status, 400);
  });

  test("PATCH: a fresh base saves, a stale one is 409 with the current idea, and nothing is lost", async () => {
    const start = ((await (await app.request("/api/overseer/idea?id=mesh%2Fretry")).json()) as OverseerIdeaDetail).idea.updatedAt;
    // The Overseer appends while the panel's editor is open.
    ideas.updateIdea("mesh/retry", { append: "PLAN: from the explorer" });
    const stale = await patch("§mesh/retry", { base: start, text: "the panel's edit" });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { error: string; current: OverseerIdeaDetail };
    assert.match(conflict.error, /changed since you opened it/);
    assert.match(conflict.current.text, /PLAN: from the explorer/);
    const ok = await patch("§mesh/retry", { base: conflict.current.idea.updatedAt, title: "Retry peers", tags: ["reliability"], status: "done" });
    assert.equal(ok.status, 200);
    const d = (await ok.json()) as OverseerIdeaDetail;
    assert.equal(d.idea.title, "Retry peers");
    assert.equal(d.idea.status, "done");
    assert.match(d.text, /PLAN: from the explorer/, "the append survived");
  });

  test("PATCH refuses bad input with 400: a bad status, a link to itself or to no idea, a wrong type; unknown id 404", async () => {
    assert.equal((await patch("mesh/health", { status: "someday" })).status, 400);
    assert.equal((await patch("mesh/health", { links: ["mesh/health"] })).status, 400);
    assert.equal((await patch("mesh/health", { links: ["mesh/none"] })).status, 400);
    assert.equal((await patch("mesh/health", { tags: "x" })).status, 400);
    assert.equal((await patch("mesh/none", { title: "x" })).status, 404);
    await patch("mesh/health", { status: "dropped" });
    const again = await patch("mesh/health", { status: "open" });
    assert.equal(again.status, 400);
    assert.match(((await again.json()) as { error: string }).error, /dropped is final/);
  });

  test("PATCH newId renames: the answer is the new detail, the old id still reads, and the todos follow", async () => {
    const { addTodo, readTodos } = await import("./overseer-todos");
    ideas.addIdea({ id: "rt/a", title: "A", text: "A-TEXT" });
    ideas.addIdea({ id: "rt/b", title: "B", links: ["rt/a"] });
    addTodo({ text: "todo on a", ideaId: "rt/a" });
    const base = ideas.getIdea("rt/a")!.updatedAt;
    const res = await patch("rt/a", { base, newId: "rt/renamed", title: "A renamed" });
    assert.equal(res.status, 200);
    const d = (await res.json()) as OverseerIdeaDetail;
    assert.equal(d.idea.id, "§rt/renamed");
    assert.equal(d.idea.title, "A renamed", "the other fields were applied too");
    assert.deepEqual(d.idea.renamedFrom, ["§rt/a"]);
    assert.match(d.text, /A-TEXT/);
    assert.deepEqual(d.linkedBy, ["§rt/b"]);
    const old = await app.request(`/api/overseer/idea?id=${encodeURIComponent("rt/a")}`);
    assert.equal(old.status, 200);
    assert.equal(((await old.json()) as OverseerIdeaDetail).idea.id, "§rt/renamed");
    assert.equal(readTodos().todos.find((t) => t.text === "todo on a")?.ideaId, "§rt/renamed");
    const list = (await (await app.request("/api/overseer/ideas")).json()) as OverseerIdeasInfo;
    assert.deepEqual(list.ideas.find((r) => r.id === "§rt/renamed")?.renamedFrom, ["§rt/a"], "the list carries the former ids the panel follows");
  });

  test("PATCH newId: 400 for a malformed, live or former id (nothing saved), 409 for a stale base, 404 unknown; the same id is no rename", async () => {
    const cur = ideas.getIdea("rt/b")!;
    for (const newId of ["Not An Id", "rt/renamed", "rt/a"]) {
      const res = await patch("rt/b", { base: cur.updatedAt, newId, title: "must not save" });
      assert.equal(res.status, 400, newId);
    }
    assert.equal(ideas.getIdea("rt/b")!.title, "B", "a refused rename saved none of the other fields");
    assert.equal(ideas.getIdea("rt/b")!.updatedAt, cur.updatedAt);
    assert.equal((await patch("rt/b", { newId: 7 })).status, 400);
    ideas.updateIdea("rt/b", { append: "meanwhile" });
    const stale = await patch("rt/b", { base: cur.updatedAt, newId: "rt/b2" });
    assert.equal(stale.status, 409);
    assert.match(((await stale.json()) as { current: OverseerIdeaDetail }).current.text, /meanwhile/);
    assert.ok(ideas.getIdea("rt/b") && !ideas.getIdea("rt/b2"));
    assert.equal((await patch("rt/none", { newId: "rt/x" })).status, 404);
    const same = await patch("rt/b", { newId: "§rt/b", title: "Same id" });
    assert.equal(same.status, 200);
    assert.equal(((await same.json()) as OverseerIdeaDetail).idea.renamedFrom, undefined);
  });
});
