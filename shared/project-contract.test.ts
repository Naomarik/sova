import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closureOf,
  DEFINITION_KEYS,
  DefinitionError,
  ERROR_CODES,
  exitOf,
  httpStatusOf,
  ISOLATION_METHODS,
  isVerbResult,
  ordered,
  parseDefinition,
  portsFor,
  render,
  scratchSlots,
  serviceOrder,
  type VerbResult,
} from "./project-contract";

const parse = (o: unknown) => parseDefinition(JSON.stringify(o));
/** The JSON path a bad definition is refused at. */
const refusedAt = (o: unknown): string => {
  try {
    parse(o);
  } catch (err) {
    assert.ok(err instanceof DefinitionError, String(err));
    return err.path;
  }
  assert.fail("expected the definition to be refused");
};

test("a static site is one service with one port", () => {
  const def = parse({ version: 1, services: { site: { static: ".", ports: { http: { base: 8731 } } } } });
  assert.equal(def.services.length, 1);
  assert.equal(def.services[0]!.static, ".");
  assert.equal(def.services[0]!.reload, "none");
  assert.deepEqual(portsFor(def, 0), { site: { http: 8731 } });
  assert.deepEqual(portsFor(def, 3), { site: { http: 8734 } });
  assert.deepEqual(scratchSlots(def), [5, 6]);
});

test("a full definition parses with defaults filled in", () => {
  const def = parse({
    version: 1,
    slots: { cap: 2 },
    host: ["DATOMIC_HOME"],
    setup: [{ id: "deps", run: ["pnpm", "install"], inputs: ["pnpm-lock.yaml"] }],
    data: { agent: { kind: "dir", path: ".agent" }, seed: { kind: "dir", from: "${main}/seed" }, db: { kind: "hook", provision: ["./p"], deprovision: ["./d"] } },
    services: {
      redis: { cmd: ["redis-server", "--port", "${ports.redis.main}"], scope: "shared", ports: { main: { fixed: 6390 } } },
      server: {
        cmd: ["node", "server.js"],
        env: { PORT: "${ports.server.http}", AGENT: "${data.agent}", COST: "$$5" },
        ports: { http: { base: 4810, stride: 10 } },
        requires: ["redis"],
        ready: { http: "http", path: "/api/health", timeout: 90 },
        reload: { signal: "HUP" },
        build: { run: ["make"], inputs: ["Makefile"] },
      },
      db: { cmd: ["docker", "run", "--rm", "--name", "sova-${instance}-db", "-p", "${ports.db.pg}:5432", "postgres"], container: { name: "sova-${instance}-db" }, ports: { pg: { base: 5500 } } },
    },
    hooks: { probe: { run: ["./probe"] } },
    share: { allow: false },
    deploy: { targets: {} },
  });
  assert.equal(def.slots.cap, 2);
  assert.equal(def.setup[0]!.timeout, 120);
  const server = def.services.find((s) => s.name === "server")!;
  assert.deepEqual(server.ready, { http: "http", path: "/api/health", timeout: 90 });
  assert.equal(server.scope, "checkout");
  assert.equal(def.services.find((s) => s.name === "db")!.container!.engine, "docker");
  assert.deepEqual(portsFor(def, 2).server, { http: 4830 });
  assert.deepEqual(portsFor(def, 2).redis, { main: 6390 });
  assert.deepEqual(def.data.map((d) => d.name), ["agent", "seed", "db"]);
  assert.deepEqual(serviceOrder(def).map((s) => s.name), ["redis", "server", "db"]);
  assert.deepEqual(closureOf(def, ["server"]).map((s) => s.name), ["redis", "server"]);
});

