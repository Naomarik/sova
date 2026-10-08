import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { offHoursNote, reachWords, withOffHours } from "../lib/working-hours";
import { abilitiesOf, MESSAGES_CAP, OPERATOR, type BatonInfo, type OfferLink, type ProposedPerson } from "../../shared/baton";
import type { SessionSummary } from "../../shared/protocol";
import { ApiError, approvePerson, batonLink, closeBaton, declinePerson, extendBaton, getBaton, handBaton, inviteeLink, offerBaton, revokeBatonLink, takeBaton, withdrawOffer } from "../lib/api";
import { LINK_WARNINGS } from "../../shared/public-links";
import { openSettings } from "../lib/settings-nav";
import { goalShown, linkReplaced, linksStale, liveOffer, proposedAreasLine, stripActions, whereLine, wrapupLine } from "../lib/baton-strip";
import { requestListRefresh } from "../lib/list-refresh";
import { useMinuteNow } from "../lib/minute-clock";
import { orgHref, rememberStartParent, startForHref } from "../lib/orgs-route";
import { announce, copyText, toast } from "../lib/ui-state";
import { LinksBanner } from "./LinksBanner";
import { createSendOnWhatsApp, SendOnWhatsAppButtons, SendOnWhatsAppFallback } from "./SendOnWhatsApp";
import { getBatonTold, retryWrapup, setBatonAbilities, setBatonHiddenFromOwner } from "../lib/api";
import { abilityToast } from "../lib/gathering-abilities";
import { firstName } from "../lib/person-page";
import { starterHref, starterName, toldMarkdown, whyText } from "../lib/baton-told";
import { openMarkdown } from "../lib/markdown-viewer";
import { relativeTime } from "../lib/format";
import { DELETE_ASK, DELETE_LINK, LINK_DELETED, LINK_GONE, NEW_LINK_TIP, newLinkFor } from "../lib/link-delete";
import { ActionMenu } from "./ActionMenu";
import { Banner, Chip, CopyButton, Icon } from "./ui";
import "../orgs.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const ABILITY_LABEL = { draw: "Draw", drawHtml: "Interactive drawings (HTML)", readLinks: "Read links", files: "Receive files" } as const;

/** The one width the strip branches on (the design system's folded/unfolded line), measured on the strip itself. */
const NARROW_BELOW = 768;
const CLOSE_ASK = "Every link stops working. The transcript stays in the workspace repo.";

/**
 * Bring a row into view inside the strip, below its pinned top. Only the strip scrolls: the pane
 * around it is overflow:hidden, which scrollIntoView would scroll too and shift the whole pane.
 * `start` puts the row's top under the pinned rows; `nearest` moves only as far as needed.
 */
function revealInStrip(el: HTMLElement, align: "start" | "nearest" = "nearest") {
  const strip = el.closest<HTMLElement>(".baton-strip");
  if (!strip) return;
  const topEl = strip.querySelector<HTMLElement>(".baton-strip-top");
  // A short window unpins the top (orgs.css): then nothing covers the strip's start.
  const pinned = topEl && getComputedStyle(topEl).position === "sticky" ? topEl.offsetHeight : 0;
  const box = strip.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = box.top + pinned + 8;
  const bottom = box.bottom - 8;
  if (align === "start" || r.top < top || r.height > bottom - top) strip.scrollTop += r.top - top;
  else if (r.bottom > bottom) strip.scrollTop += r.bottom - bottom;
}

