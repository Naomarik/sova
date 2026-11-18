// The playbook card's routes: open a card, read it, edit it
// (each edit auto-saved against the revision the page shows), Save as My Defaults, close a draft, and Start,
// which only the person's own click on Sova's page passes.
import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import { CYCLE_MAX, membersOf, parseModelsValue, type PlaybookSpec } from "../../shared/playbook-format";
import { THINKING_LEVELS } from "../../shared/profiles";
import { isPlaybookRunId, mergeEdits, type PlaybookCardEdits, type PlaybookRoleEdit } from "../../shared/playbook-run";
import { chatHandle } from "../chat-handle";
import { notPage, yourClickRefusal } from "../page-only";
import { resolveSessionPath } from "../paths";
import { idOf } from "../sessions-index";
import { statingOwnNumber } from "../wire-gate";
import { answersKey, firstValues, readAnswers, saveAnswers } from "./answers";
import { loadPlaybook, refOf } from "./env";
import type { ContentsSection } from "./message";
import { effectiveEdits } from "./plan";
import { projectKeyOf, realHost, RunRefused, startRun } from "./start";
import { changeRun, createRun, draftsOf, oneRunRefusal, openDraftOf, runById, runHolding, runsOfChat } from "./store";
import { runView } from "./view";
import { abandonAlignment, beginAlignment, settleChat, type AlignFirstHost } from "./align-first";
import { onAgentSettled } from "../chat-handle";

const SOURCES = ["sova", "user", "project"] as const;
const MAX_TEXT = 20_000;
const MAX_NOTE = 4_000;

