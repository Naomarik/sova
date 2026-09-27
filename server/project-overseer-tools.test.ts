// Run: pnpm exec tsx --test server/project-overseer-tools.test.ts. The autonomy rule and the
// tools against a fake host; files in a throwaway dir (PI_CODING_AGENT_DIR too). No model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { Person } from "../shared/orgs";
import type { Autonomy, ProjectCodingMode, ProjectOverseerSettings } from "../shared/project-overseer";
import type { SessionSummary } from "../shared/protocol";

const root = mkdtempSync(join(tmpdir(), "sova-po-tools-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { projectOverseerTools, PoLimits, TOOL_NEEDS, autonomyRefusal, underRoot } = await import("./project-overseer-tools");
const { defaultPoSettings, effectiveAutonomy, projectOverseerPaths, EMPTY_ROSTER_REASON } = await import("./project-overseer-store");
const { AUTONOMY_LEVELS } = await import("../shared/project-overseer");
const { baseCodingMode, codingModeChoice } = await import("./project-coding-mode");
after(() => rmSync(root, { recursive: true, force: true }));

const person = (id: string, name: string, status: Person["status"] = "active"): Person => ({
  id,
  orgId: "org_aaaaaaaa",
  name,
  status,
  contact: { email: `${id}@example.invalid` },
  role: "IT",
  decides: ["invoicing"],
  skills: [],
  competence: {},
  language: "",
  voice: "",
});

let n = 0;
function fake(opts: { attended?: boolean; autonomy?: Autonomy; roster?: Person[]; tokens?: number; settings?: Partial<ProjectOverseerSettings>; hasSpec?: boolean } = {}) {
  const calls: string[] = [];
  /** The mode each create/send reached the host with (a send without one records null). */
  const modes: (ProjectCodingMode | null)[] = [];
  const dir = join(root, `ws${n++}`);
  const paths = projectOverseerPaths("org_aaaaaaaa", "prj_bbbbbbbb", dir);
  const roster = opts.roster ?? [person("p_tony0001", "Tony"), person("p_bob00001", "Bob", "proposed")];
  const settings = { ...defaultPoSettings(), autonomy: opts.autonomy ?? "L1", ...opts.settings };
  const sessions: SessionSummary[] = [
    { id: "in-root", path: "/s/in-root.jsonl", cwd: "/proj/app", title: "Inside" } as SessionSummary,
    { id: "outside", path: "/s/outside.jsonl", cwd: "/elsewhere", title: "Outside" } as SessionSummary,
    { id: "po-self", path: "/s/po.jsonl", cwd: "/proj", title: "Overseer · Portal", projectOverseer: { orgId: "org_aaaaaaaa", projectId: "prj_bbbbbbbb" } } as SessionSummary,
    { id: "global", path: "/s/ov.jsonl", cwd: "/proj", title: "Overseer", overseer: true } as SessionSummary,
    { id: "worker", path: "/s/w.jsonl", cwd: "/proj/app", title: "worker", workerSession: { parent: "/s/in-root.jsonl" } } as unknown as SessionSummary,
    { id: "a-baton", path: "/s/b.jsonl", cwd: "/proj", title: "Baton", baton: { holder: null, state: "open" } } as SessionSummary,
    // A coding session the project started, in its own worktree outside the root.
    { id: "in-tree", path: "/s/in-tree.jsonl", cwd: "/.worktrees/proj-fix-abc123", title: "Worktree" } as SessionSummary,
    { id: "gone-tree", path: "/s/gone-tree.jsonl", cwd: "/.worktrees/proj-old-abc123", title: "Removed" } as SessionSummary,
  ];
  const state = { attended: opts.attended ?? false };
  const host = {
    paths,
    project: () => ({ id: "prj_bbbbbbbb", orgId: "org_aaaaaaaa", name: "Portal", root: "/proj", origin: "manual" as const, createdAt: "" }),
    settings: () => settings,
    roster: () => roster,
    effective: () => effectiveAutonomy(settings, roster),
    attended: () => state.attended,
    overseerId: () => "po-1",
    batons: () => [],
    batonView: async () => null,
    decisions: async () => ({ decisions: [], conflicts: [], spec: { specRoot: "", exists: false, frozen: false, draft: null, promoted: 0, drafted: 0 }, lastRun: null, running: false, names: {} }),
    reconcile: async () => {
      calls.push("reconcile");
      return { decisions: [], conflicts: [], spec: { specRoot: "", exists: false, frozen: false, draft: null, promoted: 0, drafted: 0 }, lastRun: null, running: false, names: {} };
    },
    promote: async (ids: string[]) => {
      calls.push(`promote:${ids.join(",")}`);
      // Promotes only ids starting "s:"; says nothing about the rest (like an unknown id).
      const promoted = ids.filter((i) => i.startsWith("s:"));
      const refused = ids
        .filter((i) => i.startsWith("c:") || i.startsWith("o:"))
        .map((id) => ({ id, reason: id.startsWith("o:") ? "outside Ana Ruiz's decision area (invoicing): only the operator promotes it" : "in an open conflict" }));
      return { info: await host.decisions(), promoted, refused };
    },
    startGathering: async (input: { to: string | string[] }) => {
      calls.push(`gather:${[input.to].flat().join(",")}`);
      return { sessionId: "b1", path: "/s/b1.jsonl", invited: [input.to].flat() };
    },
    decideReferral: async (id: string, approve: boolean) => {
      calls.push(`${approve ? "approve" : "decline"}:${id}`);
      return { ...roster.find((p) => p.id === id)!, status: approve ? ("active" as const) : ("left" as const) };
    },
    sessions: async () => sessions,
    transcript: async () => [],
    codingMode: (req: { mode?: string; minor_modes?: unknown }) => codingModeChoice(req, baseCodingMode(settings.codingMode, "/proj", opts.hasSpec ?? false), settings.codingMode),
    createCoding: async (input: { cwd: string; mode: ProjectCodingMode }) => {
      calls.push(`create:${input.cwd}`);
      modes.push(input.mode);
      return { id: "c1", path: "/s/c1.jsonl", cwd: input.cwd };
    },
    send: async (path: string, _text: string, mode?: ProjectCodingMode) => {
      calls.push(`send:${path}`);
      modes.push(mode ?? null);
      return { queued: false };
    },
    coding: () => [],
    startedCoding: () => new Map([["in-tree", { removed: false }], ["gone-tree", { removed: true }]]),
    codingTokens: async () => opts.tokens ?? 0,
    postOwnerUpdate: async (input: { text: string; attended: boolean }) => {
      calls.push("owner-update");
      return { update: { id: "u_1", at: "", text: input.text, by: input.attended ? ("operator" as const) : ("overseer" as const) }, owner: "Alperen" };
    },
  };
  const limits = new PoLimits();
  const tools = projectOverseerTools(host, limits, () => ({ redact: (t: string) => t, redactDeep: <T>(v: T) => v }) as never);
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, name);
    return t.execute("call-1", params, undefined, undefined, undefined as never);
  };
  return { host, tools, run, calls, modes, limits, paths, state };
}