test("refusals name the JSON path of the first problem", () => {
  const svc = { static: ".", ports: { http: { base: 8000 } } };
  assert.equal(refusedAt({ version: 1, services: { site: svc }, extra: 1 }), "$.extra");
  assert.equal(refusedAt({ version: 2, services: { site: svc } }), "$.version");
  assert.equal(refusedAt({ version: 1, services: {} }), "$.services");
  assert.equal(refusedAt({ version: 1, services: { Site: svc } }), "$.services.Site");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: "npm start" } } }), "$.services.web.cmd");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["npm", ""] } } }), "$.services.web.cmd[1]");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["x"], static: "." } } }), "$.services.web");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["x"], env: { SOVA_SLOT: "1" } } } }), "$.services.web.env.SOVA_SLOT");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["x"], env: { SOVA_PORT_WEB_HTTP: "1" } } } }), "$.services.web.env.SOVA_PORT_WEB_HTTP");
  // Sova's own configuration (Sova as a project) is an app's env like any other.
  assert.doesNotThrow(() => parse({ version: 1, services: { web: { cmd: ["x"], env: { SOVA_PRICES_FETCH: "off" } } } }));
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["x", "${nope}"] } } }), "$.services.web.cmd[1]");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["x", "$HOME"] } } }), "$.services.web.cmd[1]");
  assert.equal(refusedAt({ version: 1, services: { web: { cmd: ["x"], cwd: "../up" } } }), "$.services.web.cwd");
  assert.equal(refusedAt({ version: 1, services: { site: { static: ".git", ports: { http: { base: 8000 } } } } }), "$.services.site.static");
  assert.equal(refusedAt({ version: 1, services: { site: { ...svc, env: { A: "b" } } } }), "$.services.site.env");
  assert.equal(refusedAt({ version: 1, services: { a: { cmd: ["x"], requires: ["b"] }, b: { cmd: ["y"], requires: ["a"] } } }), "$.services.a.requires");
  assert.equal(refusedAt({ version: 1, services: { a: { cmd: ["x"], requires: ["zzz"] } } }), "$.services.a.requires");
  assert.equal(refusedAt({ version: 1, services: { r: { cmd: ["x"], scope: "shared", ports: { p: { base: 7000 } } } } }), "$.services.r.ports.p");
  assert.equal(refusedAt({ version: 1, services: { w: { cmd: ["x"], ports: { p: { base: 65530 } } } } }), "$.services.w.ports.p");
  // The same port in one slot, and ranges that meet across slots (a's slot 1 is b's slot 0).
  assert.equal(refusedAt({ version: 1, services: { a: { cmd: ["x"], ports: { p: { fixed: 9000 } } }, b: { cmd: ["y"], ports: { p: { base: 9000 } } } } }), "$.services.b.ports.p");
  assert.equal(refusedAt({ version: 1, services: { a: { cmd: ["x"], ports: { p: { base: 9000 } } }, b: { cmd: ["y"], ports: { p: { base: 9001 } } } } }), "$.services.a.ports.p");
  assert.doesNotThrow(() => parse({ version: 1, services: { a: { cmd: ["x"], ports: { p: { base: 9000, stride: 10 } } }, b: { cmd: ["y"], ports: { p: { base: 9001, stride: 10 } } } } }));
  assert.equal(refusedAt({ version: 1, services: { w: { cmd: ["x"], ports: { p: { base: 9000 } }, ready: { tcp: "q" } } } }), "$.services.w.ready.tcp");
  assert.equal(refusedAt({ version: 1, services: { w: { cmd: ["x"], reload: { signal: "KILL" } } } }), "$.services.w.reload.signal");
  assert.equal(refusedAt({ version: 1, services: { w: { cmd: ["x"] } }, data: { d: { kind: "redis" } } }), "$.data.d.kind");
  assert.equal(refusedAt({ version: 1, services: { w: { cmd: ["x"] } }, setup: [{ id: "a", run: ["x"] }, { id: "a", run: ["y"] }] }), "$.setup");
  assert.equal(refusedAt({ version: 1, services: { w: { cmd: ["x"] } }, hooks: { teardown: { run: ["x"] } } }), "$.hooks.teardown");
  assert.throws(() => parseDefinition("{not json"), (e) => e instanceof DefinitionError && e.path === "$");
});

test("templates render every known variable and $$ as a literal $", () => {
  assert.equal(render("${ports.web.http}/x $$HOME", { "ports.web.http": "4010" }), "4010/x $HOME");
  assert.throws(() => render("${slot}", {}), /no value/);
});

test("every error code has one exit class and one status", () => {
  const want: Record<number, string[]> = {
    1: ["not-ready", "start-failed", "hook-failed", "tests-failed"],
    2: ["not-approved", "not-conformant", "cap-reached", "port-held", "dirty-worktree", "unsupported", "refused-slot0", "share-denied", "forbidden", "needs-confirm"],
    3: ["invalid-request", "invalid-definition", "not-found"],
    4: ["busy"],
  };
  const seen = Object.values(want).flat();
  assert.deepEqual([...seen].sort(), [...ERROR_CODES].sort(), "the classes cover the closed list exactly");
  for (const [cls, codes] of Object.entries(want))
    for (const code of codes) {
      assert.equal(exitOf({ error: { code } as never }), Number(cls), code);
      const status = httpStatusOf({ error: { code } as never });
      assert.equal(status, code === "not-found" ? 404 : { 1: 502, 2: 409, 3: 400, 4: 423 }[Number(cls)], code);
    }
  assert.equal(exitOf({}), 0);
  assert.equal(httpStatusOf({}), 200);
});

