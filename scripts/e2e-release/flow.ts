/**
 * Tests only. Drives a release on a hermetic server (server-kit.ts) the way the release chat and the operator do
 * (CONTRACT.md §5): the operator's acts through the operator route, the chat's reports through the chat's own
 * project_verbs tool (the scripted model calls it when the test wakes the chat), and the chat's hands (the bump
 * commit) as plain git in the release checkout. Every wait polls a condition with a deadline.
 */
import { existsSync } from "node:fs";
import type { ReleaseFixture } from "./fixtures";
import { until } from "./fixtures";
import type { ModelAction, ReleaseServer, VerbAnswer } from "./server-kit";

/* Loose shapes of shared/release.ts (the kit never pins the contract's types). */
export type Rec = Record<string, any> & { id: string; state: string; steps: Array<Record<string, any> & { id: string; state: string }> };
export type View = Record<string, any> & { initialized: boolean; open: Rec | null; history: Array<Record<string, any>> };

export const ok = (r: VerbAnswer, what: string): VerbAnswer => {
  if (r.status !== 200 || r.json.ok === false) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json.error ?? r.json).slice(0, 600)}`);
  return r;
};

export async function view(k: ReleaseServer, fx: ReleaseFixture): Promise<View> {
  const r = ok(await k.verb("release.status", { project: fx.project }), "release.status");
  return r.json.release.view as View;
}
export async function record(k: ReleaseServer, fx: ReleaseFixture, id?: string): Promise<Rec> {
  const v = await view(k, fx);
  if (v.open && (!id || v.open.id === id)) return v.open;
  if (v.last && (!id || v.last.id === id)) return v.last as Rec;
  // An older closed release: release.logs answers its record.
  const r = ok(await k.verb("release.logs", { project: fx.project, ...(id ? { release: id } : {}) }), "release.logs");
  return r.json.release.release as Rec;
}
export const stepOf = (rec: Rec, id: string) => {
  const s = rec.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in ${rec.steps.map((x) => x.id).join(",")}`);
  return s;
};

/** The thread's marker: every wake prompt carries it, so only that chat's requests pop its script. */
export const marker = (rec: Rec) => `[release-thread ${rec.id}]`;

/** The release chat's session path (CONTRACT: record.thread.session). */
export function threadPath(rec: Rec): string {
  const p = rec.thread?.path;
  if (!p) throw new Error(`release ${rec.id} has no thread: ${JSON.stringify(rec.thread)}`);
  return String(p);
}
/** The release checkout the chat works in (record.thread.checkout, else the fixture's worktree for release/<id>). */
export function threadCheckout(fx: ReleaseFixture, rec: Rec): string {
  const c = rec.thread?.checkout;
  if (c && existsSync(c)) return String(c);
  void fx;
  throw new Error(`release ${rec.id}: no checkout on the record (${JSON.stringify(rec.thread)})`);
}

/** Wake the release chat with a prompt that makes it run `actions` (each a tool call or a closing text). */
export async function chatDoes(k: ReleaseServer, rec: Rec, actions: ModelAction[], say = "Go on with the release."): Promise<void> {
  const before = (await k.model.log()).length;
  await k.model.script(marker(rec), [...actions, { text: "Reported." }]);
  ok(await k.http("POST", "/api/sessions/prompt", { path: threadPath(rec), text: `${marker(rec)} ${say}` }), "prompt the release chat");
  // The turn has run every action once the closing text was popped.
  await until(`the release chat to run ${actions.length} action(s)`, async () => {
    const log = (await k.model.log()).slice(before);
    return log.some((e) => e.match === marker(rec) && e.action?.text === "Reported.");
  }, 120_000, 100);
}

/** One release.step through the chat's own tool; `facts` as an object, sent as the tool's `key=value` list. */
export const step = (s: string, state: string, summary: string, extra: { facts?: Record<string, string | number>; detail?: string } = {}): ModelAction => ({
  tool: "project_verbs",
  args: {
    verb: "release.step",
    step: s,
    state,
    summary,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.facts ? { facts: Object.entries(extra.facts).map(([k, v]) => `${k}=${v}`) } : {}),
  },
});
export const notes = (text: string): ModelAction => ({ tool: "project_verbs", args: { verb: "release.notes", text } });

/** The tool results the chat saw for its last `n` calls (to read a refusal). */
export async function lastToolResults(k: ReleaseServer, rec: Rec): Promise<string[]> {
  return (await k.model.log()).filter((e) => e.match === marker(rec)).flatMap((e) => e.toolResults.slice(-1));
}

