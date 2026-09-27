import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { MESSAGES_CAP, OPERATOR, type BatonInfo, type OfferLink, type ProposedPerson } from "../../shared/baton";
import type { SessionSummary } from "../../shared/protocol";
import { ApiError, approvePerson, batonLink, closeBaton, declinePerson, extendBaton, getBaton, handBaton, inviteeLink, offerBaton, revokeBatonLink, takeBaton, withdrawOffer } from "../lib/api";
import { linkReplaced, linksStale, liveOffer, proposedAreasLine, whereLine, wrapupLine } from "../lib/baton-strip";
import { requestListRefresh } from "../lib/list-refresh";
import { confirmActivate } from "../lib/confirm-step";
import { useMinuteNow } from "../lib/minute-clock";
import { orgHref, rememberStartParent, startForHref } from "../lib/orgs-route";
import { announce, toast } from "../lib/ui-state";
import { LinksBanner } from "./LinksBanner";
import { createMemo, onCleanup } from "solid-js";
import { retryWrapup } from "../lib/api";
import { Banner, Chip } from "./ui";
import "../orgs.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * The baton strip (§app/baton) above a baton session's transcript: where the baton is (a person,
 * you, or an offer to several people and who took it), links (minted on demand — the host keeps
 * no token it could show again), Hand On (to one person, or offered to several), Take Back and
 * Close; people this session proposed for the roster, with Approve and Decline; and the wrap-up's
 * outcome. Profiles never appear here — an outsider could be looking at this screen — so a
 * proposed person shows name, role and why only; contact details are on the org page. `onNames`
 * hands the thread the names its sender tags and cards use.
 */