/** A call per tool that does something when allowed (each the tool's "act" form). */
const ACTS: Record<string, Record<string, unknown>> = {
  sova_start_gathering: { person: "Tony", public_title: "Invoicing", goal: "Who approves invoices", question: "Who approves invoices?" },
  sova_offer: { people: ["Tony", "p_tony0002"], public_title: "Invoicing", goal: "g", question: "q?" },
  sova_reconcile: {},
  sova_promote: { ids: ["s:1"] },
  sova_create_session: { prompt: "Build it" },
  sova_send: { session: "in-root", text: "go on" },
  sova_todo: { op: "add", text: "Ask about VAT" },
  sova_idea: { op: "add", id: "§gap/vat", title: "Nobody decided VAT" },
  sova_note: { op: "append", text: "remember" },
  sova_owner_update: { text: "The opening hours are agreed." },
};

describe("the autonomy table", () => {
  test("every tool the runtime registers has a level, and every level names a tool", () => {
    const { tools } = fake();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_NEEDS).sort());
  });

  test("autonomyRefusal: attended always runs; reads always run; otherwise level ≥ need", () => {
    for (const have of AUTONOMY_LEVELS)
      for (const need of AUTONOMY_LEVELS) {
        assert.equal(autonomyRefusal("t", need, true, { autonomy: have }), null);
        const refused = autonomyRefusal("t", need, false, { autonomy: have });
        assert.equal(refused === null, AUTONOMY_LEVELS.indexOf(have) >= AUTONOMY_LEVELS.indexOf(need), `${have} vs ${need}`);
      }
    assert.equal(autonomyRefusal("t", "read", false, { autonomy: "L0" }), null);
    assert.match(autonomyRefusal("t", "operator", false, { autonomy: "L3" }) ?? "", /only in a turn the operator started/);
  });

  test("L0 while the roster has no active person, whatever the setting", () => {
    assert.deepEqual(effectiveAutonomy({ autonomy: "L3" }, []), { autonomy: "L0", reason: EMPTY_ROSTER_REASON });
    assert.deepEqual(effectiveAutonomy({ autonomy: "L3" }, [{ status: "proposed" }, { status: "left" }]).autonomy, "L0");
    assert.deepEqual(effectiveAutonomy({ autonomy: "L2" }, [{ status: "active" }]), { autonomy: "L2" });
  });
});