test("ordered results keep one key order and isVerbResult checks it", () => {
  const base: VerbResult = {
    at: "t",
    approved: true,
    defHash: null,
    links: [],
    data: [],
    services: [],
    steps: [],
    state: "absent",
    changed: false,
    ok: true,
    branch: null,
    checkout: null,
    generation: null,
    slot: null,
    instance: null,
    project: null,
    verb: "status",
    v: 1,
  };
  const r = ordered(base);
  assert.deepEqual(Object.keys(r).slice(0, 3), ["v", "verb", "project"]);
  assert.deepEqual(Object.keys(r).slice(-3), ["defHash", "approved", "at"]);
  assert.ok(isVerbResult(r));
  assert.ok(!isVerbResult(base as unknown), "the unordered object is not the shape");
  const failed = ordered({ ...base, ok: false, error: { code: "busy", message: "x" }, checks: [] });
  assert.deepEqual(Object.keys(failed).slice(-5), ["checks", "error", "defHash", "approved", "at"]);
  assert.ok(isVerbResult(failed));
  assert.ok(!isVerbResult({ ...failed, ok: true }), "an error with ok true is not the shape");
  assert.ok(!isVerbResult(ordered({ ...base, error: { code: "nope" as never, message: "x" }, ok: false })), "codes are a closed list");
});

test("test, start and about: parsed strictly, selectors can never read as flags", () => {
  const svc = { cmd: ["node", "s.js"], ports: { nrepl: { base: 7852, stride: 10 } } };
  const def = parse({
    version: 1,
    services: { app: { cmd: ["node", "a.js"] }, repl: { ...svc, start: "on-demand", about: "Test nREPL: clj-nrepl-eval -p ${ports.repl.nrepl}" } },
    test: { run: [".sova/bin/test", "${ports.repl.nrepl}"], requires: ["repl"], smoke: ["motorsaif.core-test", "src/a.test.ts", "ns/*:fast"] },
  });
  assert.equal(def.services.find((s) => s.name === "app")!.start, "up", "start defaults to up");
  assert.equal(def.services.find((s) => s.name === "repl")!.start, "on-demand");
  assert.deepEqual(def.test, { run: [".sova/bin/test", "${ports.repl.nrepl}"], requires: ["repl"], timeout: 600, smoke: ["motorsaif.core-test", "src/a.test.ts", "ns/*:fast"] });
  assert.equal(parse({ version: 1, services: { app: svc }, test: { run: ["t"], smoke: ["a"], timeout: 1800 } }).test!.timeout, 1800);
  assert.equal(parse({ version: 1, services: { app: svc } }).test, undefined);
  const base = { version: 1, services: { app: svc } };
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: ["a"], timeout: 1801 } }), "$.test.timeout");
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: [] } }), "$.test.smoke");
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: ["-x"] } }), "$.test.smoke", "a flag is no selector");
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: ["a b"] } }), "$.test.smoke");
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: Array.from({ length: 51 }, (_, i) => `t${i}`) } }), "$.test.smoke");
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: ["a"], requires: ["nope"] } }), "$.test.requires");
  assert.equal(refusedAt({ ...base, test: { run: "make test", smoke: ["a"] } }), "$.test.run", "never a shell string");
  assert.equal(refusedAt({ ...base, test: { run: ["t", "${ports.nope.x}"], smoke: ["a"] } }), "$.test.run[1]");
  assert.equal(refusedAt({ ...base, test: { run: ["t"], smoke: ["a"], extra: 1 } }), "$.test.extra");
  assert.equal(refusedAt({ version: 1, services: { app: { ...svc, start: "later" } } }), "$.services.app.start");
  assert.equal(refusedAt({ version: 1, services: { app: { ...svc, scope: "shared", ports: { p: { fixed: 7000 } }, start: "on-demand" } } }), "$.services.app.start");
  assert.equal(refusedAt({ version: 1, host: ["TOKEN"], services: { app: { ...svc, about: "token ${host.TOKEN}" } } }), "$.services.app.about", "the note is shown to sessions");
  assert.equal(refusedAt({ version: 1, services: { app: { ...svc, about: "x".repeat(201) } } }), "$.services.app.about");
  assert.equal(refusedAt({ version: 1, services: { app: { ...svc, about: "port ${ports.app.nope}" } } }), "$.services.app.about");
});

