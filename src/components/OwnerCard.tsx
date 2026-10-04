import { createMemo, createSignal, onMount, Show, For } from "solid-js";
import { Portal } from "solid-js/web";
import type { OfferLink } from "../../shared/baton";
import type { OrgDetail } from "../../shared/orgs";
import { ApiError, ownerLink, previewOwnerPage, revokeOwnerLink, setOrgOwner } from "../lib/api";
import { useMinuteNow } from "../lib/minute-clock";
import { DELETE_OWNER_LINK, DELETE_OWNER_LINK_FOR_GOOD, OWNER_LINK_DELETED } from "../lib/link-delete";
import { deleteOwnerLine, ownerChangeLine, ownerLinkLine, rotateLine } from "../lib/owner-card";
import { ownerHash, type OwnerRoute } from "../lib/owner-words";
import { firstName } from "../lib/person-page";
import { announce } from "../lib/ui-state";
import { type OwnerAnswer, OwnerLoadError, OwnerPage } from "../share/owner-view";
import { LinksBanner } from "./LinksBanner";
import { Banner, Icon, trapFocus } from "./ui";
import "../person.css";
import "../share/owner.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const NONE = "";

type Act = (fn: () => Promise<OrgDetail | unknown>, done?: string) => Promise<boolean>;

/**
 * The owner card on the People tab (§app.owner-page/owner, /link, /preview): who the org's owner is
 * (an active roster person, or None), their owner link (minted on demand and shown once: the host
 * keeps only its hash), Delete Owner Link, and the preview of their page.
 */
