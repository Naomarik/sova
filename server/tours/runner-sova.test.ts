import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { runTourAttempt } from "./runner";
import type { TourRecordingContext } from "./sandbox";

// A verified managed Sova copy's install token becomes the recorder's sign-in cookie. It is read
// server-side from that copy's own .agent only: no link followed, size-bounded, a Sova token's shape.
// Every bad token refuses before the confined launch (so before any contact), and no refusal quotes it.
const TOKEN = "fake-copy-token".padEnd(48, "x");
const context: TourRecordingContext = { sessionId: "sova-token", sessionFile: "/server/chat.jsonl", cwd: "/server/checkout", agentDir: "/server/agent", sandbox: { on: false } };

async function attempt(agentDir: string): Promise<{ launched: boolean; error: unknown }> {
  const script = tourScriptFixture();
  script.source = { kind: "project", projectId: "sova", instanceId: "copy-s", checkout: "/server/checkout", serviceId: "server", endpoint: "http" };
  let launched = false;
  const error = await runTourAttempt({
    context, script, tourId: "sova-tour", editionId: "sova-edition", dryRun: true, beforeContact: async () => {},
    target: async () => ({ origin: "http://127.0.0.1:48317", generation: 1, sova: { agentDir }, assertCurrent: async () => {} }),
    startProxy: async () => ({ url: "http://127.0.0.1:1", closed: new Promise<void>(() => {}), close: async () => {} }),
    spawn: async () => { launched = true; throw new Error("launch captured"); },
  }).then(() => null, (e: unknown) => e);
  return { launched, error };
}

test("a well-formed token in the copy's own .agent reaches the launch; every unsafe token file refuses first", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tour-sova-token-")));
  try {
    const copy = (name: string) => { const agent = join(root, name, ".agent"); mkdirSync(join(agent, "sova"), { recursive: true }); return agent; };
    const ok = copy("ok");
    writeFileSync(join(ok, "sova", "auth-token"), `${TOKEN}\n`);
    const good = await attempt(ok);
    assert.equal(good.launched, true, "positive control: a valid token passes to the launch");
    assert.match(String((good.error as Error).message), /launch captured/);
    const outside = join(root, "outside-token");
    writeFileSync(outside, TOKEN);
    const cases: [string, (agent: string) => void][] = [
      ["missing", () => {}],
      ["linked file", agent => symlinkSync(outside, join(agent, "sova", "auth-token"))],
      ["linked directory (outside the copy's .agent)", agent => { rmSync(join(agent, "sova"), { recursive: true }); mkdirSync(join(root, "elsewhere")); writeFileSync(join(root, "elsewhere", "auth-token"), TOKEN); symlinkSync(join(root, "elsewhere"), join(agent, "sova")); }],
      ["oversize", agent => writeFileSync(join(agent, "sova", "auth-token"), "A".repeat(600))],
      ["not a token", agent => writeFileSync(join(agent, "sova", "auth-token"), "short token with spaces")],
      ["a directory", agent => mkdirSync(join(agent, "sova", "auth-token"))],
    ];
    for (const [name, arrange] of cases) {
      const agent = copy(name.replace(/\W+/g, "-"));
      arrange(agent);
      const bad = await attempt(agent);
      assert.equal(bad.launched, false, `${name}: refused before the launch`);
      const message = String((bad.error as Error).message);
      assert.match(message, /sign-in could not be read safely/, name);
      assert.equal(message.includes(TOKEN), false, `${name}: the refusal never quotes a token`);
      assert.equal(JSON.stringify(bad.error).includes(TOKEN), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
