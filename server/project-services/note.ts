import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { VerbResult } from "../../shared/project-contract";
import { sandboxInfo } from "../sandbox-state";
import type { ProjectEngine } from "./engine";

/**
 * The instance note (§app.project-services/instance-note): what a coding session is told about each of
 * its own running copies, rendered from the checkout's definition and the registry. `instanceNote` is
 * pure; the engine gathers the facts (`ProjectEngine.noteFacts`). The text holds no live state, so it
 * changes only when a slot, port, data ref, `about`, the test command, the approval or the sandbox does.
 */

export const NOTE_MESSAGE = "sova-instance-note";

export type NoteFacts =
  | { kind: "invalid"; checkout: string; problem: string }
  | { kind: "no-instance"; checkout: string }
  | {
      kind: "instance";
      checkout: string;
      branch: string | null;
      project: string;
      instance: string;
      slot: number;
      approved: boolean;
      ports: { key: string; port: number; main: number; url?: string; shared: boolean }[];
      services: { name: string; about?: string; onDemand: boolean }[];
      data: { name: string; ref: string }[];
      test: { smoke: string[] } | null;
    };

/** One checkout's note. */
export function instanceNote(f: NoteFacts, sandboxed: boolean): string {
  if (f.kind === "invalid") return `Sova instance note for ${f.checkout}: its .sova/project.json is invalid (${f.problem}); project_verbs doctor says more.`;
  if (f.kind === "no-instance") return `Sova instance note for ${f.checkout}: it has no running copy yet; project_verbs up gives it its own ports.`;
  const lines = [
    `Sova instance note for ${f.checkout}${f.branch ? ` (branch ${f.branch})` : ""}: instance ${f.instance}, slot ${f.slot}, its own running copy of ${f.project}.` +
      (f.approved ? "" : " Its definition is not approved on this host yet: the operator approves it before anything runs."),
  ];
  if (f.ports.length) {
    lines.push("Ports, this instance's (the main checkout's in brackets):");
    for (const p of f.ports) lines.push(`- ${p.key}: ${p.port} (main checkout: ${p.main})${p.url ? `, ${p.url}` : ""}${p.shared ? ", shared" : ""}`);
  }
  const described = f.services.filter((s) => s.about || s.onDemand);
  if (described.length) {
    lines.push("Services:");
    for (const s of described) lines.push(`- ${s.name}${s.onDemand ? ", on-demand (test or up with services starts it)" : ""}${s.about ? `: ${s.about}` : ""}`);
  }
  if (f.data.length) {
    lines.push("Data:");
    for (const d of f.data) lines.push(`- ${d.name}: ${d.ref}`);
  }
  lines.push(
    f.test
      ? `Tests: project_verbs {verb: "test", select: [...]} runs them in this instance; no select runs the whole suite. Smoke selection: ${f.test.smoke.join(" ")}.`
      : "Tests: this project declares no test command.",
  );
  lines.push("Start, reload and stop these through project_verbs, never by hand.");
  if (sandboxed) lines.push("Your shell is sandboxed and cannot reach these ports: use project_verbs.");
  return lines.join("\n");
}

export const noteDigest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

type Entry = { type?: string; customType?: string; details?: unknown };

/** The digest of the last instance note on the branch, or null. */
export function lastNoteDigest(branch: readonly unknown[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as Entry;
    if (e?.type === "custom_message" && e.customType === NOTE_MESSAGE) {
      const d = (e.details as { digest?: unknown } | undefined)?.digest;
      return typeof d === "string" ? d : null;
    }
  }
  return null;
}

/** Whether the session's sandbox is on (its branch's `sandbox` entry). */
export const sandboxedOf = (branch: readonly unknown[]): boolean => sandboxInfo(branch as Parameters<typeof sandboxInfo>[0]).on;

/** The hidden message for `text`, carrying its digest. */
export const noteMessage = (text: string) => ({ customType: NOTE_MESSAGE, content: text, display: false as const, details: { v: 1, digest: noteDigest(text) } });

/** The note of every checkout in `checkouts` that has one, joined; null when none does. */
export async function currentNote(engine: ProjectEngine, checkouts: readonly string[], branch: readonly unknown[]): Promise<string | null> {
  const sandboxed = sandboxedOf(branch);
  const parts: string[] = [];
  for (const c of checkouts) {
    const f = await engine.noteFacts(c);
    if (f) parts.push(instanceNote(f, sandboxed));
  }
  return parts.length ? parts.join("\n\n") : null;
}

const SINGLE = new Set(["create", "up", "apply", "status"]);

/** The note that follows a create, up, apply or status result of one instance (the tools'), or null. */
export async function resultNote(engine: ProjectEngine, r: VerbResult, branch: readonly unknown[]): Promise<string | null> {
  if (!SINGLE.has(r.verb) || !r.instance || !r.checkout || r.instances) return null;
  try {
    const f = await engine.noteFacts(r.checkout);
    return f ? instanceNote(f, sandboxedOf(branch)) : null;
  } catch {
    return null;
  }
}

interface NoteCtx {
  sessionManager?: { getBranch(): readonly unknown[] };
}

/**
 * Deliver the note in a session (projectVerbsExtension): at a turn's start as a hidden message, only when
 * its text differs from the last one on the branch; after a compaction, again. Never in the system prompt.
 */
export function registerInstanceNote(pi: ExtensionAPI, engine: () => ProjectEngine, own: (ctx: unknown) => Promise<string[]>): void {
  const render = async (ctx: unknown): Promise<string | null> => {
    try {
      return await currentNote(engine(), await own(ctx), (ctx as NoteCtx).sessionManager?.getBranch() ?? []);
    } catch {
      return null;
    }
  };
  pi.on("before_agent_start", async (_event, ctx) => {
    const text = await render(ctx);
    if (!text || lastNoteDigest((ctx as NoteCtx).sessionManager?.getBranch() ?? []) === noteDigest(text)) return undefined;
    return { message: noteMessage(text) };
  });
  pi.on("session_compact", async (_event, ctx) => {
    const text = await render(ctx);
    if (text) pi.sendMessage(noteMessage(text));
  });
}