export function OwnerCard(props: { org: OrgDetail; act: Act }) {
  const now = useMinuteNow();
  const info = () => props.org.ownerPage;
  const owner = () => info()?.person ?? null;
  const active = createMemo(() => props.org.roster.filter((p) => p.status === "active"));
  const [saving, setSaving] = createSignal(false);
  const [shown, setShown] = createSignal<{ link: OfferLink; warning?: string } | null>(null);
  /** The confirm open under the buttons: rotate a live link, or delete it. */
  const [confirm, setConfirm] = createSignal<"rotate" | "off" | null>(null);
  const [previewing, setPreviewing] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  let select: HTMLSelectElement | undefined;
  const live = () => info()?.link?.state === "live";
  const line = () => ownerLinkLine(info(), now());

  const setOwner = async (id: string | null) => {
    if (saving()) return;
    setSaving(true);
    const name = id ? (props.org.roster.find((p) => p.id === id)?.name ?? "") : "";
    const done = id ? `${name} is the owner now.` : "This organization has no owner now.";
    try {
      const next = await setOrgOwner(props.org.id, id);
      setErr(null);
      setShown(null);
      setConfirm(null);
      await props.act(async () => next, done);
      announce(done);
    } catch (x) {
      setErr(errText(x));
      if (select) select.value = owner()?.id ?? NONE;
    } finally {
      setSaving(false);
    }
  };

  const getLink = async () => {
    const o = owner();
    setConfirm(null);
    if (!o) return;
    try {
      const r = await ownerLink(props.org.id);
      setShown({ link: { personId: o.id, name: o.name, link: r.link, at: r.createdAt }, ...(r.linkWarning ? { warning: r.linkWarning } : {}) });
      setErr(null);
      await props.act(async () => undefined);
      announce(`${o.name}'s owner link is ready below.`);
    } catch (x) {
      setErr(errText(x));
    }
  };

  const deleteLink = async () => {
    setConfirm(null);
    const ok = await props.act(() => revokeOwnerLink(props.org.id), OWNER_LINK_DELETED);
    if (ok) setShown(null);
  };

  return (
    <section class="card orgs-section" aria-labelledby="orgs-owner">
      <h2 class="orgs-h2" id="orgs-owner">
        Owner
      </h2>
      <p class="orgs-line project-muted" id="orgs-owner-hint">
        The owner follows every project on one page: the overseer's updates, who was asked, what was decided, and each conversation. They can read it, not change it.
      </p>
      <Show when={!owner() && props.org.ownerCleared}>
        {(c) => <Banner tone="warn" title={`${c().name} left the organization, so it has no owner now. Their owner link stopped working.`} />}
      </Show>
      <label class="field orgs-owner-field">
        <span class="field-label">Owner</span>
        <select ref={select} class="select" aria-describedby="orgs-owner-hint" disabled={saving()} onChange={(e) => void setOwner(e.currentTarget.value || null)}>
          <option value={NONE} selected={!owner()}>
            None
          </option>
          <For each={active()}>
            {(p) => (
              <option value={p.id} selected={p.id === owner()?.id}>
                {p.name}
              </option>
            )}
          </For>
        </select>
        <Show when={ownerChangeLine(props.org.ownerHistory, now())}>{(t) => <span class="field-hint">{t()}</span>}</Show>
      </label>
      <Show when={line()}>
        {(l) => (
          <p class="orgs-line" classList={{ "orgs-owner-warn": l().warn }}>
            {l().text}
          </p>
        )}
      </Show>
      <Show when={shown()}>{(s) => <LinksBanner links={[s().link]} warning={s().warning} onDismiss={() => setShown(null)} />}</Show>
      <div class="orgs-owner-actions">
        <div class="button-row">
          <button
            type="button"
            class="button button-sm"
            aria-disabled={!owner() ? "true" : undefined}
            aria-describedby={!owner() ? "orgs-owner-none" : undefined}
            aria-expanded={live() ? confirm() === "rotate" : undefined}
            onClick={() => {
              if (!owner()) return;
              if (live()) setConfirm(confirm() === "rotate" ? null : "rotate");
              else void getLink();
            }}
          >
            Get Owner Link
          </button>
          <button type="button" class="button button-sm" aria-disabled={!owner() ? "true" : undefined} onClick={() => owner() && setPreviewing(true)}>
            <Icon name="eye" small /> Preview Owner Page
          </button>
        </div>
        <Show when={live()}>
          <button type="button" class="button button-sm button-destructive orgs-owner-off" aria-expanded={confirm() === "off"} onClick={() => setConfirm(confirm() === "off" ? null : "off")}>
            {DELETE_OWNER_LINK}
          </button>
        </Show>
      </div>
      <Show when={!owner()}>
        <p class="field-hint" id="orgs-owner-none">
          Pick an owner first.
        </p>
      </Show>
      <Show when={owner() && confirm()}>
        {(kind) => (
          <div class="orgs-owner-confirm" role="group" aria-label={kind() === "rotate" ? "Get a new owner link" : "Delete the owner link"}>
            <p class="orgs-line">{kind() === "rotate" ? rotateLine(owner()!.name) : deleteOwnerLine(owner()!.name)}</p>
            <div class="button-row">
              <Show
                when={kind() === "rotate"}
                fallback={
                  <button type="button" class="button button-sm button-destructive" onClick={() => void deleteLink()}>
                    {DELETE_OWNER_LINK_FOR_GOOD}
                  </button>
                }
              >
                <button type="button" class="button button-sm button-primary" onClick={() => void getLink()}>
                  Get Owner Link
                </button>
              </Show>
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={previewing() && owner()}>
        {(o) => <OwnerPreview orgId={props.org.id} orgName={props.org.name} ownerName={o().name} onClose={() => setPreviewing(false)} />}
      </Show>
    </section>
  );
}

let previewSeq = 0;

/** The Owner page as the owner sees it, read-only: the same answer as their link, with no token and
    no visit. Its links move inside the preview, never the operator's page. */
export function OwnerPreview(props: { orgId: string; orgName: string; ownerName: string; onClose(): void }) {
  const titleId = `owner-preview-${++previewSeq}`;
  const first = () => firstName(props.ownerName);
  const [route, setRoute] = createSignal<OwnerRoute>({ kind: "home" });
  let body!: HTMLDivElement;
  let close!: HTMLButtonElement;
  onMount(() => close.focus());
  const load = async (r: OwnerRoute): Promise<OwnerAnswer> => {
    try {
      return await previewOwnerPage(props.orgId, r.kind === "project" ? { project: r.id } : r.kind === "conversation" ? { c: r.id } : undefined);
    } catch (x) {
      throw new OwnerLoadError(x instanceof ApiError && x.status === 404 ? (r.kind === "home" ? "failed" : "missing") : "failed");
    }
  };
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal modal-wide owner-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            {props.orgName}, as {first()} sees it
          </h2>
        </div>
        <div class="modal-body person-preview-body" ref={body} tabindex="0" aria-label="Preview">
          <p class="orgs-line project-muted">Read only. Nothing you do here reaches {first()}, and no visit is recorded.</p>
          <OwnerPage
            route={route()}
            load={load}
            href={ownerHash}
            go={(r) => {
              setRoute(r);
              body.scrollTop = 0;
            }}
            preview
          />
        </div>
        <div class="modal-foot">
          <button type="button" class="button" ref={close} onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}
