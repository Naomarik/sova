import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type VerbResult } from "../../shared/project-contract";
import type { ContainerQuery } from "./container-ports";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * A container service whose engine publishes its port through a listener the unit doesn't own
 * (rootful docker-proxy, rootlessport, pasta, Docker Desktop) or through no listener at all. The
 * engine is faked: `published` is what `<engine> port` / `ps` report, and every listener reads as
 * an unreadable process, as root's docker-proxy does. On a host in memory (fake-host.ts) whose clock the
 * waits step; container-claims.integration.test.ts refuses a start against real listeners.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-container-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 21_000;
/** The pid a container's proxy listens as (nobody's unit). */
const PROXY = 4_343;
const ENGINE = "podman";

const DEF = {
  version: 1,
  slots: { cap: 4 },
  services: {
    box: { cmd: ["node", "box.mjs"], container: { name: "tbox-${slot}", engine: ENGINE }, ports: { http: { base: BASE } }, ready: { tcp: "http", timeout: 10 } },
  },
};

let parent = "";
let project = "";
let engine: ProjectEngine;
/** Container name → the host ports the fake engine says it publishes. */
const published = new Map<string, number[]>();
const queries: string[] = [];
/** Milliseconds (on the host's clock) a fake `rm -f` takes to free the container's ports. */
let rmDelay = 0;
/** The port of the listener standing in for a container's proxy, closed by its `rm -f`. */
const proxies = new Map<string, number>();
/** Container name → when its `rm -f` is done. */
const freeing = new Map<string, number>();
const host = new FakeHost();

const free = (name: string) => {
  published.delete(name);
  const port = proxies.get(name);
  if (port !== undefined) host.close(port);
  proxies.delete(name);
  freeing.delete(name);
};

const fakeQuery: ContainerQuery = async (eng, args) => {
  for (const [name, at] of freeing) if (host.clock.now() >= at) free(name);
  queries.push(`${eng} ${args.join(" ")}`);
  assert.equal(eng, ENGINE, "only the declared engine is asked");
  const [verb, name] = args;
  if (verb === "port") return published.has(name!) ? { code: 0, stdout: published.get(name!)!.map((p) => `8080/tcp -> 127.0.0.1:${p}\n`).join("") } : { code: 125, stdout: "" };
  if (verb === "inspect") return { code: 125, stdout: "" };
  if (verb === "ps") return { code: 0, stdout: [...published].map(([n, ps]) => `${n}\t${ps.map((p) => `127.0.0.1:${p}->8080/tcp`).join(", ")}\n`).join("") };
  return { code: 1, stdout: "" };
};

const fakeExec = async (eng: string, args: string[]) => {
  assert.equal(eng, ENGINE);
  const name = args[args.length - 1]!;
  if (rmDelay) freeing.set(name, host.clock.now() + rmDelay);
  else free(name);
  return 0;
};

/** A listener of nobody's unit on `port`; closing it frees the port. */
const listen = (port: number) => {
  host.listen(port, PROXY);
  return { port, get listening() { return host.listeners.get(port)?.pid === PROXY; } };
};
const close = (s: { port: number }) => host.close(s.port);
const recOf = (id: string | null) => readRegistry().instances.find((i) => i.id === id)!;
const def = () => parseDefinition(readFileSync(join(project, ".sova/project.json"), "utf8"));

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-container-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "box.mjs"), `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1");`);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const hash = defHashOf(def());
  approve(project, hash, hash);
  engine = new ProjectEngine(
    host.deps({
      // Every listener is unreadable, as root's docker-proxy is to the user.
      portOwner: (p) => (host.portOwner(p) === "none" ? "none" : "unknown"),
      containerQuery: fakeQuery,
      containerExec: fakeExec,
    }),
  );
});

after(async () => {
  rmDelay = 0;
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

let a: VerbResult;

test("a port its own container publishes is the instance's own, whoever listens; without that, an unreadable listener is not", async () => {
  a = await engine.run("up", { project, branch: "sova/a" }, op);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  const port = a.services[0]!.ports.http!;
  assert.equal(port, BASE + 1);
  published.set("tbox-1", [port]);
  const claim = await engine.portClaim(recOf(a.instance), def(), "box", port);
  assert.deepEqual(claim, { held: true, own: true, who: "its own container tbox-1" });
  const doc = await engine.run("doctor", { instance: a.instance }, op);
  assert.deepEqual(doc.checks?.find((c) => c.id === "port:box.http"), { id: "port:box.http", ok: true, detail: `${port} held by its own container tbox-1` });
  published.delete("tbox-1");
  const lost = await engine.portClaim(recOf(a.instance), def(), "box", port);
  assert.deepEqual(lost, { held: true, own: false, who: "a process this user can't read", unreadable: true }, "the listener alone proves nothing");
  assert.equal((await engine.run("doctor", { instance: a.instance }, op)).checks?.find((c) => c.id === "port:box.http")?.ok, false);
});

test("down waits until the engine has released its container's ports", async () => {
  published.set("tbox-1", [BASE + 1]);
  rmDelay = 600;
  const t0 = host.clock.now();
  const down = await engine.run("down", { instance: a.instance }, op);
  rmDelay = 0;
  assert.equal(down.ok, true, JSON.stringify(down.error));
  assert.ok(!published.has("tbox-1"), "down returned only after the container stopped publishing");
  assert.ok(host.clock.now() - t0 >= 600, `waited ${host.clock.now() - t0} ms`);
  assert.ok(host.clock.now() - t0 < 5_000, "and no longer: never the 5 s bound");
});

test("a leftover of its own container does not refuse the start: it is removed, then the service starts", async () => {
  const port = BASE + 1;
  proxies.set("tbox-1", listen(port).port);
  published.set("tbox-1", [port]);
  const up = await engine.run("up", { instance: a.instance }, op);
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.ok(!proxies.has("tbox-1"), "removed by name before the start");
  assert.equal(up.services[0]!.state, "ready");
  const down = await engine.run("down", { instance: a.instance }, op);
  assert.equal(down.ok, true, JSON.stringify(down.error));
});

test("another container publishing the port refuses the start, named, whether or not a listener shows", async () => {
  const port = BASE + 1;
  const holder = listen(port);
  published.set("someone-else", [port]);
  try {
    const up = await engine.run("up", { instance: a.instance }, op);
    assert.equal(up.error?.code, "port-held");
    assert.match(up.error!.message, /needs port \d+, which container someone-else \(its listener unreadable\) holds/);
    assert.ok(holder.listening, "never touched");
    assert.ok(published.has("someone-else"), "never removed");
  } finally {
    close(holder);
  }
  // Published by firewall rules alone: no listener at all, still refused and named.
  queries.length = 0;
  const up = await engine.run("up", { instance: a.instance }, op);
  assert.equal(up.error?.code, "port-held");
  assert.match(up.error!.message, /which container someone-else holds/);
  assert.ok(queries.includes(`${ENGINE} ps --format {{.Names}}\t{{.Ports}}`), JSON.stringify(queries));
  published.delete("someone-else");
  // And a plain process holding it is refused as before.
  const squat = listen(port);
  try {
    const up2 = await engine.run("up", { instance: a.instance }, op);
    assert.equal(up2.error?.code, "port-held");
    assert.match(up2.error!.message, /which a process this user can't read holds/);
  } finally {
    close(squat);
  }
  const ok = await engine.run("up", { instance: a.instance }, op);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
});
