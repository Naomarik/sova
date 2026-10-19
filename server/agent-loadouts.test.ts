// What each agent tool family declares to the model, frozen word for word: every tool's name,
// label, description, parameters and prompt lines, each family's byte total, and the refusal
// sentences the tools relay. Built in-process from the code with stub hosts (nothing is copied by
// hand). A deliberate wording change regenerates the snapshot in the same commit:
//   SOVA_LOADOUT_UPDATE=1 bun test server/agent-loadouts.test.ts
// and the snapshot's diff is reviewed with it.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-agent-loadouts-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const overseer = await import("./overseer-tools");
const po = await import("./project-overseer-tools");
const powers = await import("./session-powers");
const verbs = await import("./project-services/tools");
const { linkTools } = await import("./overseer-link-tools");
const { overseerFileTools } = await import("./overseer-file-tools");
const guards = await import("./session-guards");
const { GAP_PARAM } = await import("./overseer-org-part");

const SNAPSHOT = new URL("./agent-loadouts.snapshot.json", import.meta.url);
const CWD = "/work/project";

type Decl = { name: string; label: string; description: string; promptSnippet?: string; promptGuidelines?: string[]; parameters: unknown };
const identity = () => ({ redact: (t: string) => t, redactDeep: <T>(v: T) => v }) as never;
const noop = (() => async () => ({ content: [], details: {} })) as never;
const engine = (() => ({})) as never;

/** The model-facing part of a tool, as JSON (a schema's symbols drop out, as on the wire). */
function decl(t: { name: string; label?: string; description?: string; promptSnippet?: string; promptGuidelines?: string[]; parameters?: unknown }): Decl {
  return JSON.parse(
    JSON.stringify({
      name: t.name,
      label: t.label,
      description: t.description,
      promptSnippet: t.promptSnippet,
      promptGuidelines: t.promptGuidelines,
      parameters: t.parameters,
    }),
  ) as Decl;
}

const profile = (grant: string[]) =>
  ({ id: "loadout", label: "Loadout", icon: "bot", description: "", remove: [], grant, singleton: false, limits: {} }) as never;
const powersTools = (grant: string[]) =>
  powers.sessionPowersTools({ sessionId: "s-1", cwd: CWD, title: () => "Loadout", profile: profile(grant), run: {} as never, limits: {} as never }, () => join(agentDir, "actions.jsonl"));

/** The project overseer's host: no gaps tracked and no part contributing tools unless given (the org
    part's own tools need an open org host, so they are not frozen here). */
const poHost = (over: Record<string, unknown>) => ({ gaps: () => null, contributed: () => [], ...over }) as never;

const fileWrites = { protectedRoots: () => [], attended: () => true, unattended: po.PO_UNATTENDED_WRITE_REFUSAL, log: () => {} };

function families(): Record<string, Decl[]> {
  return {
    overseer: overseer.overseerTools({} as never, new overseer.TurnLimits(), identity).map(decl),
    "overseer-files": overseerFileTools(CWD, undefined, identity, undefined, fileWrites).map(decl),
    "project-overseer": po.projectOverseerTools(poHost({}), identity).map(decl),
    "project-overseer+onboard": po.projectOverseerTools(poHost({ onboard: () => {} }), identity).map(decl),
    "project-overseer+gaps": po.projectOverseerTools(poHost({ gaps: () => ({ param: GAP_PARAM }) }), identity).map(decl),
    "session-powers:read": powersTools(["sessions.read"]).map(decl),
    "session-powers:read+message": powersTools(["sessions.read", "sessions.message"]).map(decl),
    "session-powers:all": powersTools(["sessions.read", "sessions.message", "sessions.all"]).map(decl),
    "project-verbs:session": [decl(verbs.sessionVerbsTool(engine))],
    "project-verbs:overseer": [decl(verbs.overseerVerbsTool(engine, () => "o-1", (e) => e))],
    "project-verbs:overseer+onboard": [decl(verbs.overseerVerbsTool(engine, () => "o-1", (e) => e, noop))],
    "project-verbs:project-overseer": [decl(verbs.projectOverseerVerbsTool(engine, { id: () => "o-1", root: () => CWD, act: noop }))],
    links: linkTools({
      act: noop,
      read: noop,
      links: {} as never,
      take: () => null,
      refusal: (m) => new Error(m),
      obj: (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false }),
      str: (description, extra = {}) => ({ type: "string", description, ...extra }),
    }).map(decl),
  };
}

const summary = (over: Partial<SessionSummary>) => ({ id: "s-2", path: "/s/2.jsonl", title: "Target", ...over }) as SessionSummary;

