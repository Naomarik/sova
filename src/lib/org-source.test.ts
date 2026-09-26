// Run: pnpm exec tsx --test src/lib/org-source.test.ts. Solid's reactive (browser) build and a stub
// `document`: the row has to change between polls, with nobody touching the page.
import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";
import type { OrgDetail } from "../../shared/orgs";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `const to = { "solid-js": "solid-js/dist/solid.js", "solid-js/store": "solid-js/store/dist/store.js" };
       export async function resolve(s, c, next) { return next(to[s] ?? s, c); }`,
    ),
  import.meta.url,
);
(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const solid = await import("solid-js");
const { createOrgSource, ORG_POLL_MS } = await import("./org-source");

const orgWith = (state: string, holder: string | null) =>
  ({ id: "org_1", name: "Acme", roster: [], projectList: [], batons: [{ path: "/s/a.jsonl", publicTitle: "Invoices", state, holder, createdAt: "2026-09-27T00:00:00Z" }] }) as unknown as OrgDetail;

test("a session that finishes elsewhere updates its row on the open page, the row kept in place", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let server = orgWith("open", "Maria");
    const flush = () => new Promise<void>((r) => setImmediate(r));
    const seen: string[] = [];
    let firstRow: unknown;
    const dispose = solid.createRoot((dispose) => {
      const org = createOrgSource("org_1", async () => server);
      solid.createRenderEffect(() => {
        const b = org.data()?.batons[0];
        if (!b) return;
        firstRow ??= b;
        seen.push(`${b.state}:${b.holder ?? "-"}:${b === firstRow}`);
      });
      return dispose;
    });
    await flush();
    assert.deepEqual(seen, ["open:Maria:true"]);
    server = orgWith("done", null);
    mock.timers.tick(ORG_POLL_MS);
    await flush();
    assert.deepEqual(seen.at(-1), "done:-:true");
    dispose();
  } finally {
    mock.timers.reset();
  }
});
