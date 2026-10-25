// The simulation's hooks into the contracts of .chat-powers-brief/ARCH.md (§4.4 per-conversation
// drafts, §4.5 Project Assistant, §3 powers PATCH). Each hook answers {pending: why} while its piece
// hasn't landed (a 404 route, a missing file): the run reports PENDING, never a pass.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { readJsonl } from "./lib/checks.mjs";
import { sleep } from "./lib/api.mjs";

const pending = (why) => ({ pending: why });
const notLanded = (err) => err?.status === 404 || err?.status === 405;

/** ARCH §4.4: draft name `conv-<sessionId>` (lowercased, [a-z0-9-], first 20 chars per question 1;
    question 3 says `conv-<sessionId>`): both forms are looked for. */
export function draftNames(sessionId) {
  const clean = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return [...new Set([`conv-${clean.slice(0, 20)}`, `conv-${clean}`])];
}

/** The gathering conversation's draft: {dir, name, record, state}. dir = <root>/.sova/spec/drafts/<name>/spec;
    record = <workspace>/projects/<pid>/conversation-drafts/<sessionId>.json (ConversationDraftRecord). */
export async function conversationDraft(ctx) {
  const sid = ctx.gathering.sessionId;
  const recPath = join(ctx.workspaceDir, "projects", ctx.projectId, "conversation-drafts", `${sid}.json`);
  const record = existsSync(recPath) ? JSON.parse(readFileSync(recPath, "utf8")) : null;
  const names = record?.draft ? [record.draft] : draftNames(sid);
  const name = names.find((n) => existsSync(join(ctx.projectRoot, ".sova/spec/drafts", n, "spec", "manifest.json")));
  if (!name && !record) return pending(`no conversation draft: neither ${recPath} nor <root>/.sova/spec/drafts/{${draftNames(sid).join(",")}}/spec`);
  return { dir: name ? join(ctx.projectRoot, ".sova/spec/drafts", name, "spec") : null, name: name ?? record?.draft, record, recordPath: recPath, state: record?.state };
}

/** ARCH §4.4: GET /api/draft-specs?project=<pid> → {drafts: DraftSpecSummary[]}. */
export async function draftSpecs(ctx) {
  try {
    return await ctx.api.get(`/api/draft-specs?project=${ctx.projectId}`);
  } catch (err) {
    if (notLanded(err)) return pending("GET /api/draft-specs not landed");
    throw err;
  }
}

/** ARCH §4.4: POST /api/projects/:pid/draft-specs/:sid/build → 202 {sessionId, title}; answers {id, path}. */
export async function startCodingFromDraft(ctx) {
  let r;
  try {
    r = await ctx.api.post(`/api/projects/${ctx.projectId}/draft-specs/${ctx.gathering.sessionId}/build`, {});
  } catch (err) {
    if (notLanded(err)) return pending("POST /api/projects/:pid/draft-specs/:sid/build not landed");
    throw err;
  }
  const id = r?.sessionId ?? r?.id;
  if (!id) return { error: `build answered no sessionId: ${JSON.stringify(r).slice(0, 300)}` };
  let path = r?.path ?? null;
  for (let i = 0; !path && i < 30; i++) {
    path = (await ctx.api.get(`/api/sessions/by-id/${id}`).catch(() => null))?.path ?? null;
    if (!path) await sleep(1000);
  }
  return path ? { id, path, raw: r } : { error: `session ${id} from build has no path after 30 s` };
}

/** ARCH §3: PATCH /api/projects/:pid/overseer {powers: {assistant: {codingStart}}}, plus holdMin. */
export async function setAssistantPower(ctx, key, on, extra = {}) {
  try {
    const r = await ctx.api.patch(`/api/projects/${ctx.projectId}/overseer`, { powers: { assistant: { [key]: on } }, ...extra });
    const got = r?.settings?.powers?.assistant?.[key] ?? r?.powers?.assistant?.[key];
    if (got === undefined) return pending(`the overseer PATCH answered no settings.powers.assistant.${key} (powers not landed)`);
    if (got !== on) return { error: `asked ${key}=${on}, the PATCH answered ${got}` };
    return { ok: true, effective: r?.settings?.powers?.effective?.assistant?.[key] ?? r?.powers?.effective?.assistant?.[key], brake: r?.settings?.powers?.brake ?? r?.powers?.brake ?? null };
  } catch (err) {
    if (err?.status === 400 && /powers/i.test(String(err.body?.error ?? ""))) return pending(`powers PATCH refused: ${err.body.error}`);
    throw err;
  }
}