export function BatonStrip(props: {
  path: string;
  summary: () => SessionSummary | undefined;
  onNames(names: Record<string, string>): void;
  /** Whether the operator holds the baton, after every read (the composer's gate). */
  onOperatorHolds?(mine: boolean): void;
}) {
  // Re-read whenever the list's baton field moves (a hand-off, a reply, a claim, done).
  const key = () => ({ path: props.path, v: JSON.stringify(props.summary()?.baton ?? null) });
  const [info, { refetch, mutate }] = createResource(key, (k) => getBaton(k.path));
  const now = useMinuteNow();
  /** Links shown once, and the hand-off they belong to: they stay until dismissed or a later hand-off. */
  const [shown, setShown] = createSignal<{ links: OfferLink[]; at: number } | null>(null);
  const links = () => shown()?.links ?? null;
  const showLinks = (l: OfferLink[], at: number) => setShown(l.length ? { links: l, at } : null);
  const [error, setError] = createSignal<string | null>(null);
  const [closeArmed, setCloseArmed] = createSignal(false);
  const [handing, setHanding] = createSignal<string[] | null>(null);
  const [approved, setApproved] = createSignal<{ id: string; name: string }[]>([]);
  createEffect(
    on(info, (i) => {
      if (!i) return;
      props.onNames(i.names);
      props.onOperatorHolds?.(i.session.holder === OPERATOR);
    }),
  );
  createEffect(on(() => info.latest?.session.handoffs.length, (count) => linksStale(shown()?.at ?? null, count) && setShown(null)));
  // A wrap-up's end moves nothing the list carries: while one runs, read again until it has ended.
  const wrapupState = createMemo(() => info.latest?.session.wrapup?.state);
  createEffect(() => {
    if (wrapupState() !== "running") return;
    const t = setInterval(() => void refetch(), 5000);
    onCleanup(() => clearInterval(t));
  });
  const [retrying, setRetrying] = createSignal(false);
  const act = async (fn: () => Promise<unknown>, done: string | ((r: unknown) => string)): Promise<boolean> => {
    try {
      const r = await fn();
      if (r && typeof r === "object" && "session" in r) mutate(r as BatonInfo);
      setError(null);
      const said = typeof done === "string" ? done : done(r);
      toast(said);
      announce(said);
      await refetch();
      requestListRefresh();
      return true;
    } catch (err) {
      setError(errText(err));
      return false;
    }
  };
  const sid = () => info()!.session.sessionId;
  const personHolds = (i: BatonInfo) => i.session.holder !== null && i.session.holder !== OPERATOR;
  const open = (i: BatonInfo) => i.session.state === "open" || i.session.state === "needs-you";
  const nameOf = (i: BatonInfo, id: string) => i.names[id] ?? "someone";
  const spent = (i: BatonInfo) => i.session.budget.messagesUsed >= i.session.budget.messagesMax;
  return (
    <Show when={info.latest}>
      {(i) => (
        <section class="baton-strip" aria-label="Hand-off session">
          <div class="baton-strip-main">
            {/* The session head right above already shows the title; the strip repeats it only
                when the session was renamed, so the public title (what they see) stays in view. */}
            <Show when={props.summary()?.title !== i().session.publicTitle}>
              <span class="baton-strip-title">
                <span class="visually-hidden">Public title: </span>
                {i().session.publicTitle}
              </span>
            </Show>
            <span class="baton-strip-meta">
              {i().orgName} · {i().projectName} · {whereLine(i(), now())} · {i().session.budget.messagesUsed} of {i().session.budget.messagesMax} messages
            </span>
          </div>
          <Chip tone={i().session.state === "needs-you" ? "warn" : i().session.state === "done" ? "success" : i().session.state === "open" ? "info" : undefined}>
            {i().session.state === "needs-you" ? "Needs you" : i().session.state === "open" ? (liveOffer(i()) ? "Offered" : "Open") : i().session.state === "done" ? "Done" : "Closed"}
          </Chip>
          <div class="baton-strip-actions">
            <Show when={open(i()) && personHolds(i()) && !liveOffer(i())}>
              <button
                type="button"
                class="button button-sm"
                title={i().liveLinks ? "Makes a new link and turns off the one you sent before" : undefined}
                onClick={() =>
                  void act(async () => {
                    const r = await batonLink(sid());
                    const holder = i().session.holder!;
                    showLinks([{ personId: holder, name: nameOf(i(), holder), link: r.link, ...(r.at ? { at: r.at } : {}) }], r.n);
                  }, "New link ready below.")
                }
              >
                {i().liveLinks ? "New Link" : "Get Link"}
              </button>
              <Show when={i().liveLinks > 0}>
                <button type="button" class="button button-sm button-ghost" onClick={() => void act(() => revokeBatonLink(sid()), "Link turned off.")}>
                  Turn Off Link
                </button>
              </Show>
              <button type="button" class="button button-sm" onClick={() => void act(() => takeBaton(sid()), "You hold the baton now.")}>
                Take Back
              </button>
            </Show>
            <Show when={liveOffer(i())}>
              <button
                type="button"
                class="button button-sm"
                title="Every invitee's link stops working and the baton comes back to you."
                onClick={() => void act(() => withdrawOffer(sid()), "Offer withdrawn. The baton is with you.")}
              >
                Withdraw Offer
              </button>
            </Show>
            <Show when={open(i())}>
              <button type="button" class="button button-sm" aria-expanded={handing() !== null} onClick={() => setHanding(handing() === null ? [] : null)}>
                Hand On…
              </button>
            </Show>
            <Show when={i().session.state !== "closed"}>
              <button
                type="button"
                class="button button-sm button-destructive"
                title={closeArmed() ? "Every link stops working. The transcript stays in the workspace repo." : undefined}
                onClick={() => {
                  const step = confirmActivate(closeArmed());
                  setCloseArmed(step.armed);
                  if (step.run) void act(() => closeBaton(sid()), "Closed. Every link is off. The transcript stays in the workspace repo.");
                }}
                onBlur={() => setCloseArmed(false)}
              >
                {closeArmed() ? "Close — Links Stop Working" : "Close Session"}
              </button>
            </Show>
          </div>
          <Show when={open(i()) && spent(i())}>
            <ExtendRow info={i()} act={act} />
          </Show>
          <Show when={open(i()) && !i().share.publicUrl && (personHolds(i()) || liveOffer(i()))}>
            <div class="baton-strip-link">
              <Banner
                tone="warn"
                title="Links from this host can't be opened from outside."
                body="No share listener is running here. Set SOVA_SHARE_HOST and SOVA_SHARE_PORT (and SOVA_SHARE_PUBLIC_URL behind a proxy), then restart Sova."
              />
            </div>
          </Show>
          <Show when={liveOffer(i())}>
            {(o) => (
              <div class="baton-strip-row baton-strip-invitees" role="group" aria-label="Invitees' links">
                <span class="baton-strip-meta">New link for</span>
                <For each={o().to}>
                  {(p) => (
                    <button
                      type="button"
                      class="button button-sm button-ghost"
                      title={`Makes a new link for ${p.name} and turns off their older one`}
                      onClick={() =>
                        void act(async () => {
                          const r = await inviteeLink(sid(), p.id);
                          showLinks([{ personId: p.id, name: p.name, link: r.link, ...(r.at ? { at: r.at } : {}) }], r.n);
                        }, `New link for ${p.name} ready below.`)
                      }
                    >
                      {p.name}
                    </button>
                  )}
                </For>
              </div>
            )}
          </Show>
          <Show when={handing()} keyed>
            {(pre) => (
              <HandOnForm
                info={i()}
                preselected={pre}
                onCancel={() => setHanding(null)}
                onDone={(l, msg, info, to) => {
                  setHanding(null);
                  if (info) mutate(info);
                  showLinks(l, info?.session.handoffs.length ?? (i().session.handoffs.length + 1));
                  // Handed to someone just approved: their "is on the roster now" row has done its job.
                  setApproved((a) => a.filter((x) => !to.includes(x.id)));
                  toast(msg);
                  announce(msg);
                  void refetch();
                  requestListRefresh();
                }}
              />
            )}
          </Show>
          <For each={i().proposed}>
            {(p) => (
              <ProposalCard
                person={p}
                orgId={i().session.orgId}
                act={act}
                onApproved={() => setApproved((a) => [...a.filter((x) => x.id !== p.id), { id: p.id, name: p.name }])}
              />
            )}
          </For>
          <For each={approved()}>
            {(a) => (
              <div class="baton-strip-row baton-strip-card">
                <span class="baton-strip-card-main">{a.name} is on the roster now.</span>
                <Show when={open(i())}>
                  <button type="button" class="button button-sm" onClick={() => setHanding([a.id])}>
                    Hand This Session to {a.name}
                  </button>
                </Show>
                <a
                  class="button button-sm button-ghost"
                  href={startForHref(i().session.orgId, a.id)}
                  onClick={() => rememberStartParent(i().session.orgId, a.id, i().session.sessionId)}
                >
                  Start a Session for {a.name}
                </a>
                <button type="button" class="button button-sm button-ghost" aria-label={`Dismiss: ${a.name} is on the roster now`} onClick={() => setApproved((x) => x.filter((y) => y.id !== a.id))}>
                  Dismiss
                </button>
              </div>
            )}
          </For>
          <Show when={i().wrapup}>
            {(w) => (
              <div class="baton-strip-row">
                <span class="baton-strip-meta">
                  {wrapupLine(w()).text}{" "}
                  <Show when={wrapupLine(w()).review}>
                    <a href={orgHref(i().session.orgId)}>Review or Revert</a>
                  </Show>
                </span>
                <Show when={w().state === "failed"}>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    disabled={retrying()}
                    onClick={() => {
                      setRetrying(true);
                      void act(() => retryWrapup(sid()), "Wrap-up started again.").finally(() => setRetrying(false));
                    }}
                  >
                    Retry Wrap-Up
                  </button>
                </Show>
              </div>
            )}
          </Show>
          <Show when={links()}>
            {(l) => (
              <div class="baton-strip-link">
                <LinksBanner links={l()} replaced={(link) => linkReplaced(link, info.latest)} onDismiss={() => setShown(null)} />
              </div>
            )}
          </Show>
          <Show when={error()}>
            {(e) => (
              <div class="baton-strip-link">
                <Banner tone="error" title="That didn't go through." body={e()} />
              </div>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
}

/** At the message limit: raise it by N so the conversation can go on (bounded like any limit). */
function ExtendRow(props: { info: BatonInfo; act(fn: () => Promise<unknown>, done: string | ((r: unknown) => string)): Promise<boolean> }) {
  const room = () => MESSAGES_CAP - props.info.session.budget.messagesMax;
  const [by, setBy] = createSignal(20);
  const valid = () => Number.isInteger(by()) && by() >= 1 && by() <= room();
  return (
    <div class="baton-strip-row baton-strip-card" role="group" aria-label="Message limit reached">
      <span class="baton-strip-card-main">
        The message limit is reached ({props.info.session.budget.messagesUsed} of {props.info.session.budget.messagesMax}).{" "}
        {room() > 0 ? "Extend it to go on." : `That is the most a conversation can have (${MESSAGES_CAP.toLocaleString("en-US")}).`}
      </span>
      <Show when={room() > 0}>
        <label class="baton-strip-meta">
          Extend by{" "}
          <input
            class="input input-sm baton-extend-input"
            type="number"
            min="1"
            max={room()}
            step="1"
            value={by()}
            aria-invalid={!valid()}
            onInput={(e) => setBy(e.currentTarget.valueAsNumber)}
          />
        </label>
        <button
          type="button"
          class="button button-sm"
          disabled={!valid()}
          onClick={() => void props.act(() => extendBaton(props.info.session.sessionId, by()), (r) => `Limit raised to ${(r as BatonInfo).session.budget.messagesMax} messages.`)}
        >
          Extend
        </button>
      </Show>
    </div>
  );
}

/** A person this session proposed for the roster: Approve or Decline. No contact here, and no quote
    either — the referrer's words usually carry the contact (see the strip); both are on the org page. */
function ProposalCard(props: { person: ProposedPerson; orgId: string; act(fn: () => Promise<unknown>, done: string): Promise<boolean>; onApproved(): void }) {
  const p = () => props.person;
  return (
    <div class="baton-strip-row baton-strip-card" role="group" aria-label={`Proposed for the roster: ${p().name}`}>
      <div class="baton-strip-card-main">
        <span class="baton-strip-title">
          Approve {p().name}
          {p().role ? ` (${p().role})` : ""}, proposed by {p().referredBy}?
        </span>
        <span class="baton-strip-meta">{p().why}</span>
        <Show when={proposedAreasLine(p().name, p().decides)}>{(line) => <span class="baton-strip-areas">{line()}</span>}</Show>
      </div>
      <button
        type="button"
        class="button button-sm"
        onClick={async () => {
          if (await props.act(() => approvePerson(props.orgId, p().id), `${p().name} is on the roster now.`)) props.onApproved();
        }}
      >
        Approve
      </button>
      <button type="button" class="button button-sm button-ghost" onClick={() => void props.act(() => declinePerson(props.orgId, p().id), `Declined ${p().name}. The referral stays in their history.`)}>
        Decline
      </button>
      <a class="button button-sm button-ghost" href={orgHref(props.orgId)}>
        Contact Details
      </a>
    </div>
  );
}

/** Hand the session on: to one person (a hand-off) or to several (an offer: the first to answer takes it). */
function HandOnForm(props: {
  info: BatonInfo;
  preselected: string[];
  onCancel(): void;
  /** What the server answered: the links to show once, the fresh info when it sent one, and who it went to. */
  onDone(links: OfferLink[], message: string, info: BatonInfo | undefined, to: string[]): void;
}) {
  const [to, setTo] = createSignal<string[]>(props.preselected);
  const [question, setQuestion] = createSignal("");
  const [briefing, setBriefing] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const sid = props.info.session.sessionId;
  const nameOf = (id: string) => props.info.active.find((p) => p.id === id)?.name ?? props.info.names[id] ?? "them";
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy() || !to().length || !question().trim()) return;
    setBusy(true);
    try {
      if (to().length === 1) {
        const who = to()[0]!;
        const r = await handBaton(sid, who, question().trim(), briefing().trim() || undefined);
        props.onDone(r.link ? [{ personId: who, name: nameOf(who), link: r.link, ...(r.at ? { at: r.at } : {}) }] : [], `Handed to ${nameOf(who)}.`, r.info, [who]);
      } else {
        const r = await offerBaton(sid, to(), question().trim(), briefing().trim() || undefined);
        props.onDone(r.links, `Offered to ${to().length} people. The first to answer takes it.`, r.info, to());
      }
    } catch (err) {
      setError(`${errText(err).replace(/\.$/, "")}. Nothing was sent.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="orgs-form baton-strip-form" onSubmit={submit}>
      <fieldset class="baton-strip-people">
        <legend class="field-label">Hand to</legend>
        <For each={props.info.active}>
          {(p) => (
            <label class="toggle">
              <input type="checkbox" checked={to().includes(p.id)} onChange={(e) => setTo((cur) => (e.currentTarget.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))} />
              <span class="toggle-box" />
              <span>{`${p.name}${p.role ? ` — ${p.role}` : ""}`}</span>
            </label>
          )}
        </For>
        <p class="field-hint">Pick 2 or more to offer it: the first to answer takes it, for as long as they keep answering.</p>
      </fieldset>
      <label class="field">
        <span class="field-label">Question</span>
        <input class="input" value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxlength={1000} required />
      </label>
      <label class="field">
        <span class="field-label">Briefing</span>
        <textarea class="input textarea" rows={2} maxlength={2000} value={briefing()} onInput={(e) => setBriefing(e.currentTarget.value)} />
        <span class="field-hint">What they need to know. Only they see it.</span>
      </label>
      <Show when={error()}>
        {(e) => (
          <p class="field-error" role="alert">
            {e()}
          </p>
        )}
      </Show>
      <div class="button-row">
        <button type="submit" class="button button-primary" aria-disabled={busy() || !to().length || !question().trim() ? "true" : undefined}>
          {to().length > 1 ? `Offer to ${to().length}` : to().length === 1 ? `Hand to ${nameOf(to()[0]!)}` : "Hand On"}
        </button>
        <button type="button" class="button button-ghost" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