const body = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A chat by its session path (`?path=` or a body's `path`), when it is one. */
function chatOf(raw: unknown): { id: string; path: string } | null {
  const path = resolveSessionPath(typeof raw === "string" ? raw : undefined);
  if (!path || !existsSync(path)) return null;
  return { id: idOf(path), path };
}

/** The card's edits, checked against the playbook: unknown ids and wrong shapes are refused with why. */
export function cleanEdits(spec: PlaybookSpec, sent: unknown): PlaybookCardEdits | string {
  if (!isRecord(sent)) return "edits must be an object { choices?, roles?, teams?, stops?, cycle? }.";
  for (const k of Object.keys(sent)) if (!["choices", "roles", "teams", "stops", "cycle"].includes(k)) return `edits has no "${k}".`;
  const out: PlaybookCardEdits = {};
  if (sent.choices !== undefined) {
    if (!isRecord(sent.choices)) return "edits.choices must be an object of choice id → value.";
    out.choices = {};
    for (const [id, v] of Object.entries(sent.choices)) {
      const input = spec.inputs.find((i) => i.id === id);
      if (!input) return `This playbook has no choice "${id}".`;
      if (v === null) {
        out.choices[id] = null;
        continue;
      }
      if (input.type === "models") {
        const m = parseModelsValue(v);
        if (!Array.isArray(m)) return `${input.label}: ${m.error}`;
        out.choices[id] = m;
        continue;
      }
      // The value's own check runs on the card (Start stays off with why), so a half-typed value still saves.
      if (input.type === "number" ? typeof v !== "number" : input.type === "toggle" ? typeof v !== "boolean" : input.type === "multi" || input.type === "list" ? !(Array.isArray(v) && v.every((x) => typeof x === "string")) : typeof v !== "string") return `${input.label}: that isn't a ${input.type} value.`;
      if (typeof v === "string" && v.length > MAX_TEXT) return `${input.label} is too long.`;
      out.choices[id] = v;
    }
  }
  if (sent.roles !== undefined) {
    if (!isRecord(sent.roles)) return "edits.roles must be an object of member id → { pick?, on?, note? }.";
    out.roles = {};
    for (const [id, e] of Object.entries(sent.roles)) {
      const role = membersOf(spec).find((r) => r.id === id);
      if (!role) return `This playbook has no member "${id}".`;
      if (!isRecord(e)) return `edits.roles.${id} must be an object.`;
      const next: PlaybookRoleEdit = {};
      for (const k of Object.keys(e)) if (!["pick", "on", "note"].includes(k)) return `edits.roles.${id} has no "${k}".`;
      const pick = e.pick;
      if (pick === null) next.pick = null;
      else if (pick !== undefined) {
        if (!isRecord(pick) || typeof pick.model !== "string" || !/^[^/\s]+\/\S+$/.test(pick.model) || pick.model.length > 200 || (pick.effort !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(pick.effort))) return `${role.label}'s model must be { model: "provider/id", effort?: ${THINKING_LEVELS.join(" | ")} }.`;
        const model = pick.model;
        if (role.only && !role.models.some((m) => m.ref === model)) return `${role.label} runs only on the models its playbook lists.`;
        next.pick = { model, ...(typeof pick.effort === "string" && pick.effort ? { effort: pick.effort } : {}) };
      }
      if (e.on !== undefined) {
        if (typeof e.on !== "boolean") return `edits.roles.${id}.on must be true or false.`;
        if (!e.on && !role.optional) return `${role.label} can't be turned off.`;
        next.on = e.on;
      }
      if (e.note !== undefined) {
        if (typeof e.note !== "string" || e.note.length > MAX_NOTE || /[\r\n]/.test(e.note)) return `${role.label}'s note must be one line of text, at most ${MAX_NOTE} characters.`;
        next.note = e.note;
      }
      out.roles[id] = next;
    }
  }
  if (sent.teams !== undefined) {
    if (!isRecord(sent.teams)) return "edits.teams must be an object of team id → { note? }.";
    out.teams = {};
    for (const [id, e] of Object.entries(sent.teams)) {
      const team = spec.teams.find((t) => t.id === id);
      if (!team) return `This playbook has no team "${id}".`;
      if (!isRecord(e)) return `edits.teams.${id} must be an object.`;
      for (const k of Object.keys(e)) if (k !== "note") return `edits.teams.${id} has no "${k}".`;
      if (e.note !== undefined) {
        if (typeof e.note !== "string" || e.note.length > MAX_NOTE || /[\r\n]/.test(e.note)) return `The note for ${team.label} must be one line of text, at most ${MAX_NOTE} characters.`;
        out.teams[id] = { note: e.note };
      } else out.teams[id] = {};
    }
  }
  if (sent.stops !== undefined) {
    if (!isRecord(sent.stops)) return "edits.stops must be an object of step id → true or false.";
    out.stops = {};
    const steps = spec.steps.flatMap((s) => (s.kind === "cycle" ? s.steps : [s]));
    for (const [id, on] of Object.entries(sent.stops)) {
      const step = steps.find((s) => s.id === id);
      if (!step) return `This playbook has no step "${id}".`;
      if (step.stop !== "optional") return `${step.label}'s stop can't be turned on or off.`;
      if (typeof on !== "boolean") return `edits.stops.${id} must be true or false.`;
      out.stops[id] = on;
    }
  }
  if (sent.cycle !== undefined) {
    if (!isRecord(sent.cycle)) return "edits.cycle must be { max?, askEvery?, until? }.";
    if (!spec.steps.some((s) => s.kind === "cycle")) return "This playbook has no cycle.";
    for (const k of Object.keys(sent.cycle)) if (k !== "max" && k !== "askEvery" && k !== "until") return `edits.cycle has no "${k}".`;
    const { max, askEvery, until } = sent.cycle;
    if (until !== undefined && until !== "rule" && until !== "max") return "The cycle's until must be rule or max.";
    if (max !== undefined && !(Number.isInteger(max) && (max as number) >= 1 && (max as number) <= CYCLE_MAX)) return `The cycle's max must be a whole number from 1 to ${CYCLE_MAX}.`;
    if (askEvery !== undefined && !(Number.isInteger(askEvery) && (askEvery as number) >= 1)) return "The cycle's ask-every must be a whole number of at least 1.";
    out.cycle = { ...(max !== undefined ? { max: max as number } : {}), ...(askEvery !== undefined ? { askEvery: askEvery as number } : {}), ...(until !== undefined ? { until: until as "rule" | "max" } : {}) };
  }
  return out;
}

const fail = (c: Context, err: unknown) => {
  if (err instanceof RunRefused) return c.json({ error: err.message, ...err.extra }, err.status);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
};

export interface PlaybookRunRouteDeps {
  contents: () => ContentsSection[];
  /** Tests only: a stand-in for the chat an alignment-first playbook asks (align-first.ts). */
  alignHost?: AlignFirstHost;
}

export function mountPlaybookRunRoutes(app: Hono, deps: PlaybookRunRouteDeps): void {
  const request = statingOwnNumber(app);
  const alignHost: AlignFirstHost = deps.alignHost ?? realHost;
  // A card waiting on an alignment is looked at whenever its chat's turn settles: decided, it's drawn.
  if (!deps.alignHost) onAgentSettled((path) => void settleChat(idOf(path), alignHost));

  // Open a card: this chat's open draft of that playbook, or a new draft in place of its draft of another one;
  // a chat a run holds opens none (one playbook per chat).
  app.post("/api/playbook-runs", async (c) => {
    const b = await body(c);
    if (b.cwd !== undefined && typeof b.cwd !== "string") return c.json({ error: "cwd must be an absolute folder." }, 400);
    if (b.path !== undefined && typeof b.path !== "string") return c.json({ error: "path must be a chat's session path." }, 400);
    if (b.text !== undefined && (typeof b.text !== "string" || b.text.length > MAX_TEXT)) return c.json({ error: `text must be text, at most ${MAX_TEXT} characters.` }, 400);
    if (b.after !== undefined && (typeof b.after !== "string" || !b.after || b.after.length > 200)) return c.json({ error: "after must be a transcript item's id." }, 400);
    const p = b.playbook;
    if (!isRecord(p) || !SOURCES.includes(p.source as (typeof SOURCES)[number]) || typeof p.id !== "string" || !p.id) return c.json({ error: "playbook must be { source: sova | user | project, id }." }, 400);
    let shownIn: { id: string; path: string } | undefined;
    if (b.path !== undefined && b.path !== "") {
      const chat = chatOf(b.path);
      if (!chat) return c.json({ error: "Invalid ?path: not a session file under the pi sessions dir." }, 400);
      shownIn = chat;
    }
    const cwd = typeof b.cwd === "string" && b.cwd.trim() ? b.cwd.trim() : shownIn ? (chatHandle(shownIn.path)?.mirror.cwd ?? "") : "";
    if (!cwd.startsWith("/")) return c.json({ error: "cwd must be an absolute folder." }, 400);
    const ref = { source: p.source as string, id: p.id };
    const text = typeof b.text === "string" && b.text.trim() ? b.text.trim() : undefined;
    // A chat runs one playbook at most: one that already runs one opens no other card.
    const holding = shownIn ? runHolding(shownIn.id) : undefined;
    if (holding) return c.json({ error: oneRunRefusal(holding), holding: holding.id }, 409);
    const open = shownIn ? openDraftOf(shownIn.id, ref) : undefined;
    if (open) {
      // Opened again, it comes to where the person is now, as an alignment card shows at its newest; one still
      // waiting on its alignment isn't drawn yet, so it has no place to move.
      changeRun(open.id, (r) => {
        if (text !== undefined && text !== r.text) {
          r.text = text;
          r.revision++;
        }
        if (!r.aligning) r.anchor = { ...(typeof b.after === "string" ? { after: b.after } : {}), at: new Date().toISOString() };
      });
      return c.json(await runView(runById(open.id)!));
    }
    const t0 = Date.now();
    const loaded = await loadPlaybook(ref, cwd);
    if (!loaded) return c.json({ error: `No playbook ${ref.id} here.` }, 404);
    if (!loaded.spec) return c.json({ error: loaded.error ? `The playbook's description can't be read: ${loaded.error}` : "This playbook has no description, so it has no card: send it from the Playbooks dialog." }, 400);
    const tLoad = Date.now();
    const first = firstValues(loaded.spec, readAnswers(answersKey(ref, await projectKeyOf(cwd))));
    // The chat's card of another playbook, not started, gives way to this one.
    for (const old of shownIn ? draftsOf(shownIn.id) : [])
      changeRun(old.id, (x) => {
        x.closed = true;
      });
    const anchor = { ...(typeof b.after === "string" ? { after: b.after } : {}), at: new Date().toISOString() };
    // A playbook that requires an alignment first, in a chat: the card waits on it, undrawn.
    const aligning = loaded.spec.align && shownIn ? { since: anchor.at } : undefined;
    const run = createRun({ playbook: refOf(loaded.info), cwd, anchor, ...(aligning ? { aligning } : {}), ...(shownIn ? { shownIn } : {}), ...(text ? { text } : {}), initial: first });
    // The person's /name asks the chat to open it; a chat that opened the card itself is told by its card note.
    // A chat that can't be asked gets the card at once, those choices left to work out with it.
    if (aligning && !notPage(c)) {
      const why = await beginAlignment(run, loaded.spec, alignHost).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      if (why) {
        console.warn(`[playbook-runs] ${run.id}: its alignment couldn't be asked for: ${why}`);
        abandonAlignment(runById(run.id)!);
      }
    }
    const tMade = Date.now();
    const view = await runView(runById(run.id)!);
    const took = Date.now() - t0;
    if (took > 1000) console.warn(`[playbook-runs] opening a card took ${took} ms (playbook ${tLoad - t0} ms, answers ${tMade - tLoad} ms, card ${Date.now() - tMade} ms)`);
    return c.json(view, 201);
  });

  app.get("/api/playbook-runs", async (c) => {
    const chat = chatOf(c.req.query("path"));
    if (!chat) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
    const runs = await Promise.all(runsOfChat(chat.id).map((r) => runView(r)));
    // The run that holds this chat, its card put away or not: the chat opens no other playbook.
    const held = runHolding(chat.id);
    const holding = held ? { id: held.id, title: held.playbook.title } : null;
    return c.json({ runs, holding }, 200, { "Cache-Control": "no-store" });
  });

  app.get("/api/playbook-runs/:run", async (c) => {
    const r = runById(c.req.param("run"));
    // A closed draft is gone; a started run put away still answers, as its record.
    if (!r || (r.closed && r.state === "draft")) return c.json({ error: "No such playbook run." }, 404);
    const view = await runView(r);
    return c.json(r.closed ? { ...view, closed: true } : view, 200, { "Cache-Control": "no-store" });
  });

  app.patch("/api/playbook-runs/:run", async (c) => {
    const b = await body(c);
    if (!Number.isInteger(b.revision)) return c.json({ error: "revision must be the card's revision, a whole number." }, 400);
    if (!isRecord(b.edits)) return c.json({ error: "edits must be an object { choices?, roles?, teams?, stops?, cycle? }." }, 400);
    const r = runById(c.req.param("run"));
    if (!r || r.closed) return c.json({ error: "No such playbook run." }, 404);
    if (r.state !== "draft") return c.json({ error: "This run has started, so its card is closed.", run: await runView(r) }, 409);
    if (b.revision !== r.revision) return c.json({ error: "The card changed since you saw it.", run: await runView(r) }, 409);
    const loaded = await loadPlaybook(r.playbook, r.cwd);
    if (!loaded?.spec) return c.json({ error: loaded?.error ? `The playbook's description can't be read: ${loaded.error}` : "The playbook is gone." }, 409);
    const edits = cleanEdits(loaded.spec, b.edits);
    if (typeof edits === "string") return c.json({ error: edits }, 400);
    // A choice worked out with the chat is the chat's to fill: the card shows it read-only.
    if (!notPage(c) && edits.choices) {
      const chatOnes = Object.keys(edits.choices).map((id) => loaded.spec!.inputs.find((i) => i.id === id)!).filter((i) => i.ask === "chat");
      if (chatOnes.length) return c.json({ error: `${chatOnes[0]!.label} is worked out with the chat: ask it there. Nothing was changed.` }, 400);
    }
    // A chat or a script fills in the playbook's own choices; models, roles, stops and cycles are the person's.
    // The chat filling a choice brings the card down to where it did, under its last words.
    const moves = notPage(c) && !!edits.choices && !r.aligning;
    if (notPage(c) && (edits.roles || edits.teams || edits.stops || edits.cycle)) return c.json({ error: "Only the person changes a card's models, members, notes, stops and cycle settings, on the card in Sova's page. A chat may fill in its choices. Nothing was changed." }, 403);
    changeRun(r.id, (x) => {
      x.edits = mergeEdits(x.edits, edits);
      x.revision++;
      // Who set each choice last: a chat's value reads From the chat, the person's own says nothing.
      const set = new Set(x.chatSet ?? []);
      for (const id of Object.keys(edits.choices ?? {})) notPage(c) ? set.add(id) : set.delete(id);
      if (set.size) x.chatSet = [...set];
      else delete x.chatSet;
      if (moves) x.anchor = { at: new Date().toISOString() };
      delete x.startError;
    });
    return c.json(await runView(runById(r.id)!));
  });

  app.post("/api/playbook-runs/:run/start", async (c) => {
    const refused = yourClickRefusal(c, "playbookStart");
    if (refused) return refused;
    const b = await body(c);
    if (!Number.isInteger(b.revision)) return c.json({ error: "revision must be the card's revision, a whole number." }, 400);
    const id = c.req.param("run");
    if (!isPlaybookRunId(id)) return c.json({ error: "No such playbook run." }, 404);
    try {
      return c.json(await startRun(id, b.revision as number, { request, contents: deps.contents }));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/api/playbook-runs/:run/defaults", async (c) => {
    const refused = yourClickRefusal(c, "playbookDefaults");
    if (refused) return refused;
    const b = await body(c);
    if (!Number.isInteger(b.revision)) return c.json({ error: "revision must be the card's revision, a whole number." }, 400);
    const r = runById(c.req.param("run"));
    if (!r || r.closed) return c.json({ error: "No such playbook run." }, 404);
    if (b.revision !== r.revision) return c.json({ error: "The card changed since you saw it.", run: await runView(r) }, 409);
    const e = r.plan ? null : effectiveEdits(r);
    if (!e) return c.json({ error: "Save as My Defaults works on a card before Start." }, 409);
    saveAnswers(answersKey(r.playbook, await projectKeyOf(r.cwd)), "defaults", { choices: e.choices ?? {}, ...(e.roles ? { roles: e.roles } : {}), ...(e.stops ? { stops: e.stops } : {}), ...(e.cycle ? { cycle: e.cycle } : {}) });
    return c.json({ ok: true });
  });

  app.delete("/api/playbook-runs/:run", (c) => {
    // The person's card: a chat or a script reads and fills it in, never closes it.
    if (notPage(c)) return c.json({ error: "Only the person closes a playbook card, on the card in Sova's page. Nothing was closed." }, 403);
    const r = runById(c.req.param("run"));
    if (!r || r.closed) return c.json({ error: "No such playbook run." }, 404);
    // A draft closed is gone; a started run put away leaves the chat's cards but keeps its record (GET above).
    if (r.state === "starting") return c.json({ error: "This run is starting; close its card once it has started." }, 409);
    changeRun(r.id, (x) => {
      x.closed = true;
    });
    return c.json({ ok: true });
  });
}
