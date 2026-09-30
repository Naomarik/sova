import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { OPERATOR } from "../../shared/baton";
import { waDigits, type BatonOutreach, type OutreachInfo, type OutreachPatch } from "../../shared/outreach";
import { attentionChanged } from "../attention-memo";
import { meshPeers } from "../mesh";
import { PROXIED_HEADER } from "../mesh/proxy";
import { operatorBy } from "../org-routes";
import { batonById, currentOffer, reachedBy } from "../baton";
import { operatorName, OrgError, readRoster } from "../orgs";
import { secretRules } from "../overseer-deny";
import { notReady, sendLinkAct } from "./core";
import { outreachSecretDirs, outreachSecretFiles, sandboxWarning } from "./secrets";
import { readOutreachState, saveOutreach } from "./settings";
import { resetLocalClient, whatsapp } from "./whatsapp";

/**
 * The operator's outreach routes (§app.outreach/sender-route, /send-link), main listener only: a
 * request that carries a peer or came through the mesh proxy gets 404, like Public links'.
 */

const local = (c: Context) => !(c.env as { meshPeer?: unknown } | undefined)?.meshPeer && !c.req.header(PROXIED_HEADER);
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
  return { file: now, sender, protected: covered, peers, sandboxWarning: file.sender === "off" ? null : sandboxWarning(now.authDir), ...(problem ? { problem } : {}) };
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
    if ("sender" in patch) resetLocalClient();
    attentionChanged();
    return c.json(await outreachInfo(), 200, NO_STORE);
  });
  // Who the strip may send to now (§app.outreach/send-link): the holder, or the open offer's reached
  // invitees; each ready or why not, and their number for the wa.me fallback (the operator's own view).
  app.get("/api/baton/:sid/outreach", (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
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
      return [{ id, name: p.name, ready: !nr, ...(nr ? { why: nr.why } : {}), ...(wa ? { wa } : {}) }];
    });
    return c.json({ people, operatorName: operatorName(), publicTitle: row.publicTitle } satisfies BatonOutreach, 200, NO_STORE);
  });
  // Send on WhatsApp (§app.outreach/send-link): the chart's act, settled; the answer names the outcome only.
  app.post("/api/baton/:sid/send-link", small, async (c) => {
    if (!local(c)) return c.json({ error: "Not found" }, 404);
    let person: string | undefined;
    try {
      const b = (await c.req.json().catch(() => ({}))) as { person?: unknown };
      person = typeof b.person === "string" && b.person ? b.person : undefined;
    } catch {
      person = undefined;
    }
    try {
      const r = await sendLinkAct(c.req.param("sid"), person, operatorBy(c));
      attentionChanged();
      return c.json(r);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      throw err;
    }
  });
}
