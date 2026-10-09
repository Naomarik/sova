import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { OPERATOR } from "../../shared/baton";
import { waDigits, type BatonOutreach, type OutreachInfo, type OutreachPatch, type SenderList } from "../../shared/outreach";
import { attentionChanged } from "../attention-memo";
import { meshPeers } from "../mesh";
import { localRequest } from "../mesh/proxy";
import { operatorBy } from "../org-routes";
import { batonById, currentOffer, reachedBy } from "../baton";
import { operatorEnvelope, operatorName, OrgError, readRoster } from "../orgs";
import { secretRules } from "../overseer-deny";
import { OVERSEER_SENDER_HEADER } from "../overseer-sender";
import { notReady, refreshSender, sendAct, sendHandoffLink } from "./core";
import { cancelLink, dropLink, linkView, startLink } from "./link";
import { parseLinkRef } from "./links";
import { outreachSecretDirs, outreachSecretFiles, sandboxWarning } from "./protected-paths";
import { listSenders } from "./senders";
import { localSocket, readOutreach, readOutreachState, saveOutreach } from "./settings";
import { senderUnit, startSenderUnit } from "./unit";
import { localClient, localControl, resetLocalClient, viaReconnect, whatsapp, type ControlAnswer } from "./whatsapp";

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

export async function outreachInfo(): Promise<OutreachInfo> {
  const { file, problem } = readOutreachState();
  const sender = await whatsapp.status();
  // Read again: a status call may have recorded the auth directory the sender reported.
  const now = readOutreachState().file;
  const denied = new Set([...secretRules().dirs, ...secretRules().files]);
  const covered = [...outreachSecretDirs(), ...outreachSecretFiles()].filter((p) => denied.has(p));
  const peers = meshPeers().map((p) => ({ nodeId: p.nodeId, label: p.label }));
  // Start Sender: asked of systemd only while the local sender doesn't answer.
  const socket = localSocket(now.sender);
  const unit = socket && sender.state === "unreachable" ? await senderUnit(socket).catch(() => null) : null;
  return {
    file: now,
    sender,
    protected: covered,
    peers,
    sandboxWarning: file.sender === "off" ? null : sandboxWarning(now.senderAuthDir ?? now.authDir),
    ...(problem ? { problem } : {}),
    ...(unit ? { unit } : {}),
  };
}

