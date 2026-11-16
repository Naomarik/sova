// The engine's spec tools with no SOVA_SPEC_CORE (modes.ts engineSpecCore, own-code.ts ownSpecCore): on the
// server's own agent dir this copy's, never through the agent dir's link into another tree; a worker on its
// worktree's .agent keeps that tree's. And the left-out line (own-code.ts ownExtensions) once per process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { engineSpecCore } from "./modes";
import { ownExtensions } from "./own-code";

const REPO = realpathSync(resolve(import.meta.dirname, "..", "..", ".."));
const t = realpathSync(mkdtempSync(join(tmpdir(), "own-code-fallbacks-")));
after(() => rmSync(t, { recursive: true, force: true }));
const write = (p: string, text = "export default () => {};\n") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

// Another Sova tree (an older install): its spec tools and an extension this copy doesn't ship.
const OTHER = join(t, "other-sova");
write(join(OTHER, "package.json"), JSON.stringify({ name: "sova", version: "0.9.0" }));
write(join(OTHER, "pi-config", "install.sh"), "#!/bin/sh\n");
write(join(OTHER, "pi-config", "extensions", "spec", "core", "sova-spec.mjs"));
write(join(OTHER, "pi-config", "extensions", "oldonly", "index.ts"));
const AGENT = join(t, "agent");
mkdirSync(join(AGENT, "extensions"), { recursive: true });
symlinkSync(join(OTHER, "pi-config", "extensions", "spec"), join(AGENT, "extensions", "spec"));
symlinkSync(join(OTHER, "pi-config", "extensions", "oldonly"), join(AGENT, "extensions", "oldonly"));

test("no SOVA_SPEC_CORE, the server's own agent dir linking spec into another tree: the engine's spec core is this copy's", () => {
  const saved = { ...process.env };
  try {
    delete process.env.SOVA_SPEC_CORE;
    delete process.env.SOVA_CHAT_STATE_ROOT;
    process.env.PI_CODING_AGENT_DIR = AGENT;
    assert.equal(getAgentDir(), AGENT);
    assert.equal(engineSpecCore(getAgentDir()), join(REPO, "pi-config", "extensions", "spec", "core"));
  } finally {
    process.env = saved;
  }
});

test("a worker on its worktree's own .agent keeps that tree's spec core; SOVA_SPEC_CORE wins whenever set", () => {
  const worker = { PI_CODING_AGENT_DIR: AGENT, SOVA_CHAT_STATE_ROOT: join(t, "server-agent", "sova") };
  assert.equal(engineSpecCore(AGENT, worker), join(AGENT, "extensions", "spec", "core"));
  assert.equal(engineSpecCore(AGENT, { ...worker, SOVA_SPEC_CORE: "/x/core" }), "/x/core");
  assert.equal(engineSpecCore(AGENT, { PI_CODING_AGENT_DIR: AGENT, SOVA_SPEC_CORE: "/x/core" }), "/x/core");
});

test("the left-out line of another copy's extension is logged once per process (log), however often resolve() runs", () => {
  const meta = { source: "auto", scope: "user", origin: "top-level" };
  const found = [{ path: join(AGENT, "extensions", "oldonly", "index.ts"), enabled: true, metadata: meta }];
  const env = { PI_CODING_AGENT_DIR: AGENT };
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  for (let i = 0; i < 3; i++) {
    const out = ownExtensions(found, { agentDir: AGENT }, null, { own: REPO, env, log });
    assert.ok(!out.some((r) => r.path.includes("oldonly")), "left out every time");
  }
  assert.equal(lines.filter((l) => l.includes("the oldonly extension") && l.includes("left out")).length, 1);
  // Another process's log (a fresh sink) hears it again.
  const other: string[] = [];
  ownExtensions(found, { agentDir: AGENT }, null, { own: REPO, env, log: (l) => other.push(l) });
  assert.equal(other.filter((l) => l.includes("the oldonly extension")).length, 1);
});
