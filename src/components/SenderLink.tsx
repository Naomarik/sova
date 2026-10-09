import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import type { OutreachInfo, SenderLinkView } from "../../shared/outreach";
import { encodeQr } from "../lib/qr";
import { cancelLink, getLink, PHONE_DIGITS, startLink, unlinkSender } from "../lib/outreach";
import { announce } from "../lib/ui-state";
import { Banner } from "./ui";

/** How often a link in progress is read again, so each new QR the sender issues shows at once. */
const POLL_MS = 1_000;

/**
 * Link a Phone and Unlink This Number (§app.outreach/sender-link), on the sender's own host only: the
 * parent offers each only when senderActions says so. A QR shows only after the operator presses Link a
 * Phone; the page reads the link every second while it runs and draws each new QR itself. The QR and
 * the pairing code live in this component's signals only, and go when the link ends.
 */
export function SenderLink(props: { sender?: string; link: boolean; unlink: boolean; disabled: boolean; onChanged: (info?: OutreachInfo) => void }) {
  const [view, setView] = createSignal<SenderLinkView | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** The pairing code's number field, while open. */
  const [codeEntry, setCodeEntry] = createSignal(false);
  const [phone, setPhone] = createSignal("");
  const [phoneError, setPhoneError] = createSignal<string | null>(null);
  const [confirming, setConfirming] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  /** The sender's sentence after an unlink: whether the phone was told, or to remove the device there too. */
  const [unlinked, setUnlinked] = createSignal<string | null>(null);

  // A memo, so the poll below restarts only when a link starts or ends, never on each new QR.
  const running = createMemo(() => {
    const p = view()?.phase;
    return p === "starting" || p === "waiting";
  });

  // A link another tab of this page started is still shown here; a finished one is not.
  onMount(() => {
    getLink(props.sender).then((v) => (v.phase === "starting" || v.phase === "waiting") && setView(v), () => {});
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(
    on(running, (on) => {
      clearInterval(timer);
      if (!on) return;
      timer = setInterval(() => {
        getLink(props.sender).then(
          (v) => {
            // Only the link this page follows: an idle answer means the server dropped it.
            if (!running()) return;
            setView(v.phase === "idle" ? { phase: "ended", why: "Linking stopped." } : v);
            if (v.phase === "linked") announce(`Linked: number ending ${v.me ?? ""}.`);
            // The link ended either way: read the state now, so Try Again or Unlink shows at once.
            if (v.phase === "linked" || v.phase === "ended" || v.phase === "idle") props.onChanged();
          },
          () => {},
        );
      }, POLL_MS);
    }),
  );
  onCleanup(() => clearInterval(timer));

  const qr = createMemo(() => {
    const text = view()?.qr;
    if (!text) return null;
    try {
      const m = encodeQr(text).matrix;
      return { path: m.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : []))).join(""), size: m.length + 8 };
    } catch {
      return null;
    }
  });

  const start = async (withPhone?: string) => {
    setBusy(true);
    setError(null);
    setUnlinked(null);
    try {
      const v = await startLink(withPhone, props.sender);
      setView(v);
      setCodeEntry(false);
      announce(withPhone ? "The pairing code is ready." : "Scan the QR code with WhatsApp on the phone.");
      props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const getCode = () => {
    const p = phone().trim();
    if (!PHONE_DIGITS.test(p)) return setPhoneError("Country code first, digits only: 7 to 15.");
    setPhoneError(null);
    void start(p);
  };
  const cancel = async () => {
    setBusy(true);
    try {
      // Cancelled by the operator: nothing to report, and Link a Phone is offered again below.
      await cancelLink(props.sender);
      setView(null);
      announce("Linking was cancelled.");
      props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await unlinkSender(typed(), props.sender);
      setConfirming(false);
      setTyped("");
      setView(null);
      setUnlinked(info.sender.why ?? "The number is unlinked.");
      announce(info.sender.why ?? "The number is unlinked.");
      props.onChanged(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const tryAgain = () => (view()?.mode === "code" ? (setView(null), setCodeEntry(true)) : void start());

  return (
    <>
      <Show when={running() && view()}>
        {(v) => (
          <div class="sender-link" role="group" aria-label="Linking a phone">
            <Show
              when={v().mode === "code"}
              fallback={
                <Show when={qr()} fallback={<p class="field-hint">Waiting for the sender's QR code…</p>}>
                  {(q) => (
                    <svg class="sender-link-qr" role="img" aria-label="QR code to link this number's WhatsApp to the sender" viewBox={`0 0 ${q().size} ${q().size}`} shape-rendering="crispEdges">
                      <rect width={q().size} height={q().size} fill="light-dark(var(--color-surface), var(--color-ink))" />
                      <path d={q().path} fill="currentColor" />
                    </svg>
                  )}
                </Show>
              }
            >
              <Show when={v().code} fallback={<p class="field-hint">Waiting for the pairing code…</p>}>
                {(code) => (
                  <p class="sender-link-code" aria-label={`Pairing code ${code().split("").join(" ")}`}>
                    {code().length === 8 ? `${code().slice(0, 4)}-${code().slice(4)}` : code()}
                  </p>
                )}
              </Show>
            </Show>
            <p class="sender-link-steps">
              {v().mode === "code"
                ? `On the phone with the number ending ${v().phoneTail ?? ""}, open WhatsApp → Settings → Linked devices → Link a Device → Link with phone number instead, and type this code.`
                : "On the phone, open WhatsApp → Settings → Linked devices → Link a Device, and scan this code."}
            </p>
            <p class="field-hint">
              {v().mode === "code" ? "Keep this code private: it links your number." : "A new code replaces this one now and then, until it expires. Keep it private: it links your number."}
            </p>
            <div class="outreach-actions">
              <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => void cancel()}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={view()?.phase === "linked" && view()}>{(v) => <Banner tone="success" title={`Linked: number ending ${v().me ?? "…"}.`} />}</Show>
      <Show when={view()?.phase === "ended" && view()}>
        {(v) => (
          <Banner
            tone="warn"
            title={v().why ?? "Linking stopped."}
            body="Nothing is linked. Try again when the phone is at hand."
            action={
              <Show when={props.link}>
                <button type="button" class="button button-sm" disabled={busy() || props.disabled} onClick={tryAgain}>
                  Try Again
                </button>
              </Show>
            }
          />
        )}
      </Show>

      <Show when={props.link && !running()}>
        <Show
          when={codeEntry()}
          fallback={
            <div class="outreach-control">
              <button type="button" class="button button-sm" disabled={busy() || props.disabled} onClick={() => void start()}>
                {busy() ? "Starting…" : "Link a Phone"}
              </button>
              <button type="button" class="button button-sm button-ghost" disabled={busy() || props.disabled} onClick={() => (setCodeEntry(true), setPhoneError(null))}>
                Use a Pairing Code Instead
              </button>
              <span class="field-hint">Shows a QR code to scan from WhatsApp on the phone.</span>
            </div>
          }
        >
          <form
            class="field sender-link-phone"
            onSubmit={(e) => {
              e.preventDefault();
              getCode();
            }}
          >
            <label class="field-label" for="sender-link-phone">
              The phone's number
            </label>
            <input
              id="sender-link-phone"
              class="input input-mono"
              inputmode="numeric"
              autocomplete="off"
              placeholder="15550001234"
              value={phone()}
              aria-invalid={phoneError() ? "true" : undefined}
              aria-describedby="sender-link-phone-hint"
              onInput={(e) => setPhone(e.currentTarget.value)}
            />
            <span class="field-hint" id="sender-link-phone-hint">
              Country code first, digits only: 7 to 15.
            </span>
            <Show when={phoneError()}>{(e) => <span class="field-error">{e()}</span>}</Show>
            <div class="outreach-actions">
              <button type="submit" class="button button-sm" disabled={busy() || props.disabled}>
                {busy() ? "Asking…" : "Get Pairing Code"}
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setCodeEntry(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </Show>

      <Show when={props.unlink}>
        <Show
          when={confirming()}
          fallback={
            <div class="outreach-control">
              <button type="button" class="button button-sm button-destructive" disabled={busy() || props.disabled} onClick={() => (setConfirming(true), setTyped(""), setView(null))}>
                Unlink This Number
              </button>
              <span class="field-hint">Logs this device out of WhatsApp and deletes its keys on this host.</span>
            </div>
          }
        >
          <Banner
            tone="warn"
            title="Unlinking logs this device out of WhatsApp and deletes its keys on this host."
            body={
              <span class="stack stack-2">
                <span>Sending from this number stops until you link a phone again; the chats on the phone stay.</span>
                <span class="field">
                  <label class="field-label" for="sender-unlink-confirm">
                    Type UNLINK to confirm
                  </label>
                  <input id="sender-unlink-confirm" class="input input-mono" autocomplete="off" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
                </span>
              </span>
            }
            action={
              <span class="outreach-actions">
                <button type="button" class="button button-sm button-destructive" disabled={busy() || typed() !== "UNLINK"} onClick={() => void unlink()}>
                  {busy() ? "Unlinking…" : "Unlink Number"}
                </button>
                <button type="button" class="button button-sm button-ghost" onClick={() => (setConfirming(false), setTyped(""))}>
                  Cancel
                </button>
              </span>
            }
          />
        </Show>
      </Show>

      <Show when={unlinked()}>{(w) => <Banner tone="info" title={w()} />}</Show>
      <Show when={error()}>{(e) => <Banner tone="error" title={e()} />}</Show>
    </>
  );
}
