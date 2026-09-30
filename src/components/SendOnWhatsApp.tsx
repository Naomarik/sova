import { createResource, createSignal, For, Show } from "solid-js";
import { linkMessage, type BatonOutreach } from "../../shared/outreach";
import { ApiError, batonLink, batonOutreach, inviteeLink, sendBatonLink } from "../lib/api";
import { firstName } from "../lib/person-page";
import { openSettings } from "../lib/settings-nav";
import { announce, toast } from "../lib/ui-state";
import { Banner } from "./ui";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

type Person = BatonOutreach["people"][number];

/**
 * Send on WhatsApp (§app.outreach/send-link), on the baton strip: one button for the holder, or one
 * per reached invitee of an open offer, disabled with why when outreach can't send to them. After a
 * failure: the why, Retry, Open in WhatsApp (a fresh link through Get Link, sent from the operator's
 * own WhatsApp via wa.me) and Copy Link (Get Link, shown on the strip as today).
 */
export function SendOnWhatsApp(props: {
  sid: string;
  /** Changes whenever the strip's data moves (re-reads who may be sent to). */
  version: string;
  offer: boolean;
  /** Show a freshly minted link on the strip, as Get Link does. */
  onLink(personId: string, name: string, r: { link: string; n: number; at?: string; linkWarning?: string }): void;
  /** After a send: the strip and the list re-read. */
  onSent(): void;
}) {
  const [reach, { refetch }] = createResource(
    () => ({ sid: props.sid, v: props.version }),
    (k) => batonOutreach(k.sid).catch(() => null),
  );
  const [busy, setBusy] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<{ person: Person; why: string } | null>(null);
  const mint = (p: Person) => (props.offer ? inviteeLink(props.sid, p.id) : batonLink(props.sid));

  const send = async (p: Person) => {
    setBusy(p.id);
    try {
      const r = await sendBatonLink(props.sid, props.offer ? p.id : undefined);
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
      const l = await mint(p);
      props.onLink(p.id, p.name, l);
      const url = `https://wa.me/${p.wa}?text=${encodeURIComponent(linkMessage(r.operatorName, r.publicTitle, l.link))}`;
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
    try {
      props.onLink(p.id, p.name, await mint(p));
      setFailed(null);
      const said = `New link for ${p.name} ready below.`;
      toast(said);
      announce(said);
    } catch (err) {
      setFailed({ person: p, why: errText(err) });
    }
  };

  return (
    <Show when={(reach()?.people.length ?? 0) > 0}>
      <div class="baton-strip-row baton-strip-outreach" role="group" aria-label="Send on WhatsApp">
        <For each={reach()!.people}>
          {(p) => (
            <button
              type="button"
              class="button button-sm"
              disabled={!p.ready || busy() !== null}
              title={p.ready ? `Sends ${p.name} a fresh link on WhatsApp; their older one stops working` : p.why}
              onClick={() => void send(p)}
            >
              {busy() === p.id ? "Sending…" : props.offer || reach()!.people.length > 1 ? `Send ${firstName(p.name)} on WhatsApp` : "Send on WhatsApp"}
            </button>
          )}
        </For>
        <Show when={reach()!.people.find((p) => !p.ready && p.why?.includes("Settings → Outreach"))}>
          <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("outreach")}>
            Set Up Outreach
          </button>
        </Show>
      </div>
      <Show when={failed()}>
        {(f) => (
          <div class="baton-strip-link">
            <Banner
              tone="warn"
              title={`Not sent to ${f().person.name}: ${f().why}`}
              action={
                <span class="baton-strip-outreach-fallback">
                  <button type="button" class="button button-sm" disabled={busy() !== null || !f().person.ready} onClick={() => void send(f().person)}>
                    Retry
                  </button>
                  <Show when={f().person.wa}>
                    <button type="button" class="button button-sm button-ghost" onClick={() => void openInWhatsApp(f().person)}>
                      Open in WhatsApp
                    </button>
                  </Show>
                  <button type="button" class="button button-sm button-ghost" onClick={() => void copyLink(f().person)}>
                    Copy Link
                  </button>
                </span>
              }
            />
          </div>
        )}
      </Show>
    </Show>
  );
}