/**
 * The baton strip (§app/baton) above a baton session's transcript: where the baton is (a person,
 * you, or an offer to several people and who took it), links (minted on demand, and copied again
 * from BatonInfo.links while live and kept), Hand On (to one person, or offered to several), Take Back and
 * Close; people this session proposed for the roster, with Approve and Decline; and the wrap-up's
 * outcome. Profiles never appear here — an outsider could be looking at this screen — so a
 * proposed person shows name, role and why only; contact details are on the org page. `onNames`
 * hands the thread the names its sender tags and cards use.
 *
 * Its shape (§app.baton/strip-layout): a bounded region that scrolls on its own, its head row and
 * bar pinned at the top; one primary act, the rest in a "⋯" menu with the destructive ones last
 * and asked; under 768px the facts fold under Details.
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
  /** Only GET /api/baton says it (an action's answer doesn't), so it is kept apart from `info`. */
  const [noPhotos, setNoPhotos] = createSignal(false);
  const [info, { refetch, mutate }] = createResource(key, (k) =>
    getBaton(k.path).then((i) => {
      setNoPhotos(!!i.noPhotos);
      return i;
    }),
  );
  const now = useMinuteNow();
  /** Links just minted or got, and the hand-off they belong to: they stay until dismissed or a later hand-off. */
  const [shown, setShown] = createSignal<{ links: OfferLink[]; at: number; warning?: string } | null>(null);
  const links = () => shown()?.links ?? null;
  const showLinks = (l: OfferLink[], at: number, warning?: string) => setShown(l.length ? { links: l, at, ...(warning ? { warning } : {}) } : null);
  const [error, setError] = createSignal<string | null>(null);
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

  // Send on WhatsApp (§app.outreach/send-link): the holder, or each reached invitee of an open offer.
  // Its buttons sit in the bar, its fallback in the rows below; one state for both.
  const outreach = createSendOnWhatsApp({
    enabled: () => {
      const i = info.latest;
      return !!i && open(i) && (personHolds(i) || !!liveOffer(i));
    },
    sid: () => info.latest!.session.sessionId,
    version: () => key().v,
    offer: () => !!(info.latest && liveOffer(info.latest)),
    kept: (personId) => info.latest?.links?.[personId]?.link,
    onLink: (personId, name, r) => showLinks([{ personId, name, link: r.link, ...(r.at ? { at: r.at } : {}) }], r.n, r.linkWarning),
    onSent: () => {
      void refetch();
      requestListRefresh();
    },
  });

  // The acts, each a function so the bar, the menu and its confirm screens share one handler.
  /** Get Link (`keep`: the kept live link, if another tab made one meanwhile) or New Link (a new one; the older ones stop). */
  const getLink = (i: BatonInfo, keep: boolean) =>
    void act(
      async () => {
        const r = await batonLink(sid(), keep);
        const holder = i.session.holder!;
        showLinks([{ personId: holder, name: nameOf(i, holder), link: r.link, ...(r.at ? { at: r.at } : {}) }], r.n, r.linkWarning);
      },
      keep ? "Link ready below." : "New link ready below.",
    );
  /** Copy Link: the holder's live kept link, from the strip's own data (synchronous in the click). */
  const copyHolderLink = (i: BatonInfo) => {
    const link = i.links?.[i.session.holder!]?.link;
    if (link) void copyText(link, "Link copied.");
  };
  const takeBack = () => void act(() => takeBaton(sid()), "You hold the baton now.");
  const withdraw = () => void act(() => withdrawOffer(sid()), "Offer withdrawn. The baton is with you.");
  const deleteLink = () => void act(() => revokeBatonLink(sid()), LINK_DELETED);
  const close = () => void act(() => closeBaton(sid()), "Closed. Every link is off. The transcript stays in the workspace repo.");
  /** What It's Told (§app.baton/told): read-only, fetched when opened, at every width. */
  const openTold = () =>
    void getBatonTold(sid())
      .then((t) => {
        setError(null);
        openMarkdown({ title: "What It's Told", subtitle: t.publicTitle, markdown: toldMarkdown(t, Date.now()) });
      })
      .catch((err) => setError(errText(err)));
  /** Hide From / Show To the org's owner (§app.owner-page/controls): this conversation on their page. */
  const toggleOwner = (i: BatonInfo) => {
    const hide = !i.session.hiddenFromOwner;
    const first = firstName(i.owner!.name);
    void act(() => setBatonHiddenFromOwner(sid(), hide), hide ? `Hidden from ${first}'s owner page.` : `Shown on ${first}'s owner page.`);
  };

  // The strip measures its own box (a workspace pane can be narrow in a wide window), and the
  // pinned top's height, so a row scrolled into view lands below it rather than under it.
  const [narrow, setNarrow] = createSignal(false);
  const watchStrip = (el: HTMLElement) => {
    const ro = new ResizeObserver(([e]) => setNarrow(e!.contentRect.width < NARROW_BELOW));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  const watchTop = (el: HTMLElement) => {
    const ro = new ResizeObserver(() => el.parentElement?.style.setProperty("--baton-strip-top", `${el.offsetHeight}px`));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  /** A row that appears because of an act (a minted link, an error) is scrolled to inside the strip. */
  const reveal = (el: HTMLElement) => queueMicrotask(() => revealInStrip(el));
  const abilitiesLabel = createUniqueId();

  return (
    <Show when={info.latest}>
      {(i) => {
        const acts = createMemo(() => stripActions(i()));
        const title = () => i().session.publicTitle;
        /** Org, project, what it can do, who started it: shown from 768px, folded under Details below. */
        const facts = () => (
          <div class="baton-strip-facts">
            <span class="baton-strip-meta">
              {i().orgName} · {i().projectName}
            </span>
            <div class="baton-strip-facts-line">
              {/* What it can do (§app.baton/abilities): from its next reply; the share page never shows it. */}
              <div class="baton-strip-abilities" role="group" aria-labelledby={abilitiesLabel}>
                <span id={abilitiesLabel} class="baton-strip-abilities-label">
                  It can:
                </span>
                {/* Interactive drawings count only with Draw, so its box sits right after Draw and waits for
                    it. The boxes wrap as their own group, so a wrapped box lines up under Draw. */}
                <span class="baton-strip-abilities-boxes">
                  <For each={["draw", "drawHtml", "readLinks", "files"] as const}>
                    {(k) => (
                      <label class="toggle" classList={{ "baton-strip-ability-dependent": k === "drawHtml" }}>
                        <input
                          type="checkbox"
                          disabled={!open(i()) || (k === "drawHtml" && !abilitiesOf(i().session).draw)}
                          checked={abilitiesOf(i().session)[k] === true}
                          onChange={(e) => {
                            const el = e.currentTarget;
                            const on = el.checked;
                            void act(() => setBatonAbilities(sid(), { [k]: on }), abilityToast(k, on)).then((ok) => ok || (el.checked = !on));
                          }}
                        />
                        <span class="toggle-box" />
                        <span>{ABILITY_LABEL[k]}</span>
                      </label>
                    )}
                  </For>
                </span>
              </div>
              {/* Who started it, and when (§app.baton/told): always there; the overseer part links to it. */}
              <span class="baton-strip-meta baton-strip-started">
                Started by{" "}
                <Show when={starterHref(i().started, i().session.projectId)} fallback={starterName(i().started, i().projectName)}>
                  {(href) => <a href={href()}>{starterName(i().started, i().projectName)}</a>}
                </Show>{" "}
                · {relativeTime(i().started.at, now())}
              </span>
            </div>
            {/* Photos are on, but this model can't see them (§app.baton/images). */}
            <Show when={noPhotos() && open(i())}>
              <span class="baton-strip-meta">This model can't see photos: people won't get an attach button.</span>
            </Show>
          </div>
        );
        return (
          <section class="baton-strip" aria-label="Hand-off session" ref={watchStrip}>
            <div class="baton-strip-top" ref={watchTop}>
              {/* The session head right above already shows the title; the strip repeats it only
                  when the session was renamed, so the public title (what they see) stays in view. */}
              <Show when={props.summary()?.title !== title()}>
                <span class="baton-strip-title">
                  <span class="visually-hidden">Public title: </span>
                  {title()}
                </span>
              </Show>
              <div class="baton-strip-head">
                <Chip tone={i().session.state === "needs-you" ? "warn" : i().session.state === "done" ? "success" : i().session.state === "open" ? "info" : undefined}>
                  {i().session.state === "needs-you" ? "Needs you" : i().session.state === "open" ? (liveOffer(i()) ? "Offered" : "Open") : i().session.state === "done" ? "Done" : "Closed"}
                </Chip>
                <span class="baton-strip-where" title={whereLine(i(), now())}>
                  {whereLine(i(), now())}
                </span>
                <span class="baton-strip-count">
                  {i().session.budget.messagesUsed} of {i().session.budget.messagesMax} messages
                </span>
              </div>
              <div class="baton-strip-bar">
                <Switch>
                  <Match when={acts().primary === "take-back"}>
                    <button type="button" class="button button-primary" onClick={takeBack}>
                      Take Back
                    </button>
                  </Match>
                  <Match when={acts().primary === "withdraw"}>
                    <button type="button" class="button button-primary" title="Every invitee's link stops working and the baton comes back to you." onClick={withdraw}>
                      Withdraw Offer
                    </button>
                  </Match>
                  <Match when={acts().primary === "hand-on"}>
                    <button type="button" class="button button-primary" aria-expanded={handing() !== null} onClick={() => setHanding(handing() === null ? [] : null)}>
                      Hand On…
                    </button>
                  </Match>
                </Switch>
                {/* The holder's one Send stays in the bar; an offer's, one per invitee, would fill the
                    pinned rows, so they sit with the invitees' links below. */}
                <Show when={!liveOffer(i())}>
                  <SendOnWhatsAppButtons s={outreach} />
                </Show>
                <span class="baton-strip-bar-end">
                  <ActionMenu label={`More actions · ${title()}`} title="More actions">
                    {(menu) => (
                      <Switch
                        fallback={
                          <div class="model-menu-list" role="menu" aria-label={`More actions · ${title()}`}>
                            <div class="model-menu-group" role="group" aria-label="This session">
                              <Show when={acts().menu.includes("copy-link")}>
                                <menu.Item
                                  label="Copy Link"
                                  aria={`Copy the link for ${nameOf(i(), i().session.holder!)} · ${title()}`}
                                  icon={<Icon name="copy" small />}
                                  onRun={() => copyHolderLink(i())}
                                />
                              </Show>
                              <Show when={acts().menu.includes("get-link")}>
                                <menu.Item
                                  label="Get Link"
                                  aria={`Get a link for ${nameOf(i(), i().session.holder!)} · ${title()}`}
                                  icon={<Icon name="share" small />}
                                  onRun={() => getLink(i(), true)}
                                />
                              </Show>
                              <Show when={acts().menu.includes("new-link")}>
                                <menu.Item
                                  label="New Link"
                                  aria={`New link for ${nameOf(i(), i().session.holder!)} · ${title()}`}
                                  description={NEW_LINK_TIP}
                                  icon={<Icon name="refresh" small />}
                                  onRun={() => getLink(i(), false)}
                                />
                              </Show>
                              <Show when={acts().menu.includes("hand-on")}>
                                <menu.Item label="Hand On…" aria={`Hand on ${title()}`} icon={<Icon name="arrow-right" small />} onRun={() => setHanding(handing() ?? [])} />
                              </Show>
                              <menu.Item label="What It's Told" aria={`What ${title()} is told`} icon={<Icon name="file" small />} keepFocus onRun={openTold} />
                              <Show when={acts().menu.includes("owner") && i().owner}>
                                {(o) => (
                                  <menu.Item
                                    label={i().session.hiddenFromOwner ? `Show To ${firstName(o().name)}` : `Hide From ${firstName(o().name)}`}
                                    aria={`${i().session.hiddenFromOwner ? `Show to ${firstName(o().name)}` : `Hide from ${firstName(o().name)}`} · ${title()}`}
                                    icon={<Icon name="eye" small />}
                                    onRun={() => toggleOwner(i())}
                                  />
                                )}
                              </Show>
                            </div>
                            {/* Destructive, last, set apart, and never one press: each asks on a screen of its own. */}
                            <Show when={acts().destructive.length > 0}>
                              <div class="model-menu-group baton-strip-menu-danger" role="group" aria-label="Can't be undone">
                                <Show when={acts().destructive.includes("delete-link")}>
                                  <menu.Item label={DELETE_LINK} aria={`Delete the link for ${title()}`} icon={<Icon name="trash" small />} stayOpen onRun={() => menu.show("delete-link")} />
                                </Show>
                                <Show when={acts().destructive.includes("close")}>
                                  <menu.Item label="Close Session" aria={`Close ${title()}`} icon={<Icon name="close" small />} stayOpen onRun={() => menu.show("close")} />
                                </Show>
                              </div>
                            </Show>
                          </div>
                        }
                      >
                        <Match when={menu.screen() === "delete-link"}>
                          <div class="group-menu-screen" role="group" aria-label={`Delete the link for ${title()}`}>
                            <p class="group-tools-question">{LINK_GONE}</p>
                            <div class="cluster">
                              <button type="button" class="button button-destructive" onClick={() => menu.run(deleteLink)}>
                                {DELETE_ASK}
                              </button>
                              <button type="button" class="button button-ghost" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => menu.dismiss()}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </Match>
                        <Match when={menu.screen() === "close"}>
                          <div class="group-menu-screen" role="group" aria-label={`Close ${title()}`}>
                            <p class="group-tools-question">{CLOSE_ASK}</p>
                            <div class="cluster">
                              <button type="button" class="button button-destructive" onClick={() => menu.run(close)}>
                                Close — Links Stop Working
                              </button>
                              <button type="button" class="button button-ghost" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => menu.dismiss()}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </Match>
                      </Switch>
                    )}
                  </ActionMenu>
                </span>
              </div>
            </div>
            <Show when={narrow()} fallback={facts()}>
              <details class="disclosure baton-strip-fold">
                <summary class="disclosure-summary">
                  <Icon name="chevron-right" small class="icon-twist" />
                  <span class="disclosure-label">Details</span>
                </summary>
                <div class="disclosure-body">{facts()}</div>
              </details>
            </Show>
            {/* Why it was started, and its goal: folded on every open, no preview — someone may be
                looking at this screen with the operator. Neither leaves the operator app (§app.baton/goal-on-strip). */}
            <details class="disclosure baton-strip-fold baton-strip-goal">
              <summary class="disclosure-summary">
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="disclosure-label">Why and goal</span>
              </summary>
              <div class="disclosure-body">
                <p class="baton-strip-goal-label">Why</p>
                <p class="baton-strip-goal-text">{whyText(i().started)}</p>
                <Show when={goalShown(i().session)}>
                  {(g) => (
                    <>
                      <p class="baton-strip-goal-label">Goal</p>
                      <GoalText text={g()} />
                    </>
                  )}
                </Show>
                <p class="baton-strip-goal-note">Only you see this. It's never on their page.</p>
                <div>
                  <button type="button" class="button button-sm button-ghost" onClick={openTold}>
                    What It's Told
                  </button>
                </div>
              </div>
            </details>
            <Show when={i().owner && i().session.hiddenFromOwner}>
              <p class="baton-strip-areas">Hidden from {firstName(i().owner!.name)}'s owner page.</p>
            </Show>
            <Show when={error()}>
              {(e) => (
                <div class="baton-strip-link" ref={reveal}>
                  <Banner tone="error" title="That didn't go through." body={e()} />
                </div>
              )}
            </Show>
            <Show when={links()}>
              {(l) => (
                <div class="baton-strip-link" ref={reveal}>
                  <LinksBanner links={l()} warning={shown()?.warning} replaced={(link) => linkReplaced(link, info.latest)} onDismiss={() => setShown(null)} />
                </div>
              )}
            </Show>
            <Show when={open(i()) && spent(i())}>
              <ExtendRow info={i()} act={act} />
            </Show>
            <Show when={open(i()) && !i().share.publicUrl && (personHolds(i()) || liveOffer(i()))}>
              <div class="baton-strip-link">
                <Banner
                  tone="warn"
                  title={LINK_WARNINGS.off}
                  action={
                    <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("public-links")}>
                      Open Settings
                    </button>
                  }
                />
              </div>
            </Show>
            <SendOnWhatsAppFallback s={outreach} />
            <Show when={liveOffer(i())}>
              {(o) => {
                // r12: an invitee is reached (their link made) only in their own working hours; a waiting one has no link yet.
                const reached = () => o().to.filter((p) => p.reach?.state !== "waiting");
                const waiting = () => o().to.filter((p) => p.reach?.state === "waiting");
                // Each reached invitee whose live link is kept: Copy Link from the strip's own data (§app.baton/links).
                const copyable = () => reached().filter((p) => i().links?.[p.id]);
                return (
                  <>
                    <Show when={copyable().length > 0}>
                      <div class="baton-strip-row baton-strip-invitees" role="group" aria-label="Invitees' links to copy">
                        <span class="baton-strip-meta">Copy link for</span>
                        <For each={copyable()}>
                          {(p) => <CopyButton label={p.name} title={`Copy ${p.name}'s link`} text={() => i().links?.[p.id]?.link ?? ""} onCopy={(t) => copyText(t, "Link copied.")} />}
                        </For>
                      </div>
                    </Show>
                    <Show when={reached().length > 0}>
                      <div class="baton-strip-row baton-strip-invitees" role="group" aria-label="Invitees' links">
                        <span class="baton-strip-meta">{waiting().length ? "Reached · new link for" : "New link for"}</span>
                        <For each={reached()}>
                          {(p) => (
                            <button
                              type="button"
                              class="button button-sm button-ghost"
                              title={newLinkFor(p.name)}
                              onClick={() =>
                                void act(async () => {
                                  const r = await inviteeLink(sid(), p.id);
                                  showLinks([{ personId: p.id, name: p.name, link: r.link, ...(r.at ? { at: r.at } : {}) }], r.n, r.linkWarning);
                                }, `New link for ${p.name} ready below.`)
                              }
                            >
                              {p.name}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={outreach.people().length > 0}>
                      <div class="baton-strip-row" role="group" aria-label="Send on WhatsApp">
                        <SendOnWhatsAppButtons s={outreach} />
                      </div>
                    </Show>
                    <Show when={waiting().length > 0}>
                      <ul class="baton-strip-waiting" aria-label="Invitees not reached yet">
                        <For each={waiting()}>
                          {(p) => (
                            <li class="baton-strip-meta">
                              {p.name} · {reachWords(p.reach, o().holder?.name, now())}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </>
                );
              }}
            </Show>
            <Show when={handing()} keyed>
              {(pre) => (
                <HandOnForm
                  info={i()}
                  preselected={pre}
                  onCancel={() => setHanding(null)}
                  onDone={(l, msg, info, to, warning) => {
                    setHanding(null);
                    if (info) mutate(info);
                    showLinks(l, info?.session.handoffs.length ?? (i().session.handoffs.length + 1), warning);
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
          </section>
        );
      }}
    </Show>
  );
}

/**
 * The goal as written, at most 8 lines until asked for the rest. Show Full Goal appears only when
 * the clamped text is measured to overflow — on open, and whenever its box changes size.
 */
function GoalText(props: { text: string }) {
  const id = createUniqueId();
  const [full, setFull] = createSignal(false);
  const [over, setOver] = createSignal(false);
  let el!: HTMLParagraphElement;
  const measure = () => full() || setOver(el.scrollHeight > el.clientHeight + 1);
  onMount(() => {
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  createEffect(on(() => props.text, () => queueMicrotask(measure)));
  return (
    <>
      <p ref={el} id={id} class="baton-strip-goal-text" classList={{ "baton-strip-goal-clamped": !full() }}>
        {props.text}
      </p>
      <Show when={over()}>
        <div>
          <button type="button" class="button button-sm button-ghost" aria-controls={id} aria-expanded={full()} onClick={() => setFull(!full())}>
            {full() ? "Show Less" : "Show Full Goal"}
          </button>
        </div>
      </Show>
    </>
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
  onDone(links: OfferLink[], message: string, info: BatonInfo | undefined, to: string[], warning?: string): void;
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
        props.onDone(r.link ? [{ personId: who, name: nameOf(who), link: r.link, ...(r.at ? { at: r.at } : {}) }] : [], withOffHours(`Handed to ${nameOf(who)}.`, nameOf(who), r.offHours, Date.now()), r.info, [who], r.linkWarning);
      } else {
        const r = await offerBaton(sid, to(), question().trim(), briefing().trim() || undefined);
        props.onDone(r.links, `Offered to ${to().length} people. The first to answer takes it.`, r.info, to(), r.linkWarning);
      }
    } catch (err) {
      setError(`${errText(err).replace(/\.$/, "")}. Nothing was sent.`);
    } finally {
      setBusy(false);
    }
  };
  // Opened below the strip's fold (from the bar, the menu or an approved row): brought into view
  // inside the strip, below its pinned top, so it isn't opened out of sight.
  let form!: HTMLFormElement;
  onMount(() => queueMicrotask(() => revealInStrip(form, "start")));
  return (
    <form ref={form} class="orgs-form baton-strip-form" onSubmit={submit}>
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
        {/* r7: yours goes at once; say so for each ticked person who is off hours now. */}
        <For each={props.info.active.filter((p) => to().includes(p.id))}>
          {(p) => <Show when={offHoursNote(p, Date.now())}>{(note) => <p class="field-hint person-off-hours">{note()}</p>}</Show>}
        </For>
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
