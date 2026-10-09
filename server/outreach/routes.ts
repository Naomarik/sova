import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { OPERATOR } from "../../shared/baton";
import { ENTRY_ID, waDigits, type BatonOutreach, type OrgSenderView, type OutreachInfo, type OutreachPatch, type SenderList } from "../../shared/outreach";
import { attentionChanged } from "../attention-memo";
import { meshPeers } from "../mesh";
import { localRequest } from "../mesh/proxy";
import { operatorBy } from "../org-routes";
import { batonById, currentOffer, reachedBy } from "../baton";
import { operatorEnvelope, operatorName, OrgError, readIndex, readRoster } from "../orgs";
import { secretRules } from "../overseer-deny";
import { OVERSEER_SENDER_HEADER } from "../overseer-sender";
import { notReady, orgSenderChanged, refreshSender, sendAct, sendHandoffLink, watchSenders } from "./core";
import { cancelLink, dropLink, linkView, startLink } from "./link";
import { parseLinkRef } from "./links";
import { outreachSecretDirs, outreachSecretFiles, sandboxWarning } from "./protected-paths";
import { listSenders } from "./senders";
import { readOutreach, readOutreachState, saveOutreach } from "./settings";
import { defaultTarget, orgTarget, targetOf, type SenderTarget } from "./targets";
import { senderUnit, startSenderUnit } from "./unit";
import { localClient, localControl, reportedAuthDirOf, resetLocalClient, viaReconnect, whatsapp, type ControlAnswer } from "./whatsapp";

/**
 * The operator's outreach routes (§app.outreach/sender-route, /send-link, /sender-controls,
 * /sender-link, /sender-list), main listener only: a request that carries a peer or came through the
 * mesh proxy gets 404, like Public links'. The sender's controls, its link and the list of senders
 * also refuse the Overseer's own calls (its dispatch is in-process, so it passes the local check): no
 * tool reaches them.
 */

const local = localRequest;
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };

/** An added number's name, for its unit (`sova-whatsapp@<name>.service`). */
const numberName = (t: SenderTarget) => ("number" in t.route ? t.route.number.id : undefined);

/** The page's info about sender `selected` (an entry id; else the default). */
export async function outreachInfo(selected?: string): Promise<OutreachInfo> {
  const { file, problem } = readOutreachState();
  const target = (selected ? targetOf(selected, file, undefined, true) : null) ?? defaultTarget(file);
  const sender = await whatsapp.status(target);
  // Read again: a status call may have recorded the auth directory the sender reported.
  const now = readOutreachState().file;
  const denied = new Set([...secretRules().dirs, ...secretRules().files]);
  const covered = [...outreachSecretDirs(), ...outreachSecretFiles()].filter((p) => denied.has(p));
  const peers = meshPeers().map((p) => ({ nodeId: p.nodeId, label: p.label }));
  // Start Sender: asked of systemd only while a local sender doesn't answer.
  const unit = target?.socket && sender.state === "unreachable" ? await senderUnit(target.socket, numberName(target)).catch(() => null) : null;
  return {
    file: now,
    ...(target ? { selected: target.id } : {}),
    sender,
    protected: covered,
    peers,
    // The selected sender's own auth directory: an added number's is the one it reported, else its home's.
    sandboxWarning: !target ? null : sandboxWarning(target.id === "local" || !target.socket ? (now.senderAuthDir ?? now.authDir) : (reportedAuthDirOf(target.socket) ?? join(dirname(target.socket), "auth"))),
    ...(problem ? { problem } : {}),
    ...(unit ? { unit } : {}),
  };
}

