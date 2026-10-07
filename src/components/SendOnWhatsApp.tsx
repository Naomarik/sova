import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { linkMessage, type BatonOutreach } from "../../shared/outreach";
import { ApiError, batonLink, batonOutreach, inviteeLink, sendBatonLink } from "../lib/api";
import { firstName } from "../lib/person-page";
import { openSettings } from "../lib/settings-nav";
import { announce, copyText, toast } from "../lib/ui-state";
import { Banner } from "./ui";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

type Person = BatonOutreach["people"][number];

/**
 * Send on WhatsApp (§app.outreach/send-link), on the baton strip: one button for the holder, or one
 * per reached invitee of an open offer, disabled with why when outreach can't send to them. After a
 * failure: the why, Retry, Open in WhatsApp (the person's kept live link, else one Get Link makes,
 * sent from the operator's own WhatsApp via wa.me) and Copy Link (the kept live link, copied at once,
 * else the one Get Link makes, shown on the strip).
 *
 * One state, two places (§app.baton/strip-layout): the buttons sit in the strip's bar, the fallback
 * banner in the rows below it. `enabled` false reads nothing and draws nothing.
 */
export function createSendOnWhatsApp(props: {
  enabled(): boolean;
  sid(): string;
  /** Changes whenever the strip's data moves (re-reads who may be sent to). */
  version(): string;
  offer(): boolean;
  /** The person's live kept link, from the strip's data (BatonInfo.links), or undefined. */
  kept(personId: string): string | undefined;
  /** Show a freshly minted link on the strip, as Get Link does. */
  onLink(personId: string, name: string, r: { link: string; n: number; at?: string; linkWarning?: string }): void;
  /** After a send: the strip and the list re-read. */
  onSent(): void;
}) {
  const [reach, { refetch }] = createResource(
    () => props.enabled() && { sid: props.sid(), v: props.version() },
    (k) => batonOutreach(k.sid).catch(() => null),
  );
  const [busy, setBusy] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<{ person: Person; why: string } | null>(null);
  // Leaving the states it is offered in drops a failure, as unmounting it did when it was its own row.
  createEffect(() => props.enabled() || setFailed(null));
  // Get Link (keep): the kept live link if another tab made one meanwhile, else a new one.
  const mint = (p: Person) => (props.offer() ? inviteeLink(props.sid(), p.id, true) : batonLink(props.sid(), true));

  const send = async (p: Person) => {
    setBusy(p.id);
    try {
      const r = await sendBatonLink(props.sid(), props.offer() ? p.id : undefined);
      if (r.outcome === "sent") {
        setFailed(null);
        const said = `Sent ${r.name} their link on WhatsApp.`;
        toast(said);
        announce(said);
      } else setFailed({ person: p, why: r.why ?? "The send failed." });
    } catch (err) {
      setFailed({ person: p, why: errText(err) });
    } finally {
      setBusy(null);
      void refetch();
      props.onSent();
    }
  };

  const openInWhatsApp = async (p: Person) => {
    const r = reach();
    if (!p.wa || !r) return;
    // Opened now, inside the click, so a popup blocker lets it through; pointed at wa.me once the link exists.
    const w = window.open("", "_blank");
    try {
      const kept = props.kept(p.id);
      let link = kept;
      if (!link) {
        const l = await mint(p);
        props.onLink(p.id, p.name, l);
        link = l.link;
      }
      const url = `https://wa.me/${p.wa}?text=${encodeURIComponent(linkMessage(r.operatorName, r.publicTitle, link))}`;
      if (w) {
        w.opener = null;
        w.location.href = url;
      } else window.location.href = url;
      setFailed(null);
    } catch (err) {
      w?.close();
      setFailed({ person: p, why: errText(err) });
    }
  };

  const copyLink = async (p: Person) => {
    // The kept live link: copied inside the click, from data in hand.
    const kept = props.kept(p.id);
    if (kept) {
      if (await copyText(kept, "Link copied.")) setFailed(null);
      return;
    }
    try {
      props.onLink(p.id, p.name, await mint(p));
      setFailed(null);
      const said = `Link for ${p.name} ready below.`;
      toast(said);
      announce(said);
    } catch (err) {
      setFailed({ person: p, why: errText(err) });
    }
  };

  /** Who it could go to, while the strip offers it at all. */
  const people = () => (props.enabled() ? (reach()?.people ?? []) : []);
  return { people, busy, failed, offer: props.offer, send, openInWhatsApp, copyLink };
}

export type SendOnWhatsAppState = ReturnType<typeof createSendOnWhatsApp>;

/** The bar's part: a button per person it could go to, and Set Up Outreach while outreach is off. */
export function SendOnWhatsAppButtons(props: { s: SendOnWhatsAppState }) {
  const s = props.s;
  return (
    <Show when={s.people().length > 0}>
      <For each={s.people()}>
        {(p) => (
          <button
            type="button"
            class="button"
            disabled={!p.ready || s.busy() !== null}
            title={p.ready ? `Sends ${p.name} a fresh link on WhatsApp; their older one stops working` : p.why}
            onClick={() => void s.send(p)}
          >
            {s.busy() === p.id ? "Sending…" : s.offer() || s.people().length > 1 ? `Send ${firstName(p.name)} on WhatsApp` : "Send on WhatsApp"}
          </button>
        )}
      </For>
      <Show when={s.people().find((p) => !p.ready && p.why?.includes("Settings → Outreach"))}>
        <button type="button" class="button button-ghost" onClick={() => openSettings("outreach")}>
          Set Up Outreach
        </button>
      </Show>
    </Show>
  );
}

/** The rows' part, after a failure or a refusal: the why and three ways on. */
export function SendOnWhatsAppFallback(props: { s: SendOnWhatsAppState }) {
  const s = props.s;
  return (
    <Show when={s.failed()}>
      {(f) => (
        <div class="baton-strip-link">
          <Banner
            tone="warn"
            title={`Not sent to ${f().person.name}: ${f().why}`}
            action={
              <span class="baton-strip-outreach-fallback">
                <button type="button" class="button button-sm" disabled={s.busy() !== null || !f().person.ready} onClick={() => void s.send(f().person)}>
                  Retry
                </button>
                <Show when={f().person.wa}>
                  <button type="button" class="button button-sm button-ghost" onClick={() => void s.openInWhatsApp(f().person)}>
                    Open in WhatsApp
                  </button>
                </Show>
                <button type="button" class="button button-sm button-ghost" onClick={() => void s.copyLink(f().person)}>
                  Copy Link
                </button>
              </span>
            }
          />
        </div>
      )}
    </Show>
  );
}
