// sova_relay (§app.overseer-pings/relay): the Overseer passes a session's ping on to at most 3 other sessions.
// It picks only who receives it, never the words: the tool takes no text. What goes is decided by what covers the
// act, never by a parameter:
//   - a turn the user started in the Overseer (their message, a card click): the ping's words, all of them;
//   - a turn they didn't (a ping turn, a brief): a relay the user asked for in a run of their own there, at hop 0,
//     passes their own words alone ("Done because you asked in {title}."; `under: ask:pg_N`); an approval for
//     later that lists every recipient passes all of it; news goes under a standing rule that names sova_relay,
//     only to sessions of the pinging session's project; anything else waits for the user's click on a card.
// A note passed on carries hop + 1, so it is never passed on again without a click. Every call is one line of
// the pings log (never the text) and one of overseer-actions.jsonl (the act wrapper), and the pinging chat's
// card says what became of each recipient.

import { PING_ID_RE, type PingOutcome, type PingRecord, type SessionSummary } from "../shared/protocol";
import type { OverseerPingLimits } from "../shared/protocol";
import { auditPing, pingStore, setPingOutcome, type PingStore } from "./overseer-pings";
import { holdNews, newsText, relayDelivery, relayHop, relayText, type RelayAttempt } from "./overseer-relay";
import { Refusal, sessionRef, text } from "./session-guards";

const HOUR_MS = 3_600_000;
export const RELAY_KEY = "relay";
export const recipientKey = (id: string) => `recipient:${id}`;

/** What sova_relay needs from the Overseer's tools (overseer-tools.ts). */
export interface RelayToolDeps {
  act: (name: string, run: (params: any, toolCallId: string) => Promise<{ content: ReturnType<typeof text>; details: unknown; under?: string }>, opts?: { unattended?: boolean }) => any;
  /** A session by any form of its id or alias; null when none matches. */
  lookup(ref: unknown): Promise<SessionSummary | null>;
  /** A session as an in-app link, named summary-first. */
  link(s: SessionSummary): string;
  /** The message the Overseer answers now is the user's. */
  attended(): boolean;
  /** The live approval for later or standing rule covering `tool` on every one of `ids`. */
  permit?(tool: string, ids: string[]): { id: string; label: string } | null;
  used?(id: string, tool: string, sessions: string[], toolCallId: string): void;
  /** One of the per-turn prompts (a user turn's cap); the refusal sentence, or null. */
  takePrompt(): string | null;
  limits(): OverseerPingLimits;
  /** The project root a folder belongs to (§chat.profiles/projects), or null. */
  projectRoot(cwd: string): Promise<string | null>;
  store?: () => PingStore;
  /** The relay delivery (overseer-relay.ts); absent: the running one. */
  deliver?: (r: Parameters<NonNullable<ReturnType<typeof relayDelivery>>["send"]>[0]) => Promise<RelayAttempt>;
}