export function mountOutreach(app: Hono): void {
  app.get("/api/outreach", async (c) => (local(c) ? c.json(await outreachInfo(), 200, NO_STORE) : c.json({ error: "Not found" }, 404)));
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
    for (const k of ["sender", "acceptFrom", "paused", "authDir"] as const) if (k in body) (patch as Record<string, unknown>)[k] = (body as Record<string, unknown>)[k];
    for (const k of Object.keys(body)) if (!["sender", "acceptFrom", "paused", "authDir"].includes(k)) return c.json({ error: `Unknown key ${JSON.stringify(k)}` }, 400);
    const r = saveOutreach(patch);
    if ("error" in r) return c.json({ error: r.error }, 400);
    if ("sender" in patch) {
      resetLocalClient();
      dropLink();
    }
    attentionChanged();
    return c.json(await outreachInfo(), 200, NO_STORE);
  });
  // The sender's controls (§app.outreach/sender-controls): the operator's own buttons in Settings → Outreach.
  const operatorOnly = (c: Context): Response | null => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    if (c.req.header(OVERSEER_SENDER_HEADER) !== undefined) return c.json({ error: "Only the operator controls the WhatsApp sender, in Settings → Outreach." }, 403);
    return null;
  };
  const control = (run: (c: Context) => Promise<ControlAnswer | Response>) => async (c: Context) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const r = await run(c);
    if (r instanceof Response) return r;
    if (!r.ok) return c.json({ error: r.why, ...(r.code ? { code: r.code } : {}) }, 409);
    attentionChanged();
    return c.json(await outreachInfo(), 200, NO_STORE);
  };
  app.post(
    "/api/outreach/sender/reconnect",
    small,
    control(async (c) => {
      const route = readOutreach().sender;
      if (route === "off") return c.json({ error: "Outreach is off: there is no sender to reconnect." }, 409);
      return "via" in route ? viaReconnect(route.via.nodeId) : localControl("reconnect");
    }),
  );
  app.post(
    "/api/outreach/sender/pause",
    small,
    control(async (c) => {
      const b = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
      if (!b || typeof b.on !== "boolean") return c.json({ error: "Body must be { on: true | false }" }, 400);
      const route = readOutreach().sender;
      if (typeof route !== "object" || !("local" in route)) return c.json({ error: "Only the sender's own host pauses it." }, 409);
      return localControl("pause", { on: b.on });
    }),
  );
  app.post(
    "/api/outreach/sender/start",
    small,
    control(async (c) => {
      const socket = localSocket(readOutreach().sender);
      if (!socket) return c.json({ error: "Only the sender's own host starts it." }, 409);
      if ((await whatsapp.status()).state !== "unreachable") return c.json({ error: "The sender is already running." }, 409);
      const r = await startSenderUnit(socket);
      // A fresh connection: the next read finds the sender as soon as it listens (Settings reads again shortly).
      resetLocalClient();
      return r.ok ? { ok: true, frame: {} } : { ok: false, why: r.why };
    }),
  );
  // Linking a phone (§app.outreach/sender-link): this host's own sender only, never relayed. The answer
  // carries the newest QR or pairing code, so it is never cached.
  const ownSender = (c: Context) => localClient() ?? c.json({ error: "Only the sender's own host links or unlinks a phone: set Sender to This host there." }, 409);
  app.post("/api/outreach/sender/link", small, async (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const b = (await c.req.json().catch(() => ({}))) as { phone?: unknown } | null;
    if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ error: "Body must be { phone? }" }, 400);
    if (b.phone !== undefined && typeof b.phone !== "string") return c.json({ error: "phone must be a string of digits" }, 400);
    const client = ownSender(c);
    if (client instanceof Response) return client;
    const r = await startLink(client, b.phone);
    if (!r.ok) return c.json({ error: r.why, ...(r.code ? { code: r.code } : {}) }, r.code === "invalid" ? 400 : 409);
    attentionChanged();
    return c.json(r.view, 200, NO_STORE);
  });
  app.get("/api/outreach/sender/link", (c) => operatorOnly(c) ?? c.json(linkView(), 200, NO_STORE));
  app.post("/api/outreach/sender/link/cancel", small, async (c) => {
    const refused = operatorOnly(c);
    if (refused) return refused;
    const client = ownSender(c);
    if (client instanceof Response) return client;
    const r = await cancelLink(client);
    if (!r.ok) return c.json({ error: r.why, ...(r.code ? { code: r.code } : {}) }, 409);
    attentionChanged();
    return c.json(r.view, 200, NO_STORE);
  });
  app.post(
    "/api/outreach/sender/unlink",
    small,
    control(async (c) => {
      const b = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
      if (!b || b.confirm !== "UNLINK") return c.json({ error: 'Body must be { confirm: "UNLINK" }' }, 400);
      const client = ownSender(c);
      if (client instanceof Response) return client;
      const r = await localControl("unlink");
      dropLink();
      return r;
    }),
  );
  // The senders this host can use (§app.outreach/sender-list).
  app.get("/api/outreach/senders", async (c) => operatorOnly(c) ?? c.json({ senders: await listSenders() } satisfies SenderList, 200, NO_STORE));
  // Who the strip may send to now (§app.outreach/send-link): the holder, or the open offer's reached
  // invitees; each ready or why not, and their number for the wa.me fallback (the operator's own view).
  app.get("/api/baton/:sid/outreach", async (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    // The sender's state as of now, so a down sender shows on the strip before anyone presses Send.
    await refreshSender();
    const hit = batonById(c.req.param("sid"));
    if (!hit) return c.json({ error: "Unknown baton session" }, 404);
    const row = hit.row;
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