describe("the wrapper enforces it, per tool", () => {
  // Unattended, at each level: exactly the tools whose need ≤ level run their act; the rest refuse
  // without reaching the host.
  for (const level of AUTONOMY_LEVELS) {
    test(`unattended at ${level}`, async () => {
      for (const [name, params] of Object.entries(ACTS)) {
        const f = fake({ autonomy: level, roster: [person("p_tony0001", "Tony"), person("p_tony0002", "Toni")] });
        const need = TOOL_NEEDS[name]!;
        const allowed = need !== "operator" && (need === "read" || AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(need as Autonomy));
        if (allowed) await f.run(name, params);
        else {
          await assert.rejects(() => f.run(name, params), /not started by the operator|only in a turn the operator started/, `${name} at ${level}`);
          assert.deepEqual(f.calls, [], `${name} reached the host at ${level}`);
        }
        const log = readFileSync(f.paths.actions, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        assert.equal(log.at(-1).tool, name);
        assert.equal(log.at(-1).outcome, allowed ? "ok" : "refused");
      }
    });
  }

  test("attended (the operator's own message): every act runs, even at L0 with an empty roster", async () => {
    for (const [name, params] of Object.entries(ACTS)) {
      if (name === "sova_start_gathering" || name === "sova_offer") continue; // needs a roster person
      const f = fake({ attended: true, autonomy: "L0", roster: [] });
      assert.equal(f.host.effective().autonomy, "L0");
      await f.run(name, params);
    }
  });

  test("sova_roster: read at any level; approve needs L2 unattended", async () => {
    const f = fake({ autonomy: "L1" });
    await f.run("sova_roster", { op: "read" });
    await assert.rejects(() => f.run("sova_roster", { op: "approve", person: "Bob" }), /needs L2/);
    assert.deepEqual(f.calls, []);
    const g = fake({ autonomy: "L2" });
    await g.run("sova_roster", { op: "approve", person: "Bob" });
    assert.deepEqual(g.calls, ["approve:p_bob00001"]);
    const out = await g.run("sova_roster", { op: "read" });
    assert.doesNotMatch(JSON.stringify(out), /example\.invalid/, "contact details never reach the model");
  });

  test("an autonomy change applies at the next tool call (read per call)", async () => {
    const f = fake({ autonomy: "L0" });
    await assert.rejects(() => f.run("sova_reconcile"), /needs L1/);
    f.host.settings().autonomy = "L1";
    await f.run("sova_reconcile");
    assert.deepEqual(f.calls, ["reconcile"]);
  });
});

describe("scope, caps and budget", () => {
  test("gathering refuses people not on the roster, proposed people, and a one-person offer", async () => {
    const f = fake({ attended: true });
    await assert.rejects(() => f.run("sova_start_gathering", { person: "Zed", public_title: "x", goal: "y", question: "q" }), /not on the roster/);
    await assert.rejects(() => f.run("sova_start_gathering", { person: "Bob", public_title: "x", goal: "y", question: "q" }), /proposed but not approved/);
    await assert.rejects(() => f.run("sova_offer", { people: ["Tony"], public_title: "x", goal: "y", question: "q" }), /at least two/);
    await assert.rejects(() => f.run("sova_start_gathering", { person: "Tony", public_title: "x", goal: "y" }), /question \(both shown to the person as written/, "no question: no fallback to internal text");
    await assert.rejects(() => f.run("sova_offer", { people: ["Tony", "p_tony0002"], goal: "y", question: "q" }), /Give public_title and question/);
    assert.deepEqual(f.calls, []);
  });

  test("coding sessions stay inside the project root; sends only to its sessions", async () => {
    const f = fake({ attended: true });
    await assert.rejects(() => f.run("sova_create_session", { prompt: "p", folder: "/proj-evil" }), /outside the project root/);
    await assert.rejects(() => f.run("sova_send", { session: "outside", text: "hi" }), /No coding session "outside" in this project/);
    await f.run("sova_create_session", { prompt: "p", folder: "/proj/app" });
    await f.run("sova_send", { session: "in-root", text: "hi" });
    assert.deepEqual(f.calls, ["create:/proj/app", "send:/s/in-root.jsonl"]);
    assert.equal(underRoot("/proj", "/proj"), true);
    assert.equal(underRoot("/proj", "/project"), false);
  });

  test("underRoot resolves .., sibling prefixes and symlinks on either side", () => {
    const base = mkdtempSync(join(root, "scope-"));
    const proj = join(base, "proj");
    mkdirSync(join(proj, "app"), { recursive: true });
    mkdirSync(join(base, "proj-evil"));
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(proj, "out-link"));
    symlinkSync(proj, join(base, "proj-link"));
    assert.equal(underRoot(proj, proj), true);
    assert.equal(underRoot(proj, join(proj, "app")), true);
    assert.equal(underRoot(proj, join(proj, "app", "not-yet", "deeper")), true, "a folder that does not exist yet");
    assert.equal(underRoot(proj, `${proj}/../outside`), false, "..");
    assert.equal(underRoot(proj, `${proj}/app/../../outside`), false, "nested ..");
    assert.equal(underRoot(proj, join(base, "proj-evil")), false, "sibling prefix");
    assert.equal(underRoot(proj, join(proj, "out-link")), false, "a symlink inside the root pointing out");
    assert.equal(underRoot(proj, join(proj, "out-link", "new-dir")), false, "a not-yet folder under that symlink");
    assert.equal(underRoot(join(base, "proj-link"), join(proj, "app")), true, "the root itself through a symlink");
    assert.equal(underRoot(proj, "relative/path"), false);
    assert.equal(underRoot(proj, join(proj, "..hidden")), true, "a folder whose name starts with .. is still inside");
  });

  test("sova_create_session refuses an escaping folder before reaching the host", async () => {
    const f = fake({ attended: true });
    for (const folder of ["/proj/../etc", "/proj/app/../../etc", "/proj-evil", "../etc", "app/../../x", "./../proj-evil"]) {
      await assert.rejects(() => f.run("sova_create_session", { prompt: "p", folder }), /outside the project root/, folder);
    }
    assert.deepEqual(f.calls, []);
  });

  test("sova_create_session resolves a relative folder against the project root", async () => {
    const f = fake({ attended: true });
    await f.run("sova_create_session", { prompt: "p", folder: "app" });
    await f.run("sova_create_session", { prompt: "p", folder: "./app/sub/.." });
    assert.deepEqual(f.calls, ["create:/proj/app", "create:/proj/app"]);
  });

  test("sova_send never reaches an overseer, a baton or a subagent's own session, even with its cwd under the root", async () => {
    const f = fake({ attended: true });
    for (const id of ["po-self", "global", "worker", "a-baton"]) await assert.rejects(() => f.run("sova_send", { session: id, text: "hi" }), /No coding session/, id);
    assert.deepEqual(f.calls, []);
    const listed = JSON.stringify(await f.run("sova_list_sessions"));
    for (const t of ["Overseer · Portal", "\"Overseer\"", "worker", "Baton"]) assert.ok(!listed.includes(t), t);
  });

  test("per-turn caps refuse without reaching the host, and a spent token budget stops L3", async () => {
    const f = fake({ attended: true, settings: { caps: { ...defaultPoSettings().caps, createPerTurn: 1 } } });
    await f.run("sova_create_session", { prompt: "one" });
    await assert.rejects(() => f.run("sova_create_session", { prompt: "two" }), /Limit reached: at most 1 coding sessions started/);
    const g = fake({ attended: true, tokens: 5_000_000 });
    await assert.rejects(() => g.run("sova_create_session", { prompt: "p" }), /token budget is spent/);
    await assert.rejects(() => g.run("sova_send", { session: "in-root", text: "p" }), /token budget is spent/);
    assert.deepEqual(g.calls, []);
  });

  test("sova_promote accounts for every id: promoted, refused with the reconciler's reason, or refused as unknown", async () => {
    const f = fake({ attended: true });
    const out = JSON.stringify(await f.run("sova_promote", { ids: ["s:1", "c:2", "nope"] }));
    assert.match(out, /Promoted 1, refused 2: c:2 \(in an open conflict\); nope \(not a drafted decision of this project/);
    await assert.rejects(() => f.run("sova_promote", { ids: ["nope", "c:9"] }), /Promoted 0, refused 2/);
    // An out-of-area decision: refused even in the operator's own turn, the reconciler's reason relayed as is.
    await assert.rejects(() => f.run("sova_promote", { ids: ["o:1"] }), /o:1 \(outside Ana Ruiz's decision area \(invoicing\): only the operator promotes it\)/);
    const log = readFileSync(f.paths.actions, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.at(-1).outcome, "refused", "nothing promoted is a refusal, not an ok");
    // Each case's own log line: some refused is partial (with what), all promoted is ok.
    assert.deepEqual([log[0].outcome, log[0].error], ["partial", "2 refused: c:2 (in an open conflict); nope (not a drafted decision of this project (sova_decisions state drafted lists them; run sova_reconcile first))"]);
    await f.run("sova_promote", { ids: ["s:2"] });
    const last = readFileSync(f.paths.actions, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([last.outcome, last.error], ["ok", undefined]);
    assert.doesNotMatch(JSON.stringify(out), /"partial"/, "the model never sees the log's field");
  });

  test("session ids in every form the tools print reach the same session; anything else is refused", async () => {
    const f = fake({ attended: true });
    for (const ref of ["in-root", "s/in-root", "sova://s/in-root", "[Inside](sova://s/in-root)", "  sova://s/in-root  "]) await f.run("sova_send", { session: ref, text: "hi" });
    assert.deepEqual(f.calls, Array(5).fill("send:/s/in-root.jsonl"));
    await assert.rejects(() => f.run("sova_send", { session: "x/in-root", text: "hi" }), { message: 'No coding session "x/in-root" in this project: pass an id sova_list_sessions lists.' });
  });

  test("the goal and the done summary ask for people by name only (the session's model may repeat them)", () => {
    const f = fake();
    for (const name of ["sova_start_gathering", "sova_offer"]) {
      const goal = (f.tools.find((t) => t.name === name)!.parameters as any).properties.goal.description;
      assert.match(goal, /by name only, never by role or job title/, name);
    }
  });

  test("ideas: gaps are §gap/<name> and always carry the gap tag", async () => {
    const f = fake({ autonomy: "L0" });
    await f.run("sova_idea", { op: "add", id: "§gap/vat-rate", title: "No VAT rate decided" });
    const listed = await f.run("sova_idea", { op: "list" });
    assert.match(JSON.stringify(listed), /§gap\/vat-rate · open · No VAT rate decided · #gap/);
    await assert.rejects(() => f.run("sova_idea", { op: "add", id: "§sova/x", title: "t" }), /§gap\/<name> or §idea\/<name>/);
  });
});

describe("coding sessions' modes (the operator's ceiling)", () => {
  const N = (minorModes: string[] = []): ProjectCodingMode => ({ mode: "normal", minorModes });

  test("Automatic: spec on when the project has a spec, off otherwise; never delegate", async () => {
    const f = fake({ attended: true, hasSpec: true });
    await f.run("sova_create_session", { prompt: "p" });
    const g = fake({ attended: true, hasSpec: false });
    await g.run("sova_create_session", { prompt: "p" });
    assert.deepEqual([f.modes, g.modes], [[N(["spec"])], [N()]]);
  });

  test("each refused mode creates nothing and takes no cap", async () => {
    const asks: [Record<string, unknown>, RegExp][] = [
      [{ mode: "turbo" }, /Unknown mode turbo: use normal or delegate\./],
      [{ minor_modes: ["bogus"] }, /Unknown minor mode bogus: only spec is allowed\./],
      [{ minor_modes: ["align", "spec"] }, /Align needs someone to answer its questions, and nobody answers a coding session's\./],
      [{ mode: "delegate" }, /Delegate is off for this project's coding sessions; the operator can allow it on the project page\./],
      [{ minor_modes: [] }, /Spec is on for this project's coding sessions; only the operator can turn it off on the project page\./],
    ];
    for (const [ask, why] of asks) {
      const f = fake({ attended: true, hasSpec: true });
      await assert.rejects(() => f.run("sova_create_session", { prompt: "p", ...ask }), why, JSON.stringify(ask));
      await assert.rejects(() => f.run("sova_send", { session: "in-root", text: "p", ...ask }), why, JSON.stringify(ask));
      assert.deepEqual(f.calls, [], JSON.stringify(ask));
      assert.equal(f.limits.count("create") + f.limits.count("prompt"), 0, JSON.stringify(ask));
    }
  });

  test("a mode refusal comes before the budget and the caps (a spent budget still names the mode)", async () => {
    const f = fake({ attended: true, tokens: 10 ** 12 });
    await assert.rejects(() => f.run("sova_create_session", { prompt: "p", mode: "delegate" }), /Delegate is off/);
  });

  test("delegate once the operator chose it; spec may be turned on; normal is always allowed", async () => {
    const f = fake({ attended: true, settings: { codingMode: { mode: "delegate", minorModes: [] } } });
    await f.run("sova_create_session", { prompt: "p" });
    await f.run("sova_create_session", { prompt: "p", mode: "normal", minor_modes: ["spec"] });
    assert.deepEqual(f.modes, [{ mode: "delegate", minorModes: [] }, N(["spec"])]);
    // The setting says normal: the overseer can't raise it to delegate, but may add spec.
    const g = fake({ attended: true, settings: { codingMode: N() } });
    await assert.rejects(() => g.run("sova_create_session", { prompt: "p", mode: "delegate" }), /Delegate is off/);
    await g.run("sova_create_session", { prompt: "p", minor_modes: ["spec"] });
    assert.deepEqual(g.modes, [N(["spec"])]);
  });

  test("sova_send: a mode reaches the host with the text; none leaves the session's mode alone", async () => {
    const f = fake({ attended: true });
    await f.run("sova_send", { session: "in-root", text: "go", minor_modes: ["spec"] });
    await f.run("sova_send", { session: "in-root", text: "go" });
    assert.deepEqual(f.modes, [N(["spec"]), null]);
  });

  test("sova_send reaches a coding session it started in a worktree outside the root, never one whose worktree was removed", async () => {
    const f = fake({ attended: true });
    await f.run("sova_send", { session: "in-tree", text: "go" });
    await assert.rejects(() => f.run("sova_send", { session: "gone-tree", text: "go" }), /Its worktree was removed, so it has no folder to work in\./);
    assert.deepEqual(f.calls, ["send:/s/in-tree.jsonl"]);
  });
});

describe("sova_confirm items (the shared tool)", () => {
  test("it resolves only the project's sessions, and runs in an unattended L0 run", async () => {
    const f = fake({ autonomy: "L0" });
    const out = await f.run("sova_confirm", { title: "Stop these?", options: [{ label: "Stop" }], items: { sessions: ["in-root", "sova://s/in-tree"] } });
    assert.equal(out.terminate, true);
    assert.deepEqual(
      out.details.items.map((i: { id: string; project?: string }) => [i.id, i.project]),
      [["in-root", "app"], ["in-tree", "proj-fix-abc123"]],
    );
    assert.match((out.content[0] as { text: string }).text, /^Shown to the operator under your reply/);
    assert.match((out.content[0] as { text: string }).text, /- \[Inside\]\(sova:\/\/s\/in-root\) \(in-root\)/);
    await assert.rejects(f.run("sova_confirm", { title: "?", options: [{ label: "Go" }], items: { sessions: ["in-root", "outside", "global"] } }), /sessions: outside, global/);
    await assert.rejects(f.run("sova_confirm", { title: "?", options: [{ label: "Go" }], items: { sessions: ["po-self"] } }), /po-self is your own conversation/);
  });
});
