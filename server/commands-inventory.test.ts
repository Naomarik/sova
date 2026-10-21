// Run: pnpm test -- server/commands-inventory.test.ts
// The commands inventory (agents/server/commands/overview.md): every route the main listener's app
// registers is exactly one of a catalogue entry, a declared not-a-command class, or a row on the
// pending baseline, which only shrinks; each route's mesh need (`classifyRequest`) is pinned; and
// three text scans, proved on fixtures, list the ChatClientMessage frame types, the document/window
// keydown listeners and the hand-written ToolSpecs per file. All of it is exact both ways against
// server/commands-inventory/baseline.json, and docs/commands.md is rendered from that file.
// SOVA_INVENTORY_OUT=<absolute path> writes the computed baseline there (the assertions still run);
// `node scripts/commands-inventory.mjs` then rewrites the doc. A throwaway PI_CODING_AGENT_DIR; ~/.pi
// is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { COMMANDS } from "../shared/commands-catalog";
import { renderCommandsDoc } from "./commands-inventory/render";
import {
  type Inventory, chatClientTypes, compareInventory, formatInventory, inventoryRoutes, isPageSource, isToolSource, keydownListeners, listFiles,
  OPTED_OUT, PENDING_NEVER_GROWS, ROUTE_CLASSES, optedOut, pendingGrowth, routeOfEntry, toolSpecs,
} from "./commands-inventory/scan";

const REPO = resolve(import.meta.dirname, "..");
const BASELINE = "server/commands-inventory/baseline.json";
const DOC = "docs/commands.md";
const FIXTURES = join(REPO, "server/commands-inventory/fixtures");

