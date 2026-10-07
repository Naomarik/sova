// Run: node scripts/run-tests.mjs server/share-wire.integration.test.ts. The share pages and the harness wire (§app.harness/wire,
// "Hops change nothing"): a share page's socket and API carry no live events and no row facts, and a page
// that asks for wire 2 gets exactly what one that doesn't gets. On every committed golden fixture (and the
// local real corpus when present, assertions only, nothing recorded):
// - a session share's view, through the share listener's /ws/s socket and GET /api/s/<token>, with and
//   without `wire=2`: the same bytes, no `event`, `meta` or `facts` key anywhere, and the view frame equal to
//   golden/wire/share/<set>/<fixture>/session-share-view.json (recorded on the server before wire 2, see the
//   golden wire README);
// - the baton view (§app.baton/outsider-view) for the operator and for a person: no such key either (its
//   content is pinned by golden.test's baton-view probe, recorded before M3).
// Re-record (missing and differing files; review the diff): SOVA_GOLDEN_MODE=record pnpm test -- server/share-wire.integration.test.ts. A throwaway
// PI_CODING_AGENT_DIR in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-wire-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const sessions = join(root, "agent", "sessions", "--share-wire--");
mkdirSync(sessions, { recursive: true });
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>Shared</title>");

const g = await import("./harness/pi/golden/golden");
const { sessionShareView, resetShareViewCache } = await import("./session-share-view");
const { createShare } = await import("./session-shares");
const { pushView, viewerCount } = await import("./session-share-presence");
const { createShareServer } = await import("./share/listener");
const { batonView } = await import("./baton-view");
const { branchOf, parsePi } = await import("./harness/pi/reader");

// Every request its own rate-limit key: the corpus makes more requests than one address may.
let clients = 0;
const server = createShareServer({ client: () => `share-wire-${++clients}` });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
after(() => {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

const SHARE = join(g.GOLDEN_DIR, "wire/share");
const mode: import("./harness/pi/golden/golden").Mode = process.env.SOVA_GOLDEN_MODE === "record" ? "record" : "compare";
const produced = new Set<string>();
const sets = g.fixtureSets().filter((s) => s.fixtures.some((f) => f.format === "pi"));

/** Every key named `event`, `meta` or `facts` anywhere in a JSON value, as JSON paths. */
function wireKeys(v: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => wireKeys(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "event" || k === "meta" || k === "facts") out.push(`${path}.${k}`);
      wireKeys(x, `${path}.${k}`, out);
    }
  return out;
}

/** Every frame a share page's socket gets while the operator pushes `view` once. */
async function socketFrames(token: string, shareId: string, view: unknown, ask: string): Promise<string[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/s?token=${token}${ask}`);
  const got: string[] = [];
  ws.on("message", (d) => got.push(String(d)));
  await new Promise<void>((ok, fail) => (ws.once("open", () => ok()), ws.once("error", fail)));
  // The page is among the share's viewers before the push (a hang guard, not a bound).
  for (const end = Date.now() + 10_000; viewerCount(shareId) === 0; await new Promise((r) => setTimeout(r, 5)))
    assert.ok(Date.now() < end, "the page registered as a viewer");
  pushView(shareId, view as never);
  const end = Date.now() + 10_000;
  while (!got.some((f) => f.startsWith('{"type":"view"')) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  ws.close();
  return got;
}

const NAMES = { p_alice: "Alice", p_bob: "Bob", operator: "Omar" };
const ROW = { publicTitle: "Golden launch", state: "active", holder: "p_alice" } as never;

let n = 0;
for (const set of sets)
  describe(`${set.name}: share pages carry no wire`, () => {
    for (const fx of set.fixtures.filter((f) => f.format === "pi")) {
      const label = set.private ? g.shortHash(fx.path) : fx.name;
      test(`${set.name}/${label}`, async () => {
        const text = readFileSync(fx.path, "utf8");
        const sessionPath = join(sessions, `2026-10-05T00-00-00-${String(++n).padStart(3, "0")}Z_share-wire-${n}.jsonl`);
        writeFileSync(sessionPath, text);
        resetShareViewCache();
        const src = { sessionPath, cutEntryId: null, from: null, title: "Golden share", sharedAt: "2026-10-05T00:00:00.000Z", mode: "live" as const };
        const view = await sessionShareView(src);
        const frame = view ? { type: "view", view } : null;
        if (!set.private) {
          const r = g.settle({ ...set, expected: join(SHARE, set.name) }, fx.name, "session-share-view", frame, mode);
          produced.add(r.path);
          const where = relative(g.REPO, r.path);
          if (r.status === "missing") assert.fail(`no expected file ${where}. Record it: SOVA_GOLDEN_MODE=record pnpm test -- server/share-wire.integration.test.ts`);
          if (r.status === "differs") assert.fail(`${where}: differs at ${r.where}${r.detail ? ` (${r.detail})` : ""}`);
        }
        assert.deepEqual(wireKeys(frame), [], "the view frame carries no event, meta or facts");

        const branch = branchOf(parsePi(text).entries);
        for (const viewer of [undefined, "p_bob"]) {
          const baton = { type: "view", view: batonView({ row: ROW, branch, names: NAMES, ...(viewer ? { viewer: viewer as never } : {}), redact: (t) => t }) };
          assert.deepEqual(wireKeys(baton), [], `the baton view (${viewer ?? "operator"}) carries no event, meta or facts`);
        }

        if (!view) return; // a file the share refuses (broken): no page to open
        const { share, tokens } = createShare({ sessionId: `share-wire-${n}`, sessionPath, title: src.title, mode: "live", cut: null, days: 30, labels: ["Ana"], anyone: true });
        const token = tokens[0]!.token;
        const answers: Record<string, string[]> = {};
        for (const ask of ["", "&wire=2", "&wire=2&v=1"]) {
          const api = await fetch(`http://127.0.0.1:${port}/api/s/${token}${ask.replace("&", "?")}`);
          assert.equal(api.status, 200, `/api/s${ask}`);
          const body = await api.text();
          const frames = await socketFrames(token, share.id, view, ask);
          assert.ok(frames.some((f) => f.startsWith('{"type":"view"')), `the socket${ask} got the view`);
          for (const f of [body, ...frames]) assert.deepEqual(wireKeys(JSON.parse(f)), [], `${ask || "no wire"}: ${f.slice(0, 80)}`);
          assert.deepEqual(
            frames.filter((f) => f.startsWith('{"type":"view"')).map((f) => JSON.parse(f)),
            [JSON.parse(JSON.stringify(frame))],
            `the socket${ask} carried the view frame as built`,
          );
          answers[ask] = [body, ...frames];
        }
        assert.deepEqual(answers["&wire=2"], answers[""], "wire=2 changes no byte of the API or the socket");
        assert.deepEqual(answers["&wire=2&v=1"], answers[""], "nor does it with a tab id");
      });
    }
  });

test("no stale share expected files", () => {
  const stale: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!produced.has(p)) stale.push(relative(g.REPO, p));
    }
  };
  if (existsSync(SHARE)) walk(SHARE);
  assert.deepEqual(stale, [], "expected files no fixture produces: remove them");
});
