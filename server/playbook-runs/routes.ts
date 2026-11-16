// The playbook card's routes: open a card, read it, edit it
// (each edit auto-saved against the revision the page shows), Save as My Defaults, close a draft, and Start,
// which only the person's own click on Sova's page passes.
import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import { MAIN_ROLE, parseModelsValue, type PlaybookSpec } from "../../shared/playbook-format";
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
import { projectKeyOf, RunRefused, startRun } from "./start";
import { changeRun, createRun, openDraftOf, runById, runsOfChat } from "./store";
import { runView } from "./view";

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
  if (!isRecord(sent)) return "edits must be an object { choices?, roles?, stops?, cycle? }.";
  for (const k of Object.keys(sent)) if (!["choices", "roles", "stops", "cycle"].includes(k)) return `edits has no "${k}".`;
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
    if (!isRecord(sent.roles)) return "edits.roles must be an object of role id → { pick?, on?, note? }.";
    out.roles = {};
    for (const [id, e] of Object.entries(sent.roles)) {
      const role = spec.roles.find((r) => r.id === id);
      if (!role) return `This playbook has no role "${id}".`;
      if (!isRecord(e)) return `edits.roles.${id} must be an object.`;
      const next: PlaybookRoleEdit = {};
      for (const k of Object.keys(e)) if (!["pick", "on", "note"].includes(k)) return `edits.roles.${id} has no "${k}".`;
      const pick = e.pick;
      if (pick === null) next.pick = null;
      else if (pick !== undefined) {
        if (!isRecord(pick) || typeof pick.model !== "string" || !/^[^/\s]+\/\S+$/.test(pick.model) || pick.model.length > 200 || (pick.effort !== undefined && typeof pick.effort !== "string")) return `${role.label}'s model must be { model: "provider/id", effort? }.`;
        const model = pick.model;
        if (role.only && !role.models.some((m) => m.ref === model)) return `${role.label} runs only on the models its playbook lists.`;
        next.pick = { model, ...(typeof pick.effort === "string" && pick.effort ? { effort: pick.effort } : {}) };
      }
      if (e.on !== undefined) {
        if (typeof e.on !== "boolean") return `edits.roles.${id}.on must be true or false.`;
        if (!e.on && (id === MAIN_ROLE || !role.optional)) return `${role.label} can't be turned off.`;
        next.on = e.on;
      }
      if (e.note !== undefined) {
        if (typeof e.note !== "string" || e.note.length > MAX_NOTE) return `${role.label}'s note must be text, at most ${MAX_NOTE} characters.`;
        next.note = e.note;
      }
      out.roles[id] = next;
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
    if (max !== undefined && !(Number.isInteger(max) && (max as number) >= 1)) return "The cycle's max must be a whole number of at least 1.";
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
}

export function mountPlaybookRunRoutes(app: Hono, deps: PlaybookRunRouteDeps): void {
  const request = statingOwnNumber(app);

  // Open a card: a new draft, or this chat's open draft of that playbook.
  app.post("/api/playbook-runs", async (c) => {
    const b = await body(c);
    if (b.cwd !== undefined && typeof b.cwd !== "string") return c.json({ error: "cwd must be an absolute folder." }, 400);
    if (b.path !== undefined && typeof b.path !== "string") return c.json({ error: "path must be a chat's session path." }, 400);
    if (b.text !== undefined && (typeof b.text !== "string" || b.text.length > MAX_TEXT)) return c.json({ error: `text must be text, at most ${MAX_TEXT} characters.` }, 400);
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
    const open = shownIn ? openDraftOf(shownIn.id, ref) : undefined;
    if (open) {
      if (text !== undefined && text !== open.text)
        changeRun(open.id, (r) => {
          r.text = text;
          r.revision++;
        });
      return c.json(await runView(runById(open.id)!));
    }
    const loaded = await loadPlaybook(ref, cwd);
    if (!loaded) return c.json({ error: `No playbook ${ref.id} here.` }, 404);
    if (!loaded.spec) return c.json({ error: loaded.error ? `The playbook's description can't be read: ${loaded.error}` : "This playbook has no description, so it has no card: send it from the Playbooks dialog." }, 400);
    const first = firstValues(loaded.spec, readAnswers(answersKey(ref, await projectKeyOf(cwd))));
    const run = createRun({ playbook: refOf(loaded.info), cwd, ...(shownIn ? { shownIn } : {}), ...(text ? { text } : {}), initial: first });
    return c.json(await runView(run), 201);
  });

  app.get("/api/playbook-runs", async (c) => {
    const chat = chatOf(c.req.query("path"));
    if (!chat) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
    const runs = await Promise.all(runsOfChat(chat.id).map((r) => runView(r)));
    return c.json({ runs }, 200, { "Cache-Control": "no-store" });
  });

  app.get("/api/playbook-runs/:run", async (c) => {
    const r = runById(c.req.param("run"));
    if (!r || r.closed) return c.json({ error: "No such playbook run." }, 404);
    return c.json(await runView(r), 200, { "Cache-Control": "no-store" });
  });

  app.patch("/api/playbook-runs/:run", async (c) => {
    const b = await body(c);
    if (!Number.isInteger(b.revision)) return c.json({ error: "revision must be the card's revision, a whole number." }, 400);
    if (!isRecord(b.edits)) return c.json({ error: "edits must be an object { choices?, roles?, stops?, cycle? }." }, 400);
    const r = runById(c.req.param("run"));
    if (!r || r.closed) return c.json({ error: "No such playbook run." }, 404);
    if (r.state !== "draft") return c.json({ error: "This run has started, so its card is closed.", run: await runView(r) }, 409);
    if (b.revision !== r.revision) return c.json({ error: "The card changed since you saw it.", run: await runView(r) }, 409);
    const loaded = await loadPlaybook(r.playbook, r.cwd);
    if (!loaded?.spec) return c.json({ error: loaded?.error ? `The playbook's description can't be read: ${loaded.error}` : "The playbook is gone." }, 409);
    const edits = cleanEdits(loaded.spec, b.edits);
    if (typeof edits === "string") return c.json({ error: edits }, 400);
    // A chat or a script fills in the playbook's own choices; models, roles, stops and cycles are the person's.
    if (notPage(c) && (edits.roles || edits.stops || edits.cycle)) return c.json({ error: "Only the person changes a card's models, roles, stops and cycle settings, on the card in Sova's page. A chat may fill in its choices. Nothing was changed." }, 403);
    changeRun(r.id, (x) => {
      x.edits = mergeEdits(x.edits, edits);
      x.revision++;
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
    const r = runById(c.req.param("run"));
    if (!r || r.closed) return c.json({ error: "No such playbook run." }, 404);
    if (r.state !== "draft") return c.json({ error: "A started run's card stays as its record." }, 409);
    changeRun(r.id, (x) => {
      x.closed = true;
    });
    return c.json({ ok: true });
  });
}