export function mountOutreach(app: Hono): void {
  app.get("/api/outreach", async (c) => (local(c) ? c.json(await outreachInfo(c.req.query("sender")), 200, NO_STORE) : c.json({ error: "Not found" }, 404)));
  app.put("/api/outreach", small, async (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Body must be an object" }, 400);
    const patch: OutreachPatch = {};
    const KEYS = ["sender", "acceptFrom", "paused", "authDir", "numbers", "labels"] as const;
    for (const k of KEYS) if (k in body) (patch as Record<string, unknown>)[k] = (body as Record<string, unknown>)[k];
    for (const k of Object.keys(body)) if (!(KEYS as readonly string[]).includes(k)) return c.json({ error: `Unknown key ${JSON.stringify(k)}` }, 400);
    const r = saveOutreach(patch);
    if ("error" in r) return c.json({ error: r.error }, 400);
    if ("sender" in patch || "numbers" in patch) {
      resetLocalClient();
      dropLink();
    }
    // The senders in use may have changed: read them, and forget the ones no longer used.
    await watchSenders();
    attentionChanged();
    return c.json(await outreachInfo(c.req.query("sender")), 200, NO_STORE);
  });
  // The sender's controls (§app.outreach/sender-controls): the operator's own buttons in Settings → Outreach.
  const operatorOnly = (c: Context): Response | null => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    if (c.req.header(OVERSEER_SENDER_HEADER) !== undefined) return c.json({ error: "Only the operator controls the WhatsApp sender, in Settings → Outreach." }, 403);
    return null;
  };
  /** The body as an object (a control's), or null. */
  const bodyOf = async (c: Context): Promise<Record<string, unknown> | null> => {
    const b = await c.req.json().catch(() => ({}));
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  };
  /** The sender a control names (`sender`, an entry id; else the default), or why not. */
  const pick = (c: Context, id: unknown): SenderTarget | Response => {
    if (id !== undefined && (typeof id !== "string" || !ENTRY_ID.test(id))) return c.json({ error: "sender must be a sender's id (local, local:<name> or peer:<id>)" }, 400);
    const t = typeof id === "string" ? targetOf(id, readOutreach(), undefined, true) : defaultTarget();
    if (!t) return c.json({ error: typeof id === "string" ? "No sender this host can use has that id." : "Outreach is off: there is no sender." }, 409);
    return t;
  };
  const control = (run: (c: Context, body: Record<string, unknown>, t: SenderTarget) => Promise<ControlAnswer | Response>) => async (c: Context) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const b = await bodyOf(c);
    if (!b) return c.json({ error: "Body must be an object" }, 400);
    const t = pick(c, b.sender);
    if (t instanceof Response) return t;
    const r = await run(c, b, t);
    if (r instanceof Response) return r;
    if (!r.ok) return c.json({ error: r.why, ...(r.code ? { code: r.code } : {}) }, 409);
    attentionChanged();
    return c.json(await outreachInfo(t.id), 200, NO_STORE);
  };
  app.post(
    "/api/outreach/sender/reconnect",
    small,
    control(async (_c, _b, t) => ("via" in t.route ? viaReconnect(t.route.via.nodeId) : localControl(t, "reconnect"))),
  );
  app.post(
    "/api/outreach/sender/pause",
    small,
    control(async (c, b, t) => {
      if (typeof b.on !== "boolean") return c.json({ error: "Body must be { on: true | false, sender? }" }, 400);
      if (!t.socket) return c.json({ error: "Only the sender's own host pauses it." }, 409);
      return localControl(t, "pause", { on: b.on });
    }),
  );
  app.post(
    "/api/outreach/sender/start",
    small,
    control(async (c, _b, t) => {
      if (!t.socket) return c.json({ error: "Only the sender's own host starts it." }, 409);
      if ((await whatsapp.status(t)).state !== "unreachable") return c.json({ error: "The sender is already running." }, 409);
      const r = await startSenderUnit(t.socket, numberName(t));
      // A fresh connection: the next read finds the sender as soon as it listens (Settings reads again shortly).
      resetLocalClient();
      return r.ok ? { ok: true, frame: {} } : { ok: false, why: r.why };
    }),
  );
  // Linking a phone (§app.outreach/sender-link): a sender of this host only, never relayed. The answer
  // carries the newest QR or pairing code, so it is never cached.
  const ownSender = (c: Context, t: SenderTarget) => localClient(t) ?? c.json({ error: "Only the sender's own host links or unlinks a phone: do it in Settings → Outreach on that host." }, 409);
  app.post("/api/outreach/sender/link", small, async (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const b = await bodyOf(c);
    if (!b) return c.json({ error: "Body must be { phone?, sender? }" }, 400);
    if (b.phone !== undefined && typeof b.phone !== "string") return c.json({ error: "phone must be a string of digits" }, 400);
    const t = pick(c, b.sender);
    if (t instanceof Response) return t;
    const client = ownSender(c, t);
    if (client instanceof Response) return client;
    const r = await startLink(t.id, client, b.phone as string | undefined);
    if (!r.ok) return c.json({ error: r.why, ...(r.code ? { code: r.code } : {}) }, r.code === "invalid" ? 400 : 409);
    attentionChanged();
    return c.json(r.view, 200, NO_STORE);
  });
  app.get("/api/outreach/sender/link", (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const t = pick(c, c.req.query("sender"));
    return t instanceof Response ? t : c.json(linkView(t.id), 200, NO_STORE);
  });
  app.post("/api/outreach/sender/link/cancel", small, async (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const b = await bodyOf(c);
    if (!b) return c.json({ error: "Body must be { sender? }" }, 400);
    const t = pick(c, b.sender);
    if (t instanceof Response) return t;
    const client = ownSender(c, t);
    if (client instanceof Response) return client;
    const r = await cancelLink(t.id, client);
    if (!r.ok) return c.json({ error: r.why, ...(r.code ? { code: r.code } : {}) }, 409);
    attentionChanged();
    return c.json(r.view, 200, NO_STORE);
  });
  app.post(
    "/api/outreach/sender/unlink",
    small,
    control(async (c, b, t) => {
      if (b.confirm !== "UNLINK") return c.json({ error: 'Body must be { confirm: "UNLINK", sender? }' }, 400);
      const client = ownSender(c, t);
      if (client instanceof Response) return client;
      const r = await localControl(t, "unlink");
      dropLink();
      return r;
    }),
  );
  // The senders this host can use (§app.outreach/sender-list).
  app.get("/api/outreach/senders", async (c) => operatorOnly(c) ?? c.json({ senders: await listSenders() } satisfies SenderList, 200, NO_STORE));
  // Each organization's number (§app.outreach/org-sender): host-local, the operator's own.
  const orgView = async (orgId: string): Promise<OrgSenderView> => {
    const file = readOutreach();
    const list = await listSenders();
    const short = (e: { id: string; label: string; status: { me?: string } }) => ({ id: e.id, label: e.label, ...(e.status.me ? { me: e.status.me } : {}) });
    const def = list.find((e) => e.chosen);
    const { target, gone } = orgTarget(orgId, file);
    const eff = target ? list.find((e) => e.id === target.id) : undefined;
    return {
      off: !target,
      choice: file.orgs?.[orgId] ?? null,
      ...(target ? { effective: eff ? short(eff) : { id: target.id, label: target.label } } : {}),
      ...(gone ? { gone } : {}),
      ...(def ? { default: short(def) } : {}),
      options: list.map(short),
    };
  };
  const knownOrg = (orgId: string) => readIndex().orgs.some((o) => o.id === orgId);
  app.get("/api/outreach/orgs/:orgId", async (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const orgId = c.req.param("orgId");
    if (!knownOrg(orgId)) return c.json({ error: "No such organization on this host." }, 404);
    return c.json(await orgView(orgId), 200, NO_STORE);
  });
  app.put("/api/outreach/orgs/:orgId", small, async (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const orgId = c.req.param("orgId");
    if (!knownOrg(orgId)) return c.json({ error: "No such organization on this host." }, 404);
    const b = await bodyOf(c);
    if (!b || !("sender" in b) || (b.sender !== null && typeof b.sender !== "string")) return c.json({ error: "Body must be { sender: <sender id> | null }" }, 400);
    const cur = readOutreachState();
    if (cur.problem) return c.json({ error: `outreach.json can't be read (${cur.problem}); fix or remove it first.` }, 409);
    const orgs = { ...(cur.file.orgs ?? {}) };
    if (b.sender === null) delete orgs[orgId];
    else {
      if (!targetOf(b.sender, cur.file)) return c.json({ error: "No sender this host can use has that id." }, 400);
      orgs[orgId] = b.sender;
    }
    const r = saveOutreach({ orgs });
    if ("error" in r) return c.json({ error: r.error }, 400);
    await watchSenders();
    orgSenderChanged(orgId);
    attentionChanged();
    return c.json(await orgView(orgId), 200, NO_STORE);
  });
  // Who the strip may send to now (§app.outreach/send-link): the holder, or the open offer's reached
  // invitees; each ready or why not, and their number for the wa.me fallback (the operator's own view).
  app.get("/api/baton/:sid/outreach", async (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    const hit = batonById(c.req.param("sid"));
    if (!hit) return c.json({ error: "Unknown baton session" }, 404);
    const row = hit.row;
    // The organization's sender's state as of now, so a down sender shows on the strip before anyone presses Send.
    await refreshSender(orgTarget(row.orgId).target);
    const offer = currentOffer(row);
    const ids = offer ? offer.to.filter((id) => reachedBy(offer, id)) : row.holder && row.holder !== OPERATOR ? [row.holder] : [];
    const roster = readRoster(row.orgId);
    const people: BatonOutreach["people"] = ids.flatMap((id) => {
      const p = roster.find((x) => x.id === id);
      if (!p) return [];
      const nr = notReady(row.orgId, id);
      const wa = waDigits(p.contact?.whatsapp);
      return [{ id, name: p.name, ready: !nr, ...(nr ? { why: nr.why, code: nr.code } : {}), ...(wa ? { wa } : {}) }];
    });
    return c.json({ people, operatorName: operatorName(), publicTitle: row.publicTitle } satisfies BatonOutreach, 200, NO_STORE);
  });
  // Send on WhatsApp (§app.outreach/send-link): the statechart's act, settled; the answer names the outcome only.
  const fail = (c: Context, err: unknown) => {
    if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    throw err;
  };
  const read = async (c: Context): Promise<Record<string, unknown>> => {
    const b = await c.req.json().catch(() => ({}));
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const sentBy = (by: ReturnType<typeof operatorBy>) => (by.via === "overseer" ? "operator-via-overseer" : "operator") as "operator" | "operator-via-overseer";
  app.post("/api/baton/:sid/send-link", small, async (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    const b = await read(c);
    const by = operatorBy(c);
    try {
      const r = await sendHandoffLink(c.req.param("sid"), str(b.person), str(b.note), (orgId, projectId) => operatorEnvelope(orgId, projectId, by), sentBy(by));
      attentionChanged();
      return c.json(r);
    } catch (err) {
      return fail(c, err);
    }
  });
  // Any send (§app.outreach/send): a person of the project's organization, a link reference and/or a note.
  app.post("/api/outreach/send", small, async (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    const b = await read(c);
    const orgId = str(b.orgId);
    const projectId = str(b.projectId);
    const personId = str(b.personId);
    if (!orgId || !projectId || !personId) return c.json({ error: "orgId, projectId and personId are required" }, 400);
    const link = b.link === undefined ? undefined : parseLinkRef(b.link);
    if (link === null) return c.json({ error: 'link must be {kind: "handoff", session} or {kind: "preview", preview}' }, 400);
    const by = operatorBy(c);
    try {
      const r = await sendAct({ orgId, projectId, personId, ...(link ? { link } : {}), ...(str(b.note) ? { note: str(b.note) } : {}), sentBy: sentBy(by) }, operatorEnvelope(orgId, projectId, by));
      attentionChanged();
      return c.json(r);
    } catch (err) {
      return fail(c, err);
    }
  });
}