export async function waitRecord(k: ReleaseServer, fx: ReleaseFixture, what: string, pred: (r: Rec) => boolean, ms = 180_000, id?: string): Promise<Rec> {
  let last: Rec | null = null;
  try {
    return await until(what, async () => {
      last = await record(k, fx, id);
      return pred(last) ? last : null;
    }, ms, 200);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nlast record: ${JSON.stringify(last, null, 1)?.slice(0, 3000)}`);
  }
}

/** Start a release as the operator; resolves once the record and its chat exist. */
export async function start(k: ReleaseServer, fx: ReleaseFixture, body: Record<string, unknown> = {}): Promise<Rec> {
  ok(await k.verb("release.start", { project: fx.project, ...body }), "release.start");
  return waitRecord(k, fx, "the release and its chat", (r) => !!r.thread?.path);
}

/**
 * The prepare phase as the fixture's playbook does it: version, notes, bump (the chat's hands commit in the release
 * checkout), commit (reported with facts.commit, so Sova adds the release entry). Resolves with the release commit.
 */
export async function prepare(k: ReleaseServer, fx: ReleaseFixture, rec: Rec, version: string, o: { gate?: "pass" | "fail" | "hold"; releaseGate?: "pass" | "fail" | "hold" } = {}): Promise<string> {
  await chatDoes(k, rec, [
    step("version", "done", `v${version} · adds features`, { facts: { version } }),
    notes(`- Adds the landings since the last release (${version}).`),
    step("notes", "done", "notes drafted"),
  ]);
  const co = threadCheckout(fx, rec);
  const files: Record<string, string> = { ...fx.releaseFiles(version) };
  if (o.gate) files["gate.conf"] = `${o.gate}\n`;
  if (o.releaseGate) files["release-gate.conf"] = `${o.releaseGate}\n`;
  const commit = fx.commitIn(co, files, `Release v${version}`);
  await chatDoes(k, rec, [step("bump", "done", "package.json and CHANGELOG.md"), step("commit", "done", `Release v${version}`, { facts: { commit, branch: String(rec.thread?.branch ?? `release/${rec.id}`) } })]);
  return commit;
}

/** Report held prepare steps (try-live) as held, then Continue each as the operator. */
export async function holdAndContinue(k: ReleaseServer, fx: ReleaseFixture, rec: Rec, id = "try-live"): Promise<void> {
  await chatDoes(k, rec, [step(id, "held", "running on the live copy; try it")]);
  await waitRecord(k, fx, `${id} held`, (r) => stepOf(r, id).state === "held");
  ok(await k.verb("release.continue", { project: fx.project, release: rec.id, step: id }), "release.continue");
  await waitRecord(k, fx, `${id} done`, (r) => stepOf(r, id).state === "done");
}

export const isReady = (r: Rec) => r.state === "ready";

// ------------------------------------------------------------------ the merge queue, read as the operator

export type Entry = Record<string, any> & { id: string; state: string; branch: string };
export async function mergeView(k: ReleaseServer, fx: ReleaseFixture): Promise<Record<string, any>> {
  return ok(await k.verb("merge.status", { project: fx.project }), "merge.status").json.merge.view;
}
export const entriesOf = (v: Record<string, any>): Entry[] => [
  ...(v.checking ?? []),
  ...(v.waiting ?? []),
  ...(v.needsYou ?? []),
  ...(v.needsFix ?? []),
  ...(v.recent ?? []).map((r: { entry: Entry }) => r.entry),
];
export async function mergeAdd(k: ReleaseServer, fx: ReleaseFixture, branch: string, extra: Record<string, unknown> = {}): Promise<Entry> {
  return ok(await k.verb("merge.add", { project: fx.project, branch, ...extra }), `merge.add ${branch}`).json.merge.entry as Entry;
}
export async function waitEntry(k: ReleaseServer, fx: ReleaseFixture, what: string, pred: (e: Entry) => boolean, ms = 180_000): Promise<Entry> {
  let last: Entry[] = [];
  try {
    return await until(what, async () => {
      last = entriesOf(await mergeView(k, fx));
      return last.find(pred) ?? null;
    }, ms, 200);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nentries: ${JSON.stringify(last.map((x) => ({ id: x.id, branch: x.branch, state: x.state, reason: x.reason, release: x.release })))}`);
  }
}

/** A whole release to published, as the operator would drive it: start, prepare, checks, every held check step
 *  Continued, Publish. Resolves with the published record and the commit the numbered tag names. */
export async function publishOne(k: ReleaseServer, fx: ReleaseFixture, version: string): Promise<{ rec: Rec; sha: string }> {
  const rec = await start(k, fx);
  await prepare(k, fx, rec, version);
  let r = await waitRecord(k, fx, "checks passed", (x) => stepOf(x, "checks").state === "done", 240_000);
  for (const s of r.steps.filter((x) => x.phase === "check" && x.held)) await holdAndContinue(k, fx, r, s.id);
  for (const s of r.steps.filter((x) => x.phase === "check" && !x.held)) await chatDoes(k, r, [step(s.id, "done", `${s.label} done`)]);
  r = await waitRecord(k, fx, "ready", isReady, 120_000);
  ok(await k.verb("release.publish", { project: fx.project, release: rec.id, confirm: true }), "release.publish");
  r = await waitRecord(k, fx, "published", (x) => x.state === "published", 120_000, rec.id);
  const sha = fx.tagAt(`v${version}`);
  if (!sha) throw new Error(`v${version} not tagged after Publish`);
  return { rec: r, sha };
}
