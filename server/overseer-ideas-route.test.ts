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
});