/** The owner's token (GET /api/orgs/:id/owner/link?keep=1), cached on ctx. */
async function ownerToken(ctx) {
  if (!ctx.ownerToken) ctx.ownerToken = String((await ctx.api.get(`/api/orgs/${ctx.orgId}/owner/link?keep=1`)).link).replace(/[?#].*$/, "").split("/").filter(Boolean).at(-1);
  return ctx.ownerToken;
}

/** The Project Assistant's models (PUT /api/orgs/:id/owner/assistant), so its replies and the fixes it
    starts run on the given model. */
export async function setAssistantModels(ctx, model) {
  try {
    await ctx.api.put(`/api/orgs/${ctx.orgId}/owner/assistant`, { models: { reply: { model }, coding: { model }, gathering: { model } } });
    return { ok: true };
  } catch (err) {
    if (!notLanded(err)) throw err;
    // Until the route is wired (project-assistant's interim instruction): the org store file itself.
    const file = join(ctx.workspaceDir, "project-assistant.json");
    const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, conversations: {} };
    writeFileSync(file, JSON.stringify({ ...cur, version: 1, models: { reply: { model }, coding: { model }, gathering: { model } } }, null, 2));
    return { ok: true, via: "file" };
  }
}

/** The owner writes to the Project Assistant behind the owner link (POST /api/i/T/assistant {text}),
    then polls GET /api/i/T/assistant until busy:false with an assistant message after it. Answers {reply, view}. */
export async function ownerSays(ctx, text, { timeoutMs = 600_000 } = {}) {
  const T = await ownerToken(ctx);
  const base = ctx.share.base;
  const get = async () => {
    const r = await fetch(`${base}/api/i/${T}/assistant`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const first = await get();
  if (first.status === 404 && !first.body?.messages) return pending("GET /api/i/<token>/assistant not landed");
  const before = first.body?.messages?.length ?? 0;
  const t = Date.now();
  let sent;
  for (;;) {
    const r = await fetch(`${base}/api/i/${T}/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    sent = { status: r.status, body: await r.json().catch(() => null) };
    if (sent.status === 409 && sent.body?.code === "busy" && Date.now() - t < 120_000) { await sleep(3000); continue; }
    break;
  }
  if (sent.status === 404) return pending("POST /api/i/<token>/assistant not landed");
  if (sent.status !== 202) return { error: `owner message refused ${sent.status}: ${JSON.stringify(sent.body)}` };
  while (Date.now() - t < timeoutMs) {
    await sleep(3000);
    const v = (await get()).body;
    const msgs = v?.messages ?? [];
    const after = msgs.slice(before);
    if (v && !v.busy && after.some((m) => m.role === "owner") && after.at(-1)?.role === "assistant") return { reply: after.filter((m) => m.role === "assistant").map((m) => m.text).join("\n"), view: v };
  }
  return { error: `no assistant reply in ${timeoutMs / 1000} s` };
}

/** The owner page's home (GET /api/i/T): requests and versions. */
export async function ownerHome(ctx) {
  const T = await ownerToken(ctx);
  const r = await fetch(`${ctx.share.base}/api/i/${T}`);
  return r.json().catch(() => null);
}

/** Attention items (Needs you) of the given kinds that appeared after `since` (ms). */
export async function attentionOf(ctx, kinds, since = 0) {
  const d = await ctx.api.get("/api/overseer/attention");
  return (d.items ?? []).filter((i) => kinds.includes(i.kind) && (i.since ?? 0) >= since - 5000);
}

/** The coding sessions the project started (GET …/overseer `coding` list, newest first). */
export async function projectCodingSessions(ctx) {
  const info = await ctx.api.get(`/api/projects/${ctx.projectId}/overseer`);
  return info.coding ?? info.codingSessions ?? [];
}

/** One message on a session's WS chat, as the operator's composer sends it (the project overseer's own
    conversation takes only this), or {type: "abort"}. Errors the server sends back are returned. */
export async function wsChat(ctx, path, msg) {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/chat?path=${encodeURIComponent(path)}&tail=rest`, { headers: { "x-sova-token": ctx.token } });
  const errors = [];
  ws.on("message", (d) => {
    try {
      const m = JSON.parse(String(d));
      if (m.type === "error") errors.push(m.message ?? m.code);
    } catch {}
  });
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  await sleep(1000);
  ws.send(JSON.stringify(msg));
  await sleep(2500);
  ws.close();
  return errors;
}

/** Stop a running session's turn. */
export const abortSession = (ctx, path) => wsChat(ctx, path, { type: "abort" });

/** The first user message of a session file, as text. */
export function firstUserText(path) {
  for (const e of readJsonl(path)) {
    const m = e.type === "message" ? e.message : null;
    if (m?.role === "user") return (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return "";
}
