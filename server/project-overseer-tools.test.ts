// Run: pnpm exec tsx --test server/project-overseer-tools.test.ts. The autonomy rule and the
// tools against a fake host; files in a throwaway dir (PI_CODING_AGENT_DIR too). No model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { GatheringAbilities } from "../shared/baton";
import type { Person } from "../shared/orgs";
import type { Autonomy, CodingWorktree, ProjectCodingMode, ProjectOverseerSettings } from "../shared/project-overseer";
import type { SessionSummary } from "../shared/protocol";

const root = mkdtempSync(join(tmpdir(), "sova-po-tools-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { projectOverseerTools, PoLimits, TOOL_NEEDS, autonomyRefusal, underRoot, buildState } = await import("./project-overseer-tools");
const { defaultPoSettings, effectiveAutonomy, projectOverseerPaths, EMPTY_ROSTER_REASON, nextMidnight } = await import("./project-overseer-store");
type HeldInput = import("./project-overseer-tools").HeldInput;
const { AUTONOMY_LEVELS } = await import("../shared/project-overseer");
const { baseCodingMode, codingModeChoice } = await import("./project-coding-mode");
const { baseAbilities, overseerAbilities } = await import("./gathering-abilities");
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
function fake(opts: { attended?: boolean; autonomy?: Autonomy; roster?: Person[]; settings?: Partial<ProjectOverseerSettings>; hasSpec?: boolean; now?: () => Date; open?: number; builds?: CodingWorktree[] } = {}) {
  const calls: string[] = [];
  /** What the refusals held for a later look, by key (the host keeps one per key). */
  const held = new Map<string, HeldInput>();
  /** The mode each create/send reached the host with (a send without one records null). */
  const modes: (ProjectCodingMode | null)[] = [];
  /** The abilities each gathering start reached the host with. */
  const abilities: GatheringAbilities[] = [];
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
    batons: () => Array.from({ length: opts.open ?? 0 }, (_, i) => ({ sessionId: `open-${i}`, owner: { overseerOf: "prj_bbbbbbbb" }, state: "open", publicTitle: `Open ${i}` }) as never),
    batonView: async () => null,
    decisions: async () => ({ decisions: [], conflicts: [], spec: { specRoot: "", exists: false, frozen: false, draft: null, promoted: 0, drafted: 0 }, lastRun: null, running: false, names: {}, ownerAreas: [] }),
    reconcile: async () => {
      calls.push("reconcile");
      return { decisions: [], conflicts: [], spec: { specRoot: "", exists: false, frozen: false, draft: null, promoted: 0, drafted: 0 }, lastRun: null, running: false, names: {}, ownerAreas: [] };
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
    closeGathering: async (sid: string) => {
      calls.push(`close:${sid}`);
    },
    startGathering: async (input: { to: string | string[]; abilities: GatheringAbilities }) => {
      calls.push(`gather:${[input.to].flat().join(",")}`);
      abilities.push(input.abilities);
      return { sessionId: "b1", path: "/s/b1.jsonl", invited: [input.to].flat() };
    },
    decideReferral: async (id: string, approve: boolean) => {
      calls.push(`${approve ? "approve" : "decline"}:${id}`);
      return { ...roster.find((p) => p.id === id)!, status: approve ? ("active" as const) : ("left" as const) };
    },
    sessions: async () => sessions,
    transcript: async () => [],
    gatheringAbilities: (arg: unknown) => overseerAbilities(arg, baseAbilities(settings.gatheringAbilities)),
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
    builds: async () => opts.builds ?? [],
    startedCoding: () => new Map([["in-tree", { removed: false }], ["gone-tree", { removed: true }]]),
    hold: (h: HeldInput) => void held.set(h.key, h),
    postOwnerUpdate: async (input: { text: string; attended: boolean }) => {
      calls.push("owner-update");
      return { update: { id: "u_1", at: "", text: input.text, by: input.attended ? ("operator" as const) : ("overseer" as const) }, owner: "Alperen" };
    },
  };
  const limits = new PoLimits(undefined, opts.now);
  const tools = projectOverseerTools(host, limits, () => ({ redact: (t: string) => t, redactDeep: <T>(v: T) => v }) as never);
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, name);
    return t.execute("call-1", params, undefined, undefined, undefined as never);
  };
  return { host, tools, run, calls, modes, abilities, limits, paths, state, held, settings };
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
  sova_close_gathering: { session: "open-0", reason: "covered by a newer one" },
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
        const f = fake({ autonomy: level, roster: [person("p_tony0001", "Tony"), person("p_tony0002", "Toni")], open: 1 });
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
      const f = fake({ attended: true, autonomy: "L0", roster: [], open: 1 });
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

describe("gathering abilities (§app.baton/abilities)", () => {
  const gather = { person: "Tony", public_title: "Invoicing", goal: "Who approves invoices", question: "Who approves invoices?" };
  test("a start with no abilities gets the project's set: Automatic is draw on, read links off", async () => {
    const f = fake({ attended: true });
    await f.run("sova_start_gathering", gather);
    assert.deepEqual(f.abilities, [{ draw: true, readLinks: false }]);
  });
  test("it may turn draw off or on, and read links only when the project allows it", async () => {
    const f = fake({ attended: true, roster: [person("p_tony0001", "Tony"), person("p_ana00001", "Ana")], settings: { gatheringAbilities: { draw: false, readLinks: false } } });
    await f.run("sova_start_gathering", { ...gather, abilities: { draw: true } });
    await assert.rejects(() => f.run("sova_offer", { people: ["Tony", "Ana"], public_title: "x", goal: "g", question: "q?", abilities: { read_links: true } }), /Reading links is off for this project's gathering sessions; the operator can allow it on the project page\./);
    assert.deepEqual(f.abilities, [{ draw: true, readLinks: false }]);
    assert.equal(f.limits.count("gather"), 1, "the refusal counted nothing");
    const g = fake({ attended: true, settings: { gatheringAbilities: { draw: true, readLinks: true } } });
    await g.run("sova_start_gathering", { ...gather, abilities: { draw: false } });
    await g.run("sova_start_gathering", { ...gather, abilities: { read_links: false } });
    assert.deepEqual(g.abilities, [{ draw: false, readLinks: true }, { draw: true, readLinks: false }]);
  });
  test("an unknown ability or a non-boolean is refused before anything starts", async () => {
    const f = fake({ attended: true });
    await assert.rejects(() => f.run("sova_start_gathering", { ...gather, abilities: { search: true } }), /Unknown ability search/);
    await assert.rejects(() => f.run("sova_start_gathering", { ...gather, abilities: { draw: "yes" } }), /abilities\.draw must be true or false/);
    assert.deepEqual(f.calls, []);
  });
});

describe("scope and caps", () => {
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

  test("per-turn caps refuse without reaching the host; no token budget stops L3", async () => {
    const f = fake({ attended: true, settings: { caps: { ...defaultPoSettings().caps, createPerTurn: 1 } } });
    await f.run("sova_create_session", { prompt: "one" });
    await assert.rejects(() => f.run("sova_create_session", { prompt: "two" }), /This message's allowance is used: 1 of 1 coding sessions started per message you send\./);
    const g = fake({ attended: true });
    await g.run("sova_create_session", { prompt: "p" });
    await g.run("sova_send", { session: "in-root", text: "p" });
    assert.ok(!g.held.has("budget"));
  });

  test("sova_promote accounts for every id: promoted, refused with the reconciler's reason, or refused as unknown", async () => {
    const f = fake({ attended: true });
    const out = JSON.stringify(await f.run("sova_promote", { ids: ["s:1", "c:2", "nope"] }));
    assert.match(out, /Promoted 1, refused 2: c:2 \(in an open conflict\); nope \(not a drafted decision of this project/);
    assert.equal(f.limits.count("promote"), 1, "only the promoted id counts against the allowance");
    await assert.rejects(() => f.run("sova_promote", { ids: ["nope", "c:9"] }), /Promoted 0, refused 2/);
    assert.equal(f.limits.count("promote"), 1, "a call that promotes nothing takes nothing");
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

  test("sova_promote: a request over what is left is refused whole and takes nothing; refused ids are given back", async () => {
    const f = fake({ attended: true, settings: { caps: { ...defaultPoSettings().caps, promotePerTurn: 2 } } });
    await assert.rejects(() => f.run("sova_promote", { ids: ["s:1", "s:2", "s:3"] }), /This message's allowance is used: 0 of 2 decisions promoted per message you send\./);
    assert.equal(f.limits.count("promote"), 0);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("promote")), [], "nothing promoted");
    await f.run("sova_promote", { ids: ["s:1", "nope"] });
    assert.equal(f.limits.count("promote"), 1);
    await f.run("sova_promote", { ids: ["s:2"] });
    assert.equal(f.limits.count("promote"), 2);
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
      assert.match(goal, /never say how the answers will be recorded or under which area \("as finance decisions"\)/, name);
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

  test("a mode refusal comes before the caps", async () => {
    const f = fake({ attended: true });
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

describe("sova_card items (the shared tool)", () => {
  const create = (fields: Record<string, unknown>) => ({ ops: [{ op: "create", title: "?", options: [{ label: "Go" }], ...fields }] });
  test("it resolves only the project's sessions, and runs in an unattended L0 run", async () => {
    const f = fake({ autonomy: "L0" });
    const out = await f.run("sova_card", create({ title: "Stop these?", options: [{ label: "Stop" }], items: { sessions: ["in-root", "sova://s/in-tree"] } }));
    assert.equal(out.terminate, undefined);
    assert.deepEqual(
      out.details.card.items.map((i: { id: string; project?: string; n: number }) => [i.n, i.id, i.project]),
      [[1, "in-root", "app"], [2, "in-tree", "proj-fix-abc123"]],
    );
    assert.match((out.content[0] as { text: string }).text, /Shown to the operator under your reply/);
    assert.match((out.content[0] as { text: string }).text, /1\. \[Inside\]\(sova:\/\/s\/in-root\) \(in-root\)/);
    await assert.rejects(f.run("sova_card", create({ items: { sessions: ["in-root", "outside", "global"] } })), /sessions: outside, global/);
    await assert.rejects(f.run("sova_card", create({ items: { sessions: ["po-self"] } })), /po-self is your own conversation/);
  });
  test("its link options open the project's sessions or an https URL, never an org page", async () => {
    const f = fake({ autonomy: "L0" });
    const out = await f.run("sova_card", create({ options: [{ label: "Go" }, { label: "Open", link: { session: "in-root" } }, { label: "Doc", link: { url: "https://example.com/doc" } }] }));
    assert.deepEqual(out.details.card.options.map((o: { href?: string }) => o.href?.split("%2F")[0]), [undefined, "#/s/", "https://example.com/doc"]);
    await assert.rejects(f.run("sova_card", create({ options: [{ label: "Go" }, { label: "X", link: { session: "global" } }] })), /A link here opens one of the project's sessions/);
    await assert.rejects(f.run("sova_card", create({ options: [{ label: "Go" }, { label: "X", link: { org: "any" } }] })), /A link here opens one of the project's sessions/);
  });
});

describe("two allowances: each message you send, and on its own each day", () => {
  const caps = (c: Partial<ProjectOverseerSettings["caps"]>) => ({ caps: { ...defaultPoSettings().caps, ...c } });
  const gather = ACTS.sova_start_gathering!;

  test("the operator's turns take the message allowance, runs on its own the day's; neither refills the other", async () => {
    const f = fake({ attended: true, settings: caps({ gatherPerTurn: 1, gatherPerDay: 1 }) });
    await f.run("sova_start_gathering", gather);
    await assert.rejects(() => f.run("sova_start_gathering", gather), /This message's allowance is used: 1 of 1 gathering sessions started per message you send\./);
    f.state.attended = false;
    await f.run("sova_start_gathering", gather);
    await assert.rejects(() => f.run("sova_start_gathering", gather), /Today's allowance is used: 1 of 1 gathering sessions started on its own\. It looks again at midnight\./);
    // The operator's next message resets only its own allowance.
    f.limits.reset();
    await assert.rejects(() => f.run("sova_start_gathering", gather), /Today's allowance is used/);
    f.state.attended = true;
    await f.run("sova_start_gathering", gather);
    assert.deepEqual([f.limits.count("gather", true), f.limits.count("gather", false)], [1, 1]);
    assert.equal(f.calls.filter((c) => c.startsWith("gather:")).length, 3);
  });

  test("the default allowances on its own let a story start 4 gathering sessions with no operator message", async () => {
    const f = fake();
    for (let i = 0; i < 4; i++) await f.run("sova_start_gathering", gather);
    assert.equal(f.calls.filter((c) => c.startsWith("gather:")).length, 4);
    assert.equal(defaultPoSettings().caps.gatherPerDay, 6);
  });

  test("Unlimited (null) never refuses; the at-once limits still do", async () => {
    const f = fake({ settings: caps({ promotePerDay: null, gatherPerDay: null, gatheringsOpen: 2 }), autonomy: "L3" });
    const ids = Array.from({ length: 1500 }, (_, i) => `s:${i}`);
    await f.run("sova_promote", { ids });
    await f.run("sova_create_session", { prompt: "unlimited never refuses" });
    const g = fake({ settings: caps({ gatherPerDay: null, gatheringsOpen: 2 }), open: 2 });
    await assert.rejects(() => g.run("sova_start_gathering", gather), /2 of its gathering sessions are open, and the limit is 2 at once\./);
    assert.equal(g.held.size, 0, "an at-once refusal holds nothing: a session finishing is already a reason");
  });

  test("the activity log has the operator's sentence only; the model also gets the tail", async () => {
    const f = fake({ settings: caps({ gatherPerDay: 0 }) });
    const err = await f.run("sova_start_gathering", gather).then(() => null, (e: Error) => e);
    assert.match(err?.message ?? "", /Today's allowance is used: 0 of 0 gathering sessions started on its own\. It looks again at midnight\. Nothing starts before then\. Tell the operator what is waiting; don't promise an earlier look\./);
    const last = readFileSync(f.paths.actions, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.outcome, "refused");
    assert.equal(last.error, "Today's allowance is used: 0 of 0 gathering sessions started on its own. It looks again at midnight.");
  });

  test("a refusal holds one item per limit, with when to retry", async () => {
    const now = new Date(2026, 8, 27, 14, 11);
    const f = fake({ settings: caps({ gatherPerDay: 1 }), now: () => now, autonomy: "L3" });
    await f.run("sova_start_gathering", gather);
    await assert.rejects(() => f.run("sova_start_gathering", gather));
    await assert.rejects(() => f.run("sova_start_gathering", gather));
    const day = f.held.get("day:gather");
    assert.equal(day?.retryAt, nextMidnight(now).toISOString());
    assert.equal(day?.retryAt, new Date(2026, 8, 28).toISOString());
    f.state.attended = true;
    f.settings.caps.createPerTurn = 0;
    await assert.rejects(() => f.run("sova_create_session", { prompt: "p" }), /This message's allowance is used/);
    assert.equal(f.held.get("message:create")?.retryAt, now.toISOString(), "a later look of its own may go on");
    assert.deepEqual([...f.held.keys()].sort(), ["day:gather", "message:create"]);
  });

  test("the day's allowance resets at local midnight", async () => {
    let now = new Date(2026, 8, 27, 23, 59);
    const f = fake({ settings: caps({ gatherPerDay: 1 }), now: () => now });
    await f.run("sova_start_gathering", gather);
    await assert.rejects(() => f.run("sova_start_gathering", gather));
    now = new Date(2026, 8, 28, 0, 0);
    await f.run("sova_start_gathering", gather);
    assert.equal(f.limits.count("gather", false), 1);
  });

  test("the counters file: v1 is the message allowance; v2 keeps both, the day's by its key", () => {
    const dir = join(root, "turns");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "turn.json");
    writeFileSync(file, JSON.stringify({ version: 1, used: { gather: 2, promote: 0, create: 1, prompt: 0 } }));
    const now = new Date(2026, 8, 27, 12);
    const a = new PoLimits(file, () => now);
    assert.deepEqual([a.count("gather", true), a.count("create", true), a.count("gather", false)], [2, 1, 0]);
    assert.equal(a.take("gather", false, { ...defaultPoSettings().caps }), null);
    const b = new PoLimits(file, () => now);
    assert.deepEqual([b.count("gather", true), b.count("gather", false)], [2, 1]);
    const tomorrow = new PoLimits(file, () => new Date(2026, 8, 28, 1));
    assert.equal(tomorrow.count("gather", false), 0, "another day's counts are not today's");
  });

  test("sova_project reports both allowances, the looks and what is held, and no cost or tokens", async () => {
    const f = fake({ settings: caps({ gatherPerDay: null }) });
    await f.run("sova_start_gathering", gather);
    const out = JSON.stringify(await f.run("sova_project"));
    assert.match(out, /Today on your own: 1 gathering sessions started \(no limit\)/);
    assert.match(out, /This operator message: 0 of 3 gathering sessions started/);
    assert.doesNotMatch(out, /Coding tokens|token budget|\$\d|cost/i);
    for (const t of f.tools) assert.doesNotMatch(`${t.description} ${t.promptSnippet ?? ""}`, /\btokens?\b|budget|\$\d/i, t.name);
    assert.match(out, /Looks on your own: at most 12 a day/);
  });
});

/** A tool result's text. */
const textOf = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text;

/** A build row as the project page lists it (codingWorktrees). */
const build = (over: Partial<CodingWorktree>): CodingWorktree => ({
  sessionId: "b-1",
  path: "/s/b-1.jsonl",
  title: "Dashboard v2",
  startedBy: "overseer",
  branch: "sova/dashboard-v2-3f9a1c",
  worktree: "/.worktrees/proj-dashboard-v2-3f9a1c",
  base: "abc",
  target: "master",
  state: "open",
  merged: false,
  ahead: 2,
  dirty: false,
  running: false,
  workers: 0,
  createdAt: "2026-09-28T05:00:00.000Z",
  ...over,
});

describe("builds: who started each coding session, its branch and whether it is merged (NEW-MS-2)", () => {
  test("buildState words each case from git's answer", () => {
    assert.equal(buildState(build({ merged: true, state: "merged" })), "merged into master");
    assert.equal(buildState(build({ ahead: 2 })), "2 commits, not merged into master");
    assert.equal(buildState(build({ ahead: 1 })), "1 commit, not merged into master");
    assert.equal(buildState(build({ ahead: 0 })), "no commits yet");
    assert.equal(buildState(build({ merged: false, newSinceMerge: 3, mergedAt: "x" })), "3 new commits since its last merge, not merged into master");
    assert.equal(buildState(build({ state: "root", branch: null, inRoot: "it isn't a Git repository." })), "in the project root (it isn't a Git repository)");
    assert.equal(buildState(build({ merged: true, state: "removed" })), "merged into master, worktree removed");
    assert.equal(buildState(build({ dirty: true })), "2 commits, not merged into master, uncommitted changes in its worktree");
  });

  test("sova_list_sessions lists every build, the operator's included, with its branch and merge state; other root sessions apart", async () => {
    const f = fake({
      builds: [
        build({ sessionId: "in-tree", title: "Wireframe", startedBy: "operator", merged: true, state: "merged" }),
        build({ sessionId: "dup", title: "", startedBy: "overseer", ahead: 1, path: null }),
      ],
    });
    const out = textOf(await f.run("sova_list_sessions"));
    assert.match(out, /- in-tree "Wireframe" · started by the operator · idle · sova\/dashboard-v2-3f9a1c · merged into master/);
    assert.match(out, /- dup "Untitled coding session" · started by you · idle · sova\/dashboard-v2-3f9a1c · 1 commit, not merged into master · on another host/);
    assert.match(out, /## Other sessions in the project root\n- in-root "Inside"/);
    assert.ok(!/- in-tree "Worktree"/.test(out), "a build is listed once, as a build");
  });

  test("sova_project has a Builds section with the same lines", async () => {
    const f = fake({ builds: [build({ merged: true, state: "merged" })] });
    const out = textOf(await f.run("sova_project"));
    assert.match(out, /## Builds \(coding sessions, newest first; merged is read from git\)\n- b-1 "Dashboard v2" · started by you · idle · sova\/dashboard-v2-3f9a1c · merged into master/);
    const none = textOf(await fake().run("sova_project"));
    assert.match(none, /## Builds[^\n]*\n\(none yet\)/);
  });
});

describe("the operator's to-dos are theirs (NEW-MS-1, NEW-MS-4)", () => {
  test("sova_todos reads only in a turn the operator started", async () => {
    await assert.rejects(() => fake({ autonomy: "L3" }).run("sova_todos"), /The to-do list is the operator's own: you read it only when the operator asks/);
    const out = textOf(await fake({ attended: true }).run("sova_todos"));
    assert.equal(out, "(none)");
  });
});

describe("owner areas reach the promotion check (NEW-MS-5)", () => {
  test("sova_decisions shows each decision's owner area and whether its author decides it", async () => {
    const f = fake();
    const row = { id: "s:1", areaKey: "layout", area: "Layout", ownerArea: "finance", authorOwnsArea: true, state: "drafted", name: "Tahir", statement: "Net profit first", quote: "net profit first" };
    f.host.decisions = async () => ({ decisions: [row], conflicts: [], spec: { specRoot: "", exists: false, frozen: false, draft: null, promoted: 0, drafted: 1 }, lastRun: null, running: false, names: {}, ownerAreas: [] }) as never;
    const out = textOf(await f.run("sova_decisions"));
    assert.match(out, /owner area: finance · the author decides it/);
    const promote = f.tools.find((t) => t.name === "sova_promote")!;
    assert.match(promote.description, /check its owner area fits what it is about/);
  });
});

describe("closing its own gatherings (NEW-MS2-2)", () => {
  const b = (x: Record<string, unknown>) => ({ owner: { overseerOf: "prj_bbbbbbbb" }, state: "open", publicTitle: "Invoices", ...x }) as never;
  const batons = [
    b({ sessionId: "unsent" }),
    b({ sessionId: "answered", wroteAt: "2026-09-28T12:00:00Z" }),
    b({ sessionId: "settle", conflict: { id: "cf_1", area: "invoicing" } }),
    b({ sessionId: "theirs", owner: "operator" }),
    b({ sessionId: "over", state: "done" }),
  ];
  test("closes only one it started that nobody has written in, with its reason as the note", async () => {
    const f = fake();
    f.host.batons = () => batons;
    const out = await f.run("sova_close_gathering", { session: "sova://s/unsent", reason: "covered by the newer invoicing session" });
    assert.deepEqual(f.calls, ["close:unsent"]);
    assert.match(textOf(out), /Closed/);
    const log = readFileSync(f.paths.actions, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.at(-1).note, "Closed: covered by the newer invoicing session");
  });
  test("never a settle session, the operator's, one already over or one someone answered; a reason is required", async () => {
    const f = fake();
    f.host.batons = () => batons;
    const close = (session: string, reason = "old") => f.run("sova_close_gathering", { session, reason });
    await assert.rejects(close("settle"), /settle session: the conflict ends when it is settled/);
    await assert.rejects(close("theirs"), /Not one of your gathering sessions/);
    await assert.rejects(close("nope"), /Not one of your gathering sessions/);
    await assert.rejects(close("over"), /It is already done/);
    await assert.rejects(close("answered"), /already written in it/);
    await assert.rejects(close("unsent", " "), /Say why/);
    assert.deepEqual(f.calls, []);
  });
  test("its description says when: a newer gathering covers an unanswered one", () => {
    const t = fake().tools.find((x) => x.name === "sova_close_gathering")!;
    assert.match(t.description, /nobody has written in yet: when a newer one covers it/);
  });
});

describe("what is built reaches the overseer (§app.requirements/decisions)", () => {
  test("sova_decisions and sova_project say built or not built yet, and edited in the spec", async () => {
    const f = fake();
    const row = (id: string, x: Record<string, unknown>) => ({ id, areaKey: "invoicing", area: "Invoicing", authorOwnsArea: true, state: "promoted", name: "Tahir", statement: `S ${id}`, quote: "q", ...x });
    const spec = { specRoot: "", exists: true, frozen: false, draft: null, promoted: 3, drafted: 0, built: 1, notBuilt: 1 };
    f.host.decisions = async () => ({ decisions: [row("s:1", { build: "built" }), row("s:2", { build: "not-built", editedInSpec: true })], conflicts: [], spec, lastRun: null, running: false, names: {}, ownerAreas: [] }) as never;
    const out = textOf(await f.run("sova_decisions"));
    assert.match(out, /s:1 · invoicing · promoted · built \(as the build recorded it\)/);
    assert.match(out, /s:2 · invoicing · promoted · not built yet · edited in the spec since it was promoted/);
    assert.match(textOf(await f.run("sova_project")), /exists · 3 promoted · 1 built, 1 not built yet · 0 drafted, not promoted/);
  });
});
