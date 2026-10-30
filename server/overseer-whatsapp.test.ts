// sova_whatsapp (§app.outreach/overseer-sender): status reads a sender afresh and says what can be done, never a
// number or a path; start is Settings' Start Sender (one systemctl --user start of a stopped, installed unit), only
// in a run the user started, never for a sender that answers, a peer's or one with no unit. systemctl is a stand-in
// and the sender's status a seam: nothing is spawned, no socket is opened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SenderStatus } from "../shared/outreach";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-wa-tool-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
const waHome = join(tmp, "wa");
const sock = join(waHome, "sender.sock");

const wa = await import("./overseer-whatsapp");
const { saveOutreach } = await import("./outreach/settings");
const { setSystemctlForTest } = await import("./outreach/unit");
const { overseerActionsFile } = await import("./overseer-store");
after(() => setSystemctlForTest(null));

const r = saveOutreach({ sender: { local: { socket: sock } } });
assert.ok(!("error" in r), JSON.stringify(r));

let active = "inactive";
let loaded = true;
const calls: string[][] = [];
/** The stand-in systemctl (installing it again clears senderUnit's 10 s cache, after a test changes the unit). */
const systemd = () =>
  setSystemctlForTest(async (args) => {
    calls.push(args);
    if (args[0] === "show") return { code: 0, stdout: `LoadState=${loaded ? "loaded" : "not-found"}\nActiveState=${active}\nEnvironment=SOVA_WA_HOME=${waHome}\n` };
    if (args[0] === "start") return (active = "active"), { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  });
beforeEach(() => {
  active = "inactive";
  loaded = true;
  calls.length = 0;
  systemd();
});

class Refusal extends Error {}
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

let state: SenderStatus = { state: "unreachable", why: `connect ENOENT ${sock}` };
let attended = true;
const actions = join(tmp, "po-actions.jsonl");
function tool(who: "global" | "project", extra: Partial<Parameters<typeof wa.whatsappTool>[0]> = {}) {
  return wa.whatsappTool({
    who,
    attended: () => attended,
    unattendedRefusal: "This turn was not started by the user.",
    overseerId: () => "ov-1",
    refusal: (m) => new Refusal(m),
    obj,
    str,
    // The sender answers once its unit is active.
    status: async () => (active === "active" ? { state: "open", me: "…123" } : state),
    ...(who === "project" ? { orgOf: () => null, actionsFile: () => actions } : {}),
    ...extra,
  });
}
async function call(t: ReturnType<typeof tool>, params: unknown) {
  try {
    const out = (await (t.execute as (...a: unknown[]) => Promise<{ content: { text: string }[] }>)("tc", params)) as { content: { text: string }[] };
    return { ok: true, text: out.content.map((c) => c.text).join("") };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
}
const starts = () => calls.filter((c) => c[0] === "start");
const lastLine = (file: string) => JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);

describe("sova_whatsapp status (§app.outreach/overseer-sender)", () => {
  test("a stopped sender: its state, no path, and start it as the next step", async () => {
    state = { state: "unreachable", why: `connect ENOENT ${sock}` };
    const s = await call(tool("global"), { op: "status" });
    assert.ok(s.ok, s.text);
    assert.match(s.text, /on this host: stopped: no process answers its socket/);
    assert.match(s.text, /What can be done: start it \(sova_whatsapp start runs systemctl --user start sova-whatsapp\.service once\)/);
    assert.ok(!s.text.includes(tmp), "no path under the sender's home");
    assert.equal(starts().length, 0, "a read starts nothing");
  });

  test("logged out, replaced or unpaired: the user re-links it in Settings → Outreach; no number beyond 3 digits", async () => {
    for (const st of ["logged-out", "replaced", "unpaired"] as const) {
      state = { state: st, why: "Linked number +44 7700 900123 was logged out.", me: "…123" };
      const s = await call(tool("global"), { op: "status" });
      assert.match(s.text, /re-link it in Settings → Outreach \(Link a Phone\)/, st);
      assert.ok(!/7700|900123/.test(s.text), `${st}: ${s.text}`);
    }
    state = { state: "blocked", why: "blocked" };
    assert.match((await call(tool("global"), { op: "status" })).text, /only the user reconnects it/);
  });

  test("its action line names the sender by its label, never a number or the output", async () => {
    state = { state: "open", me: "…123" };
    await call(tool("global"), { op: "status" });
    const line = lastLine(overseerActionsFile());
    assert.deepEqual([line.tool, line.args, line.outcome], ["sova_whatsapp", { op: "status", sender: "This host" }, "ok"]);
  });
});

describe("sova_whatsapp start: Start Sender, once (§app.outreach/sender-controls)", () => {
  test("a stopped sender with its unit installed: one systemctl --user start, then the state read afresh", async () => {
    state = { state: "unreachable", why: "gone" };
    const r = await call(tool("global"), { op: "start" });
    assert.ok(r.ok, r.text);
    assert.deepEqual(starts(), [["start", "sova-whatsapp.service"]]);
    assert.match(r.text, /^Ran systemctl --user start sova-whatsapp\.service once\.[\s\S]*: open · linked number …123\./);
    // Now it answers: never started again, never restarted.
    const again = await call(tool("global"), { op: "start" });
    assert.equal(again.text, wa.WA_ALREADY_RUNNING);
    assert.equal(starts().length, 1);
    assert.ok(!calls.some((c) => c[0] === "restart" || c[0] === "stop"));
  });

  test("refused, nothing run: a running sender, no unit, a unit not stopped, a peer's sender, outside the user's run", async () => {
    state = { state: "open" };
    assert.equal((await call(tool("global"), { op: "start" })).text, wa.WA_ALREADY_RUNNING);
    state = { state: "unreachable", why: "gone" };
    loaded = false;
    systemd();
    assert.equal((await call(tool("global"), { op: "start" })).text, wa.WA_NO_UNIT);
    loaded = true;
    active = "activating";
    systemd();
    assert.match((await call(tool("global"), { op: "start" })).text, /sova-whatsapp\.service is activating: Sova starts it only while it is stopped\./);
    active = "inactive";
    systemd();
    assert.equal((await call(tool("global"), { op: "start", sender: "peer:node-9" })).text, wa.waPeerRefusal("node-9"));
    attended = false;
    try {
      assert.equal((await call(tool("global"), { op: "start" })).text, "This turn was not started by the user.");
      assert.ok((await call(tool("global"), { op: "status" })).ok, "status reads in any run");
    } finally {
      attended = true;
    }
    assert.equal(starts().length, 0);
    assert.equal(lastLine(overseerActionsFile()).outcome, "ok");
  });

  test("a project overseer: only its project's sender, its activity log, start in the operator's runs only", async () => {
    state = { state: "unreachable", why: "gone" };
    assert.match((await call(tool("project"), { op: "status", sender: "local" })).text, /only the sender your project sends through/);
    attended = false;
    try {
      assert.equal((await call(tool("project"), { op: "start" })).text, "This turn was not started by the user.");
    } finally {
      attended = true;
    }
    const r = await call(tool("project"), { op: "start" });
    assert.ok(r.ok, r.text);
    assert.equal(starts().length, 1);
    assert.deepEqual(lastLine(actions).args, { op: "start", sender: "This host" });
    assert.ok(!("org" in ((tool("project").parameters as { properties: Record<string, unknown> }).properties)), "no org or sender parameter");
  });
});

test("cleanWhy: no path, no phone number", () => {
  assert.equal(wa.cleanWhy("connect ENOENT /home/x/.pi/agent/sova/whatsapp/sender.sock"), "connect ENOENT [path]");
  assert.equal(wa.cleanWhy("number +1 (555) 010-9999 logged out"), "number [number] logged out");
  assert.equal(wa.cleanWhy("and/or kept"), "and/or kept");
});

test("every project overseer gets sova_whatsapp through outreach's contributed part; start outside the operator's run is refused before anything runs", async () => {
  const { WA_START_OPERATOR } = await import("./overseer-whatsapp-part");
  const { contributedTools } = await import("./projects/contributions");
  const ctx = { engine: "prj_nothing0", projectId: "prj_nothing0", paths: { actions: actions } as never, attended: () => false, overseerId: () => "po-1" } as never;
  const t = contributedTools(ctx).find((x) => x.name === "sova_whatsapp");
  assert.ok(t, "contributed for a standalone project too");
  const before = calls.length;
  assert.equal((await call(t as never, { op: "start" })).text, WA_START_OPERATOR);
  assert.equal(calls.length, before, "nothing asked of systemd");
  assert.deepEqual(lastLine(actions).args, { op: "start" });
});