/** archiveSession's refusals, read from its source: each `error: "..."` (or constant) it returns. */
function archiveRefusals(): string[] {
  const src = readFileSync(new URL("./sessions-index.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function archiveSession(");
  assert.ok(start >= 0, "archiveSession not found in sessions-index.ts");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const out: string[] = [];
  for (const m of body.matchAll(/error: (?:"((?:[^"\\]|\\.)*)"|([A-Z_]+))/g)) {
    if (m[1] !== undefined) out.push(JSON.parse(`"${m[1]}"`) as string);
    else {
      const c = new RegExp(`const ${m[2]}\\s*=\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(src);
      assert.ok(c, `archiveSession refusal ${m[2]} is not a string constant in sessions-index.ts: freeze it another way`);
      out.push(JSON.parse(`"${c[1]}"`) as string);
    }
  }
  const all = body.match(/\berror:/g)?.length ?? 0;
  assert.equal(out.length, all, "an archiveSession refusal is not a literal or a constant: the snapshot cannot read it");
  return out;
}

function refusals(): Record<string, unknown> {
  return {
    "session-guards": {
      "writableRefusal(overseer)": guards.writableRefusal(summary({ overseer: true } as never)),
      "writableRefusal(overseer, self)": guards.writableRefusal(summary({ overseer: true } as never), "a project overseer never acts on its Overseer"),
      "writableRefusal(live)": guards.writableRefusal(summary({ live: { pid: 4242 } } as never)),
      "writableRefusal(worker)": guards.writableRefusal(summary({ workerSession: true } as never)),
      "writableRefusal(plain)": guards.writableRefusal(summary({})),
      "subagentSessionRefusal": guards.subagentSessionRefusal("Target"),
    },
    "overseer-tools": {
      UNATTENDED_REFUSAL: overseer.UNATTENDED_REFUSAL,
      UNATTENDED_WRITE_REFUSAL: overseer.UNATTENDED_WRITE_REFUSAL,
      SANDBOX_LOWER_REFUSAL: overseer.SANDBOX_LOWER_REFUSAL,
      SANDBOX_LOWER_CREATE_REFUSAL: overseer.SANDBOX_LOWER_CREATE_REFUSAL,
    },
    "project-overseer-tools": {
      PO_UNATTENDED_WRITE_REFUSAL: po.PO_UNATTENDED_WRITE_REFUSAL,
      PREVIEW_IN_GATHERING: po.PREVIEW_IN_GATHERING,
    },
    "sessions-index.archiveSession": archiveRefusals(),
  };
}

function build() {
  const fam = families();
  const out: Record<string, { bytes: number; tools: Decl[] }> = {};
  for (const [k, tools] of Object.entries(fam)) out[k] = { bytes: Buffer.byteLength(JSON.stringify(tools)), tools };
  return { families: out, refusals: refusals() };
}

/** Where two strings first differ, with context: what a reviewer needs to see the change. */
function where(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `at char ${i}: frozen ${ctx(a)} vs now ${ctx(b)}`;
}

test("agent loadouts match the snapshot word for word", () => {
  const now = build();
  if (process.env.SOVA_LOADOUT_UPDATE === "1") {
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
    return;
  }
  const frozen = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as ReturnType<typeof build>;
  const problems: string[] = [];
  const famNames = new Set([...Object.keys(frozen.families), ...Object.keys(now.families)]);
  for (const f of famNames) {
    const a = frozen.families[f];
    const b = now.families[f];
    if (!a || !b) {
      problems.push(`family ${f}: ${a ? "removed" : "added"}`);
      continue;
    }
    const an = a.tools.map((t) => t.name);
    const bn = b.tools.map((t) => t.name);
    for (const n of an) if (!bn.includes(n)) problems.push(`${f}/${n}: tool removed`);
    for (const n of bn) if (!an.includes(n)) problems.push(`${f}/${n}: tool added`);
    if (an.filter((n) => bn.includes(n)).join() !== bn.filter((n) => an.includes(n)).join()) problems.push(`${f}: tool order changed (${bn.join(", ")})`);
    for (const ta of a.tools) {
      const tb = b.tools.find((t) => t.name === ta.name);
      if (!tb) continue;
      for (const k of ["label", "description", "promptSnippet", "promptGuidelines", "parameters"] as const) {
        const x = JSON.stringify(ta[k] ?? null);
        const y = JSON.stringify(tb[k] ?? null);
        if (x !== y) problems.push(`${f}/${ta.name}.${k} changed ${where(x, y)}`);
      }
    }
    if (a.bytes !== b.bytes) problems.push(`${f}: bytes ${a.bytes} -> ${b.bytes}`);
  }
  const ra = JSON.stringify(frozen.refusals, null, 1);
  const rb = JSON.stringify(now.refusals, null, 1);
  if (ra !== rb) problems.push(`refusals changed ${where(ra, rb)}`);
  assert.ok(problems.length === 0, `Agent loadouts changed (regenerate with SOVA_LOADOUT_UPDATE=1 only if deliberate):\n${problems.join("\n")}`);
});