test("a tests block goes between conform and error", () => {
  const tests = { select: ["a"], pass: false, passed: 1, failed: 1, errors: 0, skipped: 0, failures: [{ name: "a" }], exit: 1, timedOut: false, ms: 5, peakBytes: null };
  const r = ordered({ v: 1, verb: "test", project: null, instance: null, slot: null, generation: null, checkout: null, branch: null, ok: false, changed: false, state: "running", steps: [], services: [], data: [], links: [], error: { code: "tests-failed", message: "1 of 2 failed" }, tests, lines: [], defHash: null, approved: true, at: "t" });
  assert.deepEqual(Object.keys(r).slice(-6), ["lines", "tests", "error", "defHash", "approved", "at"]);
  assert.ok(isVerbResult(r));
  const { tests: _t, error, defHash, approved, at, ...head } = r;
  const swapped = { ...head, error, tests, defHash, approved, at };
  assert.deepEqual(Object.keys(swapped).slice(-5), ["error", "tests", "defHash", "approved", "at"]);
  assert.ok(!isVerbResult(swapped), "tests after error is not the shape");
});

test("sources and isolation: parsed strictly, kept as written, and the key lists name every accepted key", () => {
  const def = parse({
    version: 1,
    sources: ["bb.edn", ".mise.toml", "infra/compose.yml"],
    services: { web: { cmd: ["bb", "clj"], ports: { http: { base: 4000, stride: 10 } }, isolation: { method: "ports", why: "Its own port per slot; its data is cloned from main." } } },
  });
  assert.deepEqual(def.sources, ["bb.edn", ".mise.toml", "infra/compose.yml"], "dot-files allowed");
  assert.deepEqual(def.services[0]!.isolation, { method: "ports", why: "Its own port per slot; its data is cloned from main." });
  assert.equal(parse({ version: 1, services: { a: { cmd: ["x"] } } }).sources, undefined);
  const svc = { cmd: ["x"] };
  assert.equal(refusedAt({ version: 1, sources: ["../up"], services: { a: svc } }), "$.sources[0]");
  assert.equal(refusedAt({ version: 1, sources: ["/etc/passwd"], services: { a: svc } }), "$.sources[0]");
  assert.equal(refusedAt({ version: 1, sources: ["a", "a"], services: { a: svc } }), "$.sources");
  assert.equal(refusedAt({ version: 1, sources: Array.from({ length: 51 }, (_, i) => `f${i}`), services: { a: svc } }), "$.sources");
  assert.equal(refusedAt({ version: 1, sources: "bb.edn", services: { a: svc } }), "$.sources");
  assert.equal(refusedAt({ version: 1, services: { a: { ...svc, isolation: { method: "vm", why: "x" } } } }), "$.services.a.isolation.method");
  assert.equal(refusedAt({ version: 1, services: { a: { ...svc, isolation: { method: "ports" } } } }), "$.services.a.isolation.why");
  assert.equal(refusedAt({ version: 1, services: { a: { ...svc, isolation: { method: "ports", why: "x".repeat(201) } } } }), "$.services.a.isolation.why");
  assert.equal(refusedAt({ version: 1, services: { a: { ...svc, isolation: { method: "ports", why: "x", how: 1 } } } }), "$.services.a.isolation.how");
  for (const m of ISOLATION_METHODS) assert.equal(parse({ version: 1, services: { a: { ...svc, isolation: { method: m, why: "x" } } } }).services[0]!.isolation!.method, m);
  // The lists the playbook's reference is pinned to are the ones the parse enforces.
  assert.ok(DEFINITION_KEYS.top.includes("sources") && DEFINITION_KEYS.service.includes("isolation"));
  const known = (o: object) => {
    try {
      parse(o);
    } catch (err) {
      assert.doesNotMatch(String(err), /unknown key/, JSON.stringify(o));
    }
  };
  for (const k of DEFINITION_KEYS.top) known({ version: 1, services: { a: svc }, [k]: 12 });
  for (const k of DEFINITION_KEYS.service) known({ version: 1, services: { a: { ...svc, [k]: 12 } } });
  assert.equal(refusedAt({ version: 1, services: { a: svc }, nope: 1 }), "$.nope");
});

test("a data resource may be sensitive: true or false, kept only when true", () => {
  const svc = { cmd: ["x"] };
  const def = parse({ version: 1, services: { a: svc }, data: { db: { kind: "dir", from: "${main}/db", sensitive: true }, cache: { kind: "dir", sensitive: false }, prod: { kind: "hook", provision: ["p"], deprovision: ["d"], sensitive: true } } });
  assert.deepEqual(def.data.map((d) => [d.name, d.sensitive]), [["db", true], ["cache", undefined], ["prod", true]]);
  assert.equal(refusedAt({ version: 1, services: { a: svc }, data: { db: { kind: "dir", sensitive: "yes" } } }), "$.data.db.sensitive");
  assert.ok(DEFINITION_KEYS.data.every((keys) => (keys as readonly string[]).includes("sensitive")));
});