const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root.replace(/\/+$/, "")}/`);

/** Why a session takes no passed-on note, or null. */
function recipientRefusal(s: SessionSummary, ping: PingRecord): { why: string; terminal?: true } | null {
  if (s.id === ping.sessionId) return { why: "it is the session that pinged" };
  if (s.live) return { why: "it is open in a terminal, so nothing was sent", terminal: true };
  if (s.archived) return { why: "it is archived, so nothing was sent" };
  if (s.overseer || s.projectOverseer) return { why: "it is an Overseer's conversation, which takes no passed-on notes" };
  if (s.baton) return { why: "it is a baton or gathering session, which takes no passed-on notes" };
  if (s.workerSession) return { why: "it is a worker's session, which takes no passed-on notes" };
  if (s.queueChat) return { why: "it is a merge queue chat, which takes no passed-on notes" };
  return null;
}

/** A recipient that isn't a session on this host: a peer's, or an id nothing matches. */
const NOT_HERE = "it isn't a session on this host (a peer's session takes no passed-on notes), so nothing was sent";

/** The refusal that sends the Overseer to a card: the ping waits for the user's click there. */
const WAITS_FOR_CLICK = "Offer it to the user on a sova_card card instead (say what it is and who it is for); their click starts a turn in which you may pass it on. Nothing was passed on.";

export function relayTool(d: RelayToolDeps) {
  const store = () => (d.store ?? pingStore)();
  const outcome = (id: string, o: PingOutcome) => setPingOutcome(id, o, store()).catch(() => null);
  return {
    name: "sova_relay",
    label: "Pass a ping on",
    description:
      "Pass a session's ping (pg_N, from an [overseer-ping] message or the run note's [pings]) on to at most 3 other sessions on this host. You pick only who receives it; the words are the ping's, never yours: this tool takes no text. In a turn the user did not start it runs only for a relay the user asked for in a run of their own there, at hop 0 (then only the user's own words there go, and the result says \"Done because you asked in …\"), for news under a standing rule that names sova_relay (only to sessions of the pinging session's project), or under an approval for later listing every recipient; anything else waits for the user's click: offer it on a sova_card card. Pick the recipient from the user's own words there; when you can't tell who they meant, don't guess: offer a card and call this with offered: true, so the pinging chat's card says it waits for the user. A relay starts a turn in an idle recipient (a busy one gets it when its turn settles); news reaches each recipient as a hidden note at the start of its next turn. Never a session open in a terminal, an archived one, the pinging session, an Overseer's, a baton's, a worker's or a merge queue chat.",
    promptSnippet: "pass a session's ping on to other sessions (its own words; you pick only who)",
    parameters: {
      type: "object",
      properties: {
        ping: { type: "string", description: "The ping's id, pg_N." },
        sessions: { type: "array", items: { type: "string" }, maxItems: 3, description: "Session ids (or links) to pass it to, at most 3." },
        offered: { type: "boolean", description: "true: you offered it to the user on a card instead (who it is for is unclear, or it waits for their click); give no sessions." },
      },
      required: ["ping"],
      additionalProperties: false,
    },
    execute: d.act(
      "sova_relay",
      async (p: any, toolCallId: string) => {
        const id = typeof p?.ping === "string" ? p.ping.trim() : "";
        // No ping, no pinging session: the line names none.
        const early = (why: string, reason: string): never => {
          auditPing({ sessionId: "", kind: "sova_relay", ...(id && PING_ID_RE.test(id) ? { ping: id } : {}), outcome: "refused", error: why, reason });
          throw new Refusal(why);
        };
        if (!PING_ID_RE.test(id)) early("ping is a ping's id, pg_N. Nothing was passed on.", "bad-ping");
        const ping = store().get(id) ?? early(`No ping ${id}. Nothing was passed on.`, "no-ping");
        const refs: unknown[] = Array.isArray(p?.sessions) ? p.sessions : [];
        const audit = (o: "ok" | "refused", extra: { to?: string[]; error?: string; reason?: string } = {}) =>
          auditPing({ sessionId: ping.sessionId, kind: "sova_relay", ping: id, outcome: o, ...extra });
        const refuse = async (why: string, opts: { offered?: boolean; reason?: string } = {}): Promise<never> => {
          if (opts.offered) await outcome(id, { kind: "offered" });
          audit("refused", { error: why, ...(opts.reason ? { reason: opts.reason } : {}) });
          throw new Refusal(why);
        };
        if (p?.offered === true) {
          if (refs.length) return refuse("Give sessions or offered: true, not both. Nothing was passed on.");
          await outcome(id, { kind: "offered" });
          audit("ok", { reason: "offered" });
          return { content: text(`The ping's card in its chat now says it was offered to the user here. Raise the sova_card card that offers ${id}, if you haven't.`), details: { v: 1, ping: id, offered: true } };
        }
        const limits = d.limits();
        const most = Math.min(3, limits.relayRecipients);
        if (!refs.length) return refuse("Name the sessions to pass it to (at most 3), or offered: true when you offered it on a card. Nothing was passed on.");
        if (refs.length > most) return refuse(`At most ${most} recipients per pass-on (${refs.length} given; Settings → Overseer → Limits). Nothing was passed on.`, { reason: "limit" });
        const recipients: SessionSummary[] = [];
        const notHere: string[] = [];
        for (const ref of refs) {
          const s = await d.lookup(ref).catch(() => null);
          if (!s) {
            const raw = sessionRef(ref) || String(ref);
            if (!notHere.includes(raw)) notHere.push(raw);
          } else if (!recipients.some((x) => x.id === s.id)) recipients.push(s);
        }
        // Each is refused on its own, in the result and on the pinging chat's card; the others still go.
        const lines: string[] = [];
        const refuseNotHere = async () => {
          for (const raw of notHere) {
            await outcome(id, { kind: "refused", to: { id: raw, title: raw }, why: NOT_HERE });
            lines.push(`${raw}: ${NOT_HERE}.`);
          }
        };
        if (!recipients.length) {
          await refuseNotHere();
          return refuse(`${lines.join("\n")}\nNothing was passed on.`, { reason: "recipients" });
        }
        const ids = recipients.map((s) => s.id);
        const from = await d.lookup(ping.sessionId).catch(() => null);
        const fromLink = from ? d.link(from) : `"${ping.title}"`;

        // What covers it, and so what goes: everything in a turn the user started; else the user's own words, or under a permit.
        const attended = d.attended();
        let words: "said" | "all" = "all";
        let under: { id: string; done: string; permit: boolean } | null = null;
        if (!attended) {
          const permit = d.permit?.("sova_relay", ids) ?? null;
          const grant = permit && permit.id.startsWith("g_") ? permit : null;
          if (ping.hop > 0 || (ping.kind === "relay" && !ping.attended))
            return refuse(
              `${id} was made in a run the user's own message didn't start there${ping.hop > 0 ? ` (hop ${ping.hop}: a note passed on is never passed on again without the user's click)` : ""}, so it goes only at the user's click. ${WAITS_FOR_CLICK}`,
              { offered: true, reason: "needs-click" },
            );
          if (ping.kind === "relay") {
            if (grant) under = { id: grant.id, done: `Done under ${grant.id} (${grant.label}).`, permit: true };
            else if (ping.said) {
              words = "said";
              under = { id: `ask:${id}`, done: `Done because you asked in ${fromLink}.`, permit: false };
            } else return refuse(`${id} carries no words of the user's to pass on. ${WAITS_FOR_CLICK}`, { offered: true, reason: "needs-click" });
          } else if (ping.kind === "news") {
            const root = permit && !grant ? await d.projectRoot(ping.cwd).catch(() => null) : null;
            const inProject = !!root && recipients.every((s) => within(s.cwd, root));
            if (grant || (permit && inProject)) under = { id: permit!.id, done: `Done under ${permit!.id} (${permit!.label}).`, permit: true };
            else
              return refuse(
                `News goes on in a turn the user didn't start only under a standing rule that names sova_relay, to sessions of the pinging session's project, or under an approval for later listing every recipient${permit ? ` (${permit.id} covers these sessions, but not all of them are in that project)` : ""}. ${WAITS_FOR_CLICK} You may propose that rule there ("Pass on news a session announces to the sessions of its project it affects").`,
                { offered: true, reason: "needs-rule" },
              );
          } else if (grant) under = { id: grant.id, done: `Done under ${grant.id} (${grant.label}).`, permit: true };
          else return refuse(`This turn was not started by the user, so a ${ping.kind} ping is passed on only at their click. ${WAITS_FOR_CLICK}`, { offered: true, reason: "needs-click" });
        }

        const news = ping.kind === "news";
        const deliver = d.deliver ?? ((r) => {
          const running = relayDelivery();
          if (!running) throw new Refusal("Passing notes on isn't running on this server yet. Nothing was passed on.");
          return running.send(r);
        });
        await refuseNotHere();
        const reached: string[] = [];
        const s0 = store();
        for (const s of recipients) {
          const to = { id: s.id, title: s.title };
          const no = recipientRefusal(s, ping);
          if (no) {
            await outcome(id, no.terminal ? { kind: "terminal", to } : { kind: "refused", to, why: no.why });
            lines.push(`${d.link(s)}: ${no.why}.`);
            continue;
          }
          // Limits: each recipient at most N notes an hour; on its own, N recipients a day; in a user turn, one of its prompts.
          if (s0.recent(recipientKey(s.id), HOUR_MS) >= limits.recipientPerHour) {
            const why = `limit reached: at most ${limits.recipientPerHour} passed-on notes an hour to one session`;
            await outcome(id, { kind: "refused", to, why });
            lines.push(`${d.link(s)}: ${why} (Settings → Overseer → Limits).`);
            continue;
          }
          if (!attended && s0.today(RELAY_KEY) >= limits.relayPerDay) {
            const why = `limit reached: at most ${limits.relayPerDay} recipients a day on its own`;
            await outcome(id, { kind: "refused", to, why });
            lines.push(`${d.link(s)}: ${why} (Settings → Overseer → Limits).`);
            continue;
          }
          if (attended) {
            const over = d.takePrompt();
            if (over) {
              lines.push(`${d.link(s)}: ${over}`);
              continue;
            }
          }
          const stamps = [{ key: recipientKey(s.id), at: s0.note(recipientKey(s.id)) }, ...(!attended ? [{ key: RELAY_KEY, at: s0.note(RELAY_KEY) }] : [])];
          const giveBack = () => {
            for (const st of stamps) s0.give(st.key, st.at);
          };
          if (news) {
            holdNews({ ping: id, to: { id: s.id, path: s.path, title: s.title }, text: newsText(ping) }, s0);
            reached.push(s.id);
            lines.push(`${d.link(s)}: it reads the news as a hidden note at the start of its next turn.`);
            continue;
          }
          let r: RelayAttempt;
          try {
            r = await deliver({ ping: id, to: { id: s.id, path: s.path, title: s.title }, text: relayText(ping, words), hop: relayHop(ping), from: { sessionId: ping.sessionId, title: ping.title } });
          } catch (err) {
            giveBack();
            if (err instanceof Refusal) {
              audit("refused", { error: err.message, reason: "not-running" });
              throw err;
            }
            lines.push(`${d.link(s)}: not sent (${err instanceof Error ? err.message : String(err)}).`);
            continue;
          }
          if (r === "started") {
            reached.push(s.id);
            lines.push(`Passed to ${d.link(s)}: it starts a turn there.`);
          } else if (r === "waiting") {
            reached.push(s.id);
            lines.push(`${d.link(s)} is busy: it gets the note once its turn settles (never as a steer).`);
          } else {
            giveBack();
            lines.push(`${d.link(s)}: ${r === "terminal" ? "it is open in a terminal, so nothing was sent" : "refused, nothing was sent"}.`);
          }
        }
        if (!reached.length) return refuse(`${lines.join("\n")}\nNothing was passed on.`, { reason: "recipients" });
        if (under?.permit) d.used?.(under.id, "sova_relay", ids, toolCallId);
        audit("ok", { to: reached, ...(under ? { reason: under.id } : {}) });
        const what = words === "said" ? "the user's own words" : news ? "the news" : "the ping's words";
        return {
          content: text([`Passed on ${what} of ${id} (hop ${relayHop(ping)}).`, ...lines, ...(under ? [under.done] : [])].join("\n")),
          details: { v: 1, ping: id, to: reached, hop: relayHop(ping), words },
          ...(under ? { under: under.id } : {}),
        };
      },
      // It judges its own coverage (above): the act wrapper's refusal is not the one that applies.
      { unattended: true },
    ),
  };
}
