// One event's detail on the History tab: what was decided or happened, the
// reason recorded at the time and by whom, the five actor facts, then the options, evidence, links,
// policy, capture and supersession, each as the server recorded it. A value not recorded says so;
// nothing is filled in. Its buttons read, link and copy; the one write is Purge Reason…, confirmed, in
// the detail's foot.
import { createSignal, For, Show, type JSX } from "solid-js";
import { isUnknown, type ActorView, type EventDetail, type EvidenceView, type LinkView } from "../../shared/org-history";
import type { OrgDetail } from "../../shared/orgs";
import { getHistoryEvent, getHistoryEvidence, getHistoryPacket, purgeHistoryReason } from "../lib/api";
import { shortDate, stampTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import { HISTORY_POLL_MS } from "../lib/org-history-source";
import type { HistoryFilters, HistoryView } from "../lib/org-history-route";
import {
  absentLine,
  actorsOf,
  actorWord,
  authorityAdds,
  authorizationWord,
  availabilityWord,
  entityRelationLines,
  noteChip,
  QUOTE_CHECK_NOTE,
  quoteCheckWords,
  conditionText,
  dispositionAdds,
  availabilityTone,
  linkWords,
  outcomeChip,
  OUTSIDE_FILTER,
  projectWords,
  RELATION_WORDS,
  PURGE_CONFIRM,
  reasonCaption,
  reasonWords,
  SOURCE_UNAVAILABLE,
  timeLines,
  TRIGGER_NOT_RECORDED,
  UNREADABLE,
  whatAdds,
  wordedBy,
} from "../lib/org-history-words";
import { announce, copyText, toast } from "../lib/ui-state";
import { outsideFilter } from "./OrgHistory";
import { Banner, Chip, Icon } from "./ui";

const OPTION_WORDS: Record<string, string> = { selected: "Selected", rejected: "Rejected", deferred: "Deferred", "do-not-do": "Won't do" };
const OPTION_TONE: Record<string, "success" | "info" | "warn" | undefined> = { selected: "success", rejected: "info", deferred: "warn", "do-not-do": "info" };
const DISPOSITION_WORDS = { choose: "Choice", reject: "Rejection", defer: "Deferral", "do-not-do": "Decision not to act" } as const;
const EVIDENCE_KIND_WORDS: Record<EvidenceView["ref"]["kind"], string> = {
  transcript: "Message",
  event: "Event",
  "log-row": "Transition log row",
  runtime: "Runtime observation",
  git: "Git",
  spec: "Spec record",
  validation: "Validation result",
};

export function OrgHistoryInspector(props: { org: OrgDetail; eventId: string; filters: HistoryFilters; hrefWith(over: Partial<HistoryView>): string; chain: boolean }) {
  const orgId = props.org.id;
  // Keyed on the id by the caller: a re-read reconciles in place, so open disclosures and focus stay.
  const detail = createPoll(() => getHistoryEvent(orgId, props.eventId), HISTORY_POLL_MS);
  const [purging, setPurging] = createSignal(false);
  const [purgeError, setPurgeError] = createSignal<string | null>(null);
  const [confirmPurge, setConfirmPurge] = createSignal(false);
  const [packet, setPacket] = createSignal<{ text: string; note: string } | null>(null);
  const [packetError, setPacketError] = createSignal<string | null>(null);
  const eventHref = () => props.hrefWith({ event: props.eventId, chain: undefined });
  const absolute = (href: string) => `${location.origin}${location.pathname}${href}`;

  const readPacket = async () => {
    const p = await getHistoryPacket(orgId, { event: props.eventId });
    const note = [
      `${p.events.length} ${p.events.length === 1 ? "event" : "events"}`,
      p.asOf !== null ? `as of ${stampTime(p.asOf)}` : "",
      p.omitted.events || p.omitted.chars ? `${p.omitted.events} events and ${p.omitted.chars.toLocaleString("en-US")} characters left out` : "nothing left out",
      p.freshness.current ? "" : "index catching up",
    ]
      .filter(Boolean)
      .join(" · ");
    return { text: p.text, note, unknowns: p.unknowns };
  };
  const copyContext = async () => {
    try {
      const p = await readPacket();
      setPacket({ text: p.text, note: p.note });
      setPacketError(null);
      await copyText(p.text, "Copied this event's context.");
    } catch (err) {
      setPacketError((err as Error).message);
    }
  };
  const purge = async () => {
    if (purging()) return;
    setPurging(true);
    try {
      await purgeHistoryReason(orgId, props.eventId);
      detail.refetch();
      setConfirmPurge(false);
      setPurgeError(null);
      toast("Reason purged.");
      announce("Reason purged.");
    } catch (err) {
      setPurgeError((err as Error).message);
    } finally {
      setPurging(false);
    }
  };

  return (
    <div class="orghist-detail">
      <Show when={detail.error() && !detail.data()}>
        <Banner tone="error" title="Couldn't read this event." body={`${detail.error()} It may not be in this organization's history, or this page may not read it.`} />
      </Show>
      <Show when={!detail.data() && !detail.error()}>
        <div class="skeleton skeleton-title" aria-label="Reading the event" />
      </Show>
      <Show when={detail.data()}>
        {(d) => {
          const e = () => d().event;
          const chip = () => outcomeChip(e().outcome);
          const who = () => actorsOf(e());
          const note = () => noteChip(e());
          const reason = () => reasonWords(e(), purgedAt(d()));
          const transcriptMissing = () => e().kind === "decision.recorded" && d().evidence.some((v) => v.ref.kind === "transcript" && v.availability !== "available");
          const what = () => (whatAdds(d().rationale?.what, e().headline) ? d().rationale!.what : null);
          // Who put the statement in words, when it isn't the decider: under the statement, the title unless What says more.
          const worded = () => wordedBy(e());
          // A name for whoever an authorization or reason names by kind and id: the decider's own label, a roster name.
          const label = (r: { kind: string; id?: string }): string | undefined => {
            const dec = who().decidedBy;
            if (!isUnknown(dec) && dec.kind === r.kind && (dec.id ?? "") === (r.id ?? "")) return dec.label;
            return r.kind === "person" && r.id ? props.org.roster.find((p) => p.id === r.id)?.name : undefined;
          };
          const absent = () => absentLine(d().evidence.length, d().resultedIn.length);
          return (
            <>
              <Show when={detail.error()}>{(err) => <Banner tone="warn" title="Couldn't refresh this event." body={`${err()} What shows is from the last read.`} />}</Show>
              <header class="orghist-detail-head">
                <h3 class="orghist-detail-title">{e().kind === "unsupported" ? UNREADABLE : e().headline}</h3>
                <Show when={!what() && worded()}>{(w) => <p class="orghist-caption">Worded by {w()}</p>}</Show>
                <div class="orghist-chips">
                  <Chip tone={chip().tone}>{chip().word}</Chip>
                  <Show when={d().record?.decision && dispositionAdds(d().record!.decision!.disposition, e().outcome) && d().record!.decision}>{(dec) => <Chip>{DISPOSITION_WORDS[dec().disposition]}</Chip>}</Show>
                  <Show when={note()}>{(w) => <Chip>{w()}</Chip>}</Show>
                  <Show when={e().origin === "imported"}>
                    <Chip>Imported</Chip>
                  </Show>
                  <Show when={outsideFilter(e(), props.filters.projects)}>
                    <Chip>{OUTSIDE_FILTER}</Chip>
                  </Show>
                </div>
                <p class="orghist-detail-meta">
                  <span>{projectWords(e())}</span>
                  <For each={timeLines(e())}>{(t) => <span class="orghist-mono"> · {t}</span>}</For>
                </p>
                <Show when={e().superseded}>
                  {(s) => (
                    <p class="orghist-superseded">
                      {s().type === "revokes" ? "Revoked" : s().type === "amends" ? "Amended" : "Superseded"} {shortDate(s().at)} —{" "}
                      <a href={props.hrefWith({ event: s().by, chain: undefined })}>Open New Decision</a>
                    </p>
                  )}
                </Show>
                <div class="button-row orghist-actions">
                  <button type="button" class="button" onClick={() => void copyText(absolute(eventHref()), "Copied the event's link. It opens for someone who may read this history.")}>
                    <Icon name="copy" small />
                    Copy Event Link
                  </button>
                  <button type="button" class="button" onClick={() => void copyContext()}>
                    <Icon name="copy" small />
                    Copy Event Context
                  </button>
                  {/* Last: the two Copy actions keep one row; this one wraps. */}
                  <Show when={!props.chain}>
                    <a class="button" href={props.hrefWith({ event: props.eventId, chain: true })}>
                      View Chain
                    </a>
                  </Show>
                </div>
                <Show when={packetError()}>{(err) => <p class="field-error">Couldn't make the context: {err()}</p>}</Show>
              </header>

              <Show when={what()}>
                {(w) => (
                  <Block title="What">
                    <p class="orghist-what">{w()}</p>
                    <Show when={worded()}>{(by) => <p class="orghist-caption">Worded by {by()}</p>}</Show>
                  </Block>
                )}
              </Show>

              <Block title="Recorded Reason">
                <p classList={{ "orghist-muted": reason().muted }}>{d().rationale?.reason?.text ?? reason().text}</p>
                <Show when={d().rationale?.reason}>{(r) => <p class="orghist-caption">{reasonCaption(r(), who().recordedBy, (a) => label(a) ?? authorLabel(a, props.org))}</p>}</Show>
                <For each={d().later}>
                  {(l) => (
                    <p class="orghist-caption">
                      Added later, {shortDate(l.recordedAt)}:{" "}
                      <a href={props.hrefWith({ event: l.id, chain: undefined })}>{l.headline}</a>
                    </p>
                  )}
                </For>
              </Block>

              <Block title="Who">
                <dl class="orgs-facts orghist-who">
                  <dt>Initiated by</dt>
                  <dd>{actorWord(who().initiatedBy)}</dd>
                  {/* A note or correction decides nothing: no decider, no authority. */}
                  <Show when={!note()}>
                    <dt>Decided by</dt>
                    <dd>{actorWord(who().decidedBy)}</dd>
                  </Show>
                  <dt>Recorded by</dt>
                  <dd>{actorWord(who().recordedBy)}</dd>
                  <dt>Executed by</dt>
                  <dd>{actorWord(who().executedBy)}</dd>
                  <Show when={!note()}>
                    <dt>Authority</dt>
                    <dd>{authorizationWord(who().authorization, label)}</dd>
                  </Show>
                  <Show when={d().record?.decision && authorityAdds(d().record!.decision!.authority, who().decidedBy) && d().record!.decision}>
                    {(dec) => (
                      <>
                        <dt>Decision authority</dt>
                        <dd>{isUnknown(dec().authority) ? "Not recorded" : (label(dec().authority as { kind: string; id?: string }) ?? authorLabel(dec().authority as { kind: string; id?: string }, props.org))}</dd>
                      </>
                    )}
                  </Show>
                </dl>
              </Block>

              <Show when={d().options.length}>
                <Block title="Alternatives">
                  <ul class="orghist-options">
                    <For each={d().options}>
                      {(o) => (
                        <li class="orghist-option">
                          <span class="orghist-option-head">
                            <span class="orghist-option-label">{o.label ?? "Option label not readable here"}</span>
                            <Chip tone={OPTION_TONE[o.outcome]}>{OPTION_WORDS[o.outcome] ?? o.outcome}</Chip>
                          </span>
                          <Show when={o.reason}>{(r) => <span class="orghist-caption">Reason: {r()}</span>}</Show>
                          <Show when={o.condition}>{(c) => <span class="orghist-caption">{conditionText(c())}</span>}</Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Block>
              </Show>

              <Show when={d().evidence.length}>
                <Block title="Evidence">
                  <ol class="orghist-evidence">
                    <For each={d().evidence}>{(v) => <EvidenceRow view={v} orgId={orgId} eventId={props.eventId} decision={e().kind === "decision.recorded"} recorder={actorWord(who().recordedBy)} org={props.org} hrefWith={props.hrefWith} />}</For>
                  </ol>
                  <Show when={transcriptMissing()}>
                    <p class="orghist-muted">{SOURCE_UNAVAILABLE}</p>
                  </Show>
                  <Show when={d().evidence.some((v) => v.ref.kind === "transcript")}>
                    <p class="orghist-caption">{QUOTE_CHECK_NOTE}</p>
                  </Show>
                </Block>
              </Show>

              <Block title="Triggered By">
                <Show when={d().triggeredBy.length} fallback={<p class="orghist-muted">{d().unresolved.length ? "A trigger not in this index" : TRIGGER_NOT_RECORDED}</p>}>
                  <ul class="orghist-links">
                    <For each={d().triggeredBy}>{(l) => <LinkLine link={l} filters={props.filters} hrefWith={props.hrefWith} />}</For>
                  </ul>
                </Show>
              </Block>

              <Show when={d().resultedIn.length}>
                <Block title="Resulted In">
                  <ul class="orghist-links">
                    <For each={d().resultedIn}>{(l) => <LinkLine link={l} filters={props.filters} hrefWith={props.hrefWith} />}</For>
                  </ul>
                </Block>
              </Show>

              <Show when={d().related.length || entityRelationLines(d().record?.relations).length}>
                <Block title="Related">
                  <ul class="orghist-links">
                    <For each={d().related}>{(l) => <LinkLine link={l} filters={props.filters} hrefWith={props.hrefWith} />}</For>
                    {/* A relation to a fact from before capture: its type and id only, no event to open. */}
                    <For each={entityRelationLines(d().record?.relations)}>
                      {(line) => (
                        <li class="orghist-link">
                          <span class="orghist-link-rel">{line}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Block>
              </Show>

              <Show when={absent()}>{(a) => <p class="orghist-caption">{a()}</p>}</Show>

              <details class="orghist-more-details">
                <summary class="orghist-summary">Policy and Capture</summary>
                <dl class="orgs-facts">
                  <Show when={d().record?.policy}>
                    {(p) => (
                      <>
                        <dt>Attended</dt>
                        <dd>{p().attended ? "Yes, as evaluated for this act" : "No: unattended"}</dd>
                        <Show when={p().autonomy}>
                          <dt>Level</dt>
                          <dd>{p().autonomy}{p().inForce && p().inForce !== p().autonomy ? ` (in force: ${p().inForce})` : ""}</dd>
                        </Show>
                        <Show when={p().paused}>
                          <dt>Paused</dt>
                          <dd>Yes</dd>
                        </Show>
                        <Show when={p().hold}>
                          <dt>Hold</dt>
                          <dd class="orghist-mono">{p().hold}</dd>
                        </Show>
                        <Show when={p().card}>
                          <dt>Confirm card</dt>
                          <dd class="orghist-mono">{p().card}</dd>
                        </Show>
                        <Show when={p().grants?.length}>
                          <dt>Grants</dt>
                          <dd class="orghist-mono">{p().grants!.join(", ")}</dd>
                        </Show>
                      </>
                    )}
                  </Show>
                  <dt>Captured</dt>
                  <dd>
                    {captureWords(d())}
                    <Show when={d().record?.capture.origin === "live" && d().record!.source.adapter}>{(by) => <span class="orghist-mono"> · {by()}</span>}</Show>
                  </dd>
                  <dt>Event id</dt>
                  <dd class="orghist-mono">{e().id}</dd>
                  <For each={d().refusedLinks}>
                    {(r) => (
                      <>
                        <dt>Link refused</dt>
                        <dd>{refusedWords(r)}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </details>

              <details class="orghist-more-details" onToggle={(ev) => ev.currentTarget.open && !packet() && void readPacket().then((p) => setPacket({ text: p.text, note: p.note }), (err: Error) => setPacketError(err.message))}>
                <summary class="orghist-summary">Context Used</summary>
                <p class="orghist-caption">The packet Copy Event Context copies, as the server made it.</p>
                <Show when={packet()} fallback={<p class="orghist-muted">Reading…</p>}>
                  {(p) => (
                    <>
                      <p class="orghist-caption orghist-mono">{p().note}</p>
                      <pre class="orghist-packet">{p().text}</pre>
                    </>
                  )}
                </Show>
              </details>

              <Show when={canPurge(d())}>
                <div class="orghist-detail-foot">
                  <Show
                    when={confirmPurge()}
                    fallback={
                      <div class="button-row">
                        <button type="button" class="button button-destructive" onClick={() => setConfirmPurge(true)}>
                          Purge Reason…
                        </button>
                      </div>
                    }
                  >
                    <div class="orghist-confirm" role="group" aria-label="Purge this reason">
                      <p>{PURGE_CONFIRM}</p>
                      <div class="button-row">
                        <button type="button" class="button button-destructive" aria-busy={purging() ? "true" : undefined} onClick={() => void purge()}>
                          Purge Reason
                        </button>
                        <button type="button" class="button button-ghost" onClick={() => setConfirmPurge(false)}>
                          Cancel
                        </button>
                      </div>
                      <Show when={purgeError()}>{(err) => <p class="field-error">{err()}</p>}</Show>
                    </div>
                  </Show>
                </div>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

function Block(props: { title: string; children: JSX.Element }) {
  return (
    <section class="orghist-block">
      <h4 class="orghist-block-title">{props.title}</h4>
      {props.children}
    </section>
  );
}

function LinkLine(props: { link: LinkView; filters: HistoryFilters; hrefWith(over: Partial<HistoryView>): string }) {
  const e = () => props.link.event;
  const outside = () => outsideFilter(e(), props.filters.projects);
  const chip = () => outcomeChip(e().outcome);
  return (
    <li class="orghist-link" classList={{ "orghist-link-boundary": outside() }}>
      <span class="orghist-link-rel" classList={{ "orghist-link-causal": !!props.link.via }}>
        {linkWords(props.link)}
      </span>
      <a class="orghist-link-target" href={props.hrefWith({ event: e().id, chain: undefined })}>
        {e().headline}
      </a>
      <span class="orghist-caption">
        {projectWords(e())}
        {" · "}
        {stampTime(e().occurredAt ?? e().recordedAt)}
      </span>
      <Chip tone={chip().tone}>{chip().word}</Chip>
      <Show when={outside()}>
        <span class="orghist-boundary-label">{OUTSIDE_FILTER} · Open Related Event</span>
      </Show>
    </li>
  );
}

function EvidenceRow(props: { view: EvidenceView; orgId: string; eventId: string; decision: boolean; recorder: string; org: OrgDetail; hrefWith(over: Partial<HistoryView>): string }) {
  const r = () => props.view.ref;
  const [open, setOpen] = createSignal(false);
  const [span, setSpan] = createSignal<EvidenceView | null>(null);
  const [opening, setOpening] = createSignal(false);
  const [openError, setOpenError] = createSignal<string | null>(null);
  const toggle = async () => {
    if (open()) return setOpen(false);
    if (!span()) {
      setOpening(true);
      try {
        setSpan(await getHistoryEvidence(props.orgId, props.eventId, r().n));
        setOpenError(null);
      } catch (err) {
        setOpenError((err as Error).message);
        return;
      } finally {
        setOpening(false);
      }
    }
    setOpen(true);
  };
  const source = (): { href: string; label: string } | null => {
    const ref = r();
    if (props.view.availability !== "available") return null;
    if (ref.kind === "event") return { href: props.hrefWith({ event: ref.event, chain: undefined }), label: "Open Event" };
    // The session by its id, resolved on this host (a session of a peer's org opens there once listed).
    if (ref.kind === "transcript") return { href: `#/sid/${encodeURIComponent(ref.session)}`, label: "Open Session" };
    return null;
  };
  const detail = (): string => {
    const ref = r();
    switch (ref.kind) {
      case "transcript":
        return [ref.speaker ? `Attributed to ${authorLabel(ref.speaker, props.org)}` : "Speaker not recorded", `recorded by ${props.recorder}`, quoteCheckWords(ref.check, ref.why)].join(" · ");
      case "event":
        return "a recorded event";
      case "log-row":
        return `the statecharts' log, ${stampTime(ref.at)}`;
      case "runtime":
        return ref.what;
      case "git":
        return [ref.repo === "workspace" ? "workspace repo" : "project repo", ref.branch, ref.commit?.slice(0, 7)].filter(Boolean).join(" · ");
      case "spec":
        return ref.claim;
      case "validation":
        return `${ref.runner}: ${ref.result}`;
    }
  };
  return (
    <li class="orghist-evidence-row">
      <span class="orghist-evidence-head">
        <span class="orghist-mono">[{r().n}]</span>
        <span>{EVIDENCE_KIND_WORDS[r().kind]}</span>
        <Chip tone={availabilityTone(props.view.availability)}>{availabilityWord(props.view.availability)}</Chip>
      </span>
      <span class="orghist-caption">{detail()}</span>
      <div class="button-row">
        {/* Only a transcript citation has a span to open; it is read now, on request, never with the detail. */}
        <Show when={r().kind === "transcript"}>
          <button type="button" class="button" aria-expanded={open() ? "true" : "false"} aria-busy={opening() ? "true" : undefined} onClick={() => void toggle()}>
            {open() ? "Hide Source" : "Open Source"}
          </button>
        </Show>
        <Show when={source()}>
          {(s) => (
            <a class="button" href={s().href}>
              {s().label}
            </a>
          )}
        </Show>
      </div>
      <Show when={open() && span()}>
        {(v) => (
          <Show
            when={v().availability === "available" && v().quote !== undefined}
            fallback={<p class="orghist-muted">{props.decision ? SOURCE_UNAVAILABLE : availabilityWord(v().availability)}</p>}
          >
            {/* The cited span only, as data: Solid sets it as text, never markup. */}
            <blockquote class="orghist-quote">{v().quote}</blockquote>
          </Show>
        )}
      </Show>
      <Show when={openError()}>{(e) => <p class="field-error">Couldn't open the source: {e()}</p>}</Show>
    </li>
  );
}

/** An actor's label: the server's when it gave one, a roster person's name by id, else the role. */
function authorLabel(a: { kind: string; id?: string; label?: string }, org: OrgDetail): string {
  if (a.label) return a.label;
  if (a.kind === "person" && a.id) return org.roster.find((p) => p.id === a.id)?.name ?? "A person no longer on the roster";
  if (a.kind === "operator") return "Operator";
  if (a.kind === "model") return "A model";
  if (a.kind === "project-overseer" && a.id) return `${org.projectList.find((p) => p.id === a.id)?.name ?? "A project"}'s overseer`;
  return a.kind.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const purgedAt = (d: EventDetail): number | undefined => (d.event.reasonState === "purged" ? d.later.find((l) => l.kind === "rationale.purged")?.recordedAt : undefined);
const canPurge = (d: EventDetail): boolean => !!d.rationale && (d.event.reasonState === "recorded" || d.event.reasonState === "added-later");

/** A refused link, in the spec's words: a link to another org's event is
    one to no such event in this organization. */
const refusedWords = (r: EventDetail["refusedLinks"][number]): string =>
  `${r.as === "triggeredBy" ? "Trigger link" : `${RELATION_WORDS[r.as] ?? r.as} link`} refused: ${r.why === "cycle" ? "it would make a cycle" : "no such event in this organization"}.`.replace(/^./, (c) => c.toUpperCase());

function captureWords(d: EventDetail): string {
  const r = d.record;
  if (!r) return "Not readable by this version";
  if (r.capture.origin === "imported") return `Imported${r.capture.importedAt ? ` ${stampTime(r.capture.importedAt)}` : ""}: the source's time is kept; who and why weren't recorded then.`;
  if (r.capture.origin === "gap") return "A capture gap: history wasn't saved then.";
  return "Captured live";
}