const agentDir = mkdtempSync(join(tmpdir(), "sova-inventory-unit-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const fail = (problems: string[], hint: string) => assert.deepEqual(problems, [], `\n${problems.join("\n")}\n${hint}\n`);

// ---- 1. The scans, proved on fixtures ----------------------------------------------------------------

/** A fixture's text and the `// expect: <json>` its first line carries. */
function fixture(name: string): { text: string; expect: unknown } {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  const m = /^\/\/ expect: (.*)$/m.exec(text);
  assert.ok(m, `${name} has no expect line`);
  return { text, expect: JSON.parse(m[1]!) };
}

describe("the scans, on fixtures", () => {
  test("frames: inline members' types, in order; comments and strings are no members; a named or computed member is unresolved", () => {
    const f = fixture("frames.ts.txt");
    assert.deepEqual(chatClientTypes(f.text), f.expect);
    assert.equal(chatClientTypes("export type Other = { type: \"x\" };"), null);
  });

  test("keydown: every document/window form, hidden ones included; comments, elements and other events are not", () => {
    const f = fixture("keydown.ts.txt");
    assert.deepEqual(keydownListeners(f.text).map((l) => l.target), f.expect);
  });

  test("tools: every written form, names from constants resolved, computed ones marked; look-alikes are not", () => {
    const f = fixture("tools.ts.txt");
    assert.deepEqual(toolSpecs(f.text).map((t) => t.name), f.expect);
  });
});

// ---- 2. The route classifier, on a made-up app ----------------------------------------------------------

describe("routes, on a made-up app", () => {
  const routes = [
    { method: "GET", path: "/api/things" },
    { method: "POST", path: "/api/things/:id" },
    { method: "POST", path: "/api/things/rename" },
    { method: "GET", path: "/api/peer/hello" },
    { method: "GET", path: "/api/other" },
    { method: "ALL", path: "/api/*" },
  ];
  const needOf = (m: string, p: string) => (p.startsWith("/api/peer") ? "hello" : m === "GET" ? "sessions" : "admin");
  const entries = [
    { id: "thing.list", route: { method: "GET", path: "/api/things" } },
    { id: "thing.rename", route: { method: "POST", path: "/api/things/rename" } },
    { id: "thing.poke", route: { method: "POST", path: "/api/things/:thing" } },
  ];

  test("each route is a command, a class or pending; a static path wins over a pattern", () => {
    const { rows, problems } = inventoryRoutes(routes, entries, needOf);
    assert.deepEqual(problems, []);
    assert.deepEqual(rows, {
      "ALL /api/*": { need: "sessions", is: "middleware" },
      "GET /api/other": { need: "sessions", is: "pending" },
      "GET /api/peer/hello": { need: "hello", is: "peer" },
      "GET /api/things": { need: "sessions", is: "command", ids: ["thing.list"] },
      "POST /api/things/:id": { need: "admin", is: "command", ids: ["thing.poke"] },
      "POST /api/things/rename": { need: "admin", is: "command", ids: ["thing.rename"] },
    });
  });

  test("an entry on no route, or on a class route, is a problem", () => {
    assert.equal(routeOfEntry({ id: "x", route: { method: "DELETE", path: "/api/things" } }, routes), null);
    const { problems } = inventoryRoutes(routes, [...entries, { id: "bad.peer", route: { method: "GET", path: "/api/peer/hello" } }, { id: "gone", route: { method: "PUT", path: "/api/nowhere" } }], needOf);
    assert.equal(problems.length, 2, problems.join("\n"));
  });

  test("the comparison is exact both ways, and the pending list may not grow", () => {
    const base: Inventory = { routes: inventoryRoutes(routes, entries, needOf).rows, frames: ["a"], keydown: { "src/a.ts": ["window"] }, tools: { "server/t.ts": ["t"] } };
    assert.deepEqual(compareInventory(base, base), []);
    // A new route with no entry.
    const grown = inventoryRoutes([...routes, { method: "POST", path: "/api/new" }], entries, needOf).rows;
    assert.match(compareInventory(base, { ...base, routes: grown }).join("\n"), /POST \/api\/new is new \(pending/);
    assert.deepEqual(pendingGrowth(base, { ...base, routes: grown }), ["POST /api/new"]);
    // A pending route that gained an entry but kept its pending row.
    const gained = inventoryRoutes(routes, [...entries, { id: "other.get", route: { method: "GET", path: "/api/other" } }], needOf).rows;
    assert.match(compareInventory(base, { ...base, routes: gained }).join("\n"), /GET \/api\/other: pending → command: drop its pending row/);
    // A need that moved.
    const wider = inventoryRoutes(routes, entries, (m, p) => (p === "/api/other" ? "admin" : needOf(m, p))).rows;
    assert.match(compareInventory(base, { ...base, routes: wider }).join("\n"), /GET \/api\/other: mesh need sessions → admin/);
    // A stale row, a stale frame, a stale listener, a new tool.
    const fewer = inventoryRoutes(routes.slice(1), entries.slice(1), needOf).rows;
    assert.match(compareInventory(base, { ...base, routes: fewer }).join("\n"), /GET \/api\/things \(command\) is no longer registered/);
    assert.equal(compareInventory(base, { ...base, frames: [] }).length, 1);
    assert.equal(compareInventory(base, { ...base, keydown: {} }).length, 1);
    assert.equal(compareInventory(base, { ...base, tools: { "server/t.ts": ["t", "u"] } }).length, 1);
  });
});

// ---- 2b. The areas left as is, by choice ---------------------------------------------------------------

describe("the areas left as is, by choice", () => {
  const routes = [
    { method: "GET", path: "/api/sessions" },
    { method: "GET", path: "/api/voice/state" },
    { method: "POST", path: "/api/push/test" },
    { method: "GET", path: "/api/settings" },
  ];
  const needOf = () => "sessions";
  const entries = [{ id: "push.test", route: { method: "POST", path: "/api/push/test" } }];
  const base: Inventory = { routes: inventoryRoutes(routes, entries, needOf).rows, frames: [], keydown: {}, tools: {} };

  test("a listed area's route is the class; an entry there still wins, with no problem; a core route stays pending", () => {
    const { rows, problems } = inventoryRoutes(routes, entries, needOf);
    assert.deepEqual(problems, []);
    assert.deepEqual(rows, {
      "GET /api/sessions": { need: "sessions", is: "pending" },
      "GET /api/settings": { need: "sessions", is: "opted-out" },
      "GET /api/voice/state": { need: "sessions", is: "opted-out" },
      "POST /api/push/test": { need: "sessions", is: "command", ids: ["push.test"] },
    });
  });

  test("a new route in a core area is pending growth; one in a listed area is not", () => {
    const more = [...routes, { method: "POST", path: "/api/sessions/new-thing" }, { method: "POST", path: "/api/voice/new-thing" }];
    const now: Inventory = { ...base, routes: inventoryRoutes(more, entries, needOf).rows };
    assert.deepEqual(pendingGrowth(base, now), ["POST /api/sessions/new-thing"]);
    assert.match(compareInventory(base, now).join("\n"), /POST \/api\/sessions\/new-thing is new \(pending/);
  });

  test("taking an area back turns its routes pending, unless each is listed on its own", () => {
    const back = OPTED_OUT.filter((a) => a !== "voice");
    assert.equal(optedOut("GET", "/api/voice/state", back), false);
    assert.equal(optedOut("GET", "/api/voice/state", [...back, "GET /api/voice/state"]), true);
    assert.equal(optedOut("GET", "/api/voicemail", OPTED_OUT), false, "a name is a whole segment");
  });

  test("no listed area is a core one, and the failure names the list only for areas already on it", () => {
    const core = ["sessions", "projects", "overseer", "schedules", "playbooks", "worktrees", "diff", "attachment", "memory", "links", "upload", "transcript", "insights", "explanations", "draft-specs", "targets", "subagents", "chat"];
    assert.deepEqual(OPTED_OUT.filter((a) => core.includes(a)), []);
    assert.match(PENDING_NEVER_GROWS, /only for an area already on it/);
    assert.match(PENDING_NEVER_GROWS, /adding an area is the user's decision/);
  });

  test("each listed area overlaps no other class, at its root or below", () => {
    const others = ROUTE_CLASSES.filter((c) => c.id !== "opted-out");
    const hits = OPTED_OUT.flatMap((a) =>
      ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL"].flatMap((m) =>
        [`/api/${a}`, `/api/${a}/x`, `/api/${a}/:id/y`, `/api/${a}/*`].flatMap((p) => others.filter((c) => c.matches(m, p)).map((c) => `${m} ${p}: ${c.id}`)),
      ),
    );
    assert.deepEqual(hits, []);
  });
});

// ---- 3. The real app and tree, against the baseline ---------------------------------------------------

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { classifyRequest } = await import("./mesh/access");

const routes = inventoryRoutes(
  app.routes.map((r) => ({ method: r.method, path: r.path })),
  COMMANDS,
  (m, p) => classifyRequest(m, p).need,
);
const frames = chatClientTypes(readFileSync(join(REPO, "shared/protocol.ts"), "utf8"));
const perFile = <T>(dirs: string[], keep: (rel: string) => boolean, scan: (text: string) => T[], pick: (t: T) => string) => {
  const out: Record<string, string[]> = {};
  for (const f of listFiles(REPO, dirs, keep)) {
    const found = scan(readFileSync(join(REPO, f), "utf8"));
    if (found.length) out[f] = found.map(pick);
  }
  return out;
};
const actual: Inventory = {
  routes: routes.rows,
  frames: frames?.types ?? [],
  keydown: perFile(["src"], isPageSource, keydownListeners, (l) => l.target),
  tools: perFile(["server", "shared"], isToolSource, toolSpecs, (t) => t.name),
};
if (process.env.SOVA_INVENTORY_OUT) {
  writeFileSync(process.env.SOVA_INVENTORY_OUT, formatInventory(actual));
  console.log(`[inventory] wrote the computed baseline to ${process.env.SOVA_INVENTORY_OUT}`);
}
const baseline: Inventory = JSON.parse(readFileSync(join(REPO, BASELINE), "utf8"));

describe("the real app and tree", () => {
  test("the walk saw the app: hundreds of routes, every catalogue entry on one", () => {
    assert.ok(Object.keys(actual.routes).length > 300, `only ${Object.keys(actual.routes).length} routes`);
    fail(routes.problems, "Each catalogue entry must land on one registered route that is in no class (or in one whose entries win: opted-out).");
    const pointed = new Set(Object.values(actual.routes).flatMap((r) => r.ids ?? []));
    assert.deepEqual(COMMANDS.map((c) => c.id).filter((id) => !pointed.has(id)), []);
  });

  test("no route in an area left as is is pending, or in another class; its entries' routes stay commands", () => {
    const listed = app.routes.filter((r) => optedOut(r.method, r.path));
    assert.ok(listed.length > 200, `only ${listed.length} routes left as is`);
    const others = ROUTE_CLASSES.filter((c) => c.id !== "opted-out");
    assert.deepEqual(listed.flatMap((r) => others.filter((c) => c.matches(r.method, r.path)).map((c) => `${r.method} ${r.path}: ${c.id}`)), []);
    const rows = listed.map((r) => [`${r.method} ${r.path}`, actual.routes[`${r.method} ${r.path}`]!] as const);
    assert.deepEqual(rows.filter(([, row]) => row.is === "pending").map(([k]) => k), []);
    assert.deepEqual([...new Set(rows.map(([, row]) => row.is))].sort(), ["command", "opted-out"]);
    assert.ok(rows.some(([k, row]) => k === "POST /api/push/test" && row.is === "command"), "push.test stays a command");
  });

  test("ChatClientMessage is read whole: every member an inline object with a literal type", () => {
    assert.ok(frames, "no `export type ChatClientMessage =` in shared/protocol.ts");
    assert.deepEqual(frames.unresolved, [], "write each frame inline, or teach server/commands-inventory/scan.ts the form");
  });

  test(`routes, mesh needs, frames, listeners and tools are exactly ${BASELINE}`, () => {
    fail(
      compareInventory(baseline, actual),
      `${BASELINE} is the inventory. A new route needs a catalogue entry (agents/server/commands/overview.md) or a not-a-command class in scan.ts; ` +
        "a route that became a command drops its pending row; a mesh need that moved is reviewed as one. " +
        `Then SOVA_INVENTORY_OUT=$PWD/${BASELINE} pnpm test -- server/commands-inventory.test.ts and node scripts/commands-inventory.mjs.`,
    );
  });

  test(`${DOC} is rendered from the baseline`, () => {
    assert.equal(readFileSync(join(REPO, DOC), "utf8"), renderCommandsDoc(baseline), `${DOC} is stale: node scripts/commands-inventory.mjs`);
  });
});

// ---- 4. HEAD growth guard -------------------------------------------------------------------------------

describe("the pending list in the working tree never grows past the committed one", () => {
  test("no route is pending that HEAD didn't have pending", (t) => {
    let head: Inventory;
    try {
      head = JSON.parse(execFileSync("git", ["show", `HEAD:${BASELINE}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      console.log(`[inventory] HEAD guard skipped: no committed ${BASELINE} (or no git). The checks above still ran.`);
      t.skip?.("no committed baseline");
      return;
    }
    fail(pendingGrowth(head, baseline), `${BASELINE} gained pending rows against HEAD. Give these routes catalogue entries (or a not-a-command class), never a pending row: ${PENDING_NEVER_GROWS}`);
  });
});
