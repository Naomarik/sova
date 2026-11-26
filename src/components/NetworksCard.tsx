import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { NetworksView, RangeCheck } from "../../shared/networks";
import { checkRange, getNetworks, trustRange, untrustRange } from "../lib/api";
import { confirmWords, networkRows, retypeMatches, trustState, waitingReason, type NetworkRow } from "../lib/networks";
import { announce } from "../lib/ui-state";
import { Banner, trapFocus } from "./ui";
import { TextField } from "./form";

/** How often the card reads the list again while the page is open, so a VPN coming or going shows. */
const REFRESH_MS = 15_000;

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The Access page's Networks card: this computer's VPNs (then Wi-Fi and wired), each trusted or not, and a typed range. */
export function NetworksCard(props: { onChange?: () => void }) {
  const [view, setView] = createSignal<NetworksView | null>(null);
  const [loadError, setLoadError] = createSignal(false);
  const [range, setRange] = createSignal("");
  const [rangeError, setRangeError] = createSignal("");
  const [checking, setChecking] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal<(RangeCheck & { range: string }) | null>(null);
  const [rowError, setRowError] = createSignal<{ key: string; text: string } | null>(null);
  const [stopping, setStopping] = createSignal<string | null>(null);

  async function load() {
    try {
      setView(await getNetworks());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  onCleanup(() => clearInterval(timer));

  const rows = () => {
    const v = view();
    return v ? networkRows(v.networks, v.trusted, { tailscaleReady: !!v.tailscale?.ready }) : [];
  };

  /** Check a range, then open the confirmation; a refusal is shown where it was asked. */
  async function ask(r: string, where: { key: string } | "typed") {
    if (checking()) return;
    const key = where === "typed" ? "typed" : where.key;
    setChecking(key);
    setRowError(null);
    setRangeError("");
    const refuse = (text: string) => (where === "typed" ? setRangeError(text) : setRowError({ key, text }));
    try {
      const check = await checkRange(r);
      if (!check.ok) refuse(check.error ?? `Sova can't trust ${r}.`);
      else setConfirm({ ...check, range: check.range ?? r });
    } catch (e) {
      refuse(errorText(e, `Sova couldn't check ${r}. Nothing was trusted. Try again.`));
    } finally {
      setChecking(null);
    }
  }

  async function stop(row: NetworkRow) {
    if (!row.range || stopping()) return;
    setStopping(row.key);
    setRowError(null);
    try {
      setView(await untrustRange({ range: row.range }));
      announce(`Stopped trusting ${row.range}. Its connections were cut.`);
      props.onChange?.();
    } catch (e) {
      setRowError({ key: row.key, text: errorText(e, `Sova couldn't stop trusting ${row.range}. It's still trusted. Try again.`) });
    } finally {
      setStopping(null);
    }
  }

  function trusted(next: NetworksView, r: string) {
    setView(next);
    setConfirm(null);
    setRange("");
    announce(`Trusted ${r}. Devices there can open Sova's sign-in screen.`);
    props.onChange?.();
  }

  return (
    <section class="card stack" aria-labelledby="access-networks-title" style={{ padding: "var(--space-4)", "min-width": "0" }}>
      <h2 id="access-networks-title" class="text-heading-m">Networks</h2>
      <p>Where other devices may reach this Sova. A device on a trusted network still pairs once with a code.</p>
      <Show when={loadError() && !view()}>
        <Banner tone="error" title="The networks couldn't be read." body="Nothing changed. Sova tries again in a few seconds." />
      </Show>
      <Show when={view()} fallback={<Show when={!loadError()}><div class="skeleton skeleton-row" /></Show>}>
        {(v) => (
          <Show when={!v().wildcard} fallback={
            <p>Sova was started to answer on every network (<code>HOST=0.0.0.0</code>), so there's nothing to trust one by one. Every device still needs a pairing code once.</p>
          }>
            <div class="list" role="list" aria-label="This computer's networks">
              <Show when={v().tailscale}>{(ts) => (
                <div class="list-row access-net-row" role="listitem">
                  <div class="list-main access-net-main">
                    <p class="list-title">Tailscale</p>
                    <p class="list-meta access-net-meta">{ts().ready ? "HTTPS address · set up through Tailscale" : "No HTTPS address yet: serve Sova with tailscale serve"}</p>
                  </div>
                  <span class={`chip${ts().ready ? " chip-success" : ""}`}><i class="chip-dot" />{ts().ready ? "Ready" : "Not set up"}</span>
                </div>
              )}</Show>
              <For each={rows()}>{(row) => {
                const state = () => trustState(row.trusted);
                const reason = () => (row.trusted ? waitingReason(row.trusted) : undefined);
                const err = () => (rowError()?.key === row.key ? rowError()!.text : "");
                return (
                  <div class="list-row access-net-row" role="listitem">
                    <div class="list-main access-net-main">
                      <p class="list-title">{row.title}</p>
                      <p class="list-meta access-net-meta text-mono">{row.meta}</p>
                      <Show when={reason()}>{(r) => <p class="list-meta access-net-meta">{r()}</p>}</Show>
                      <Show when={err()}><p class="field-error">{err()}</p></Show>
                    </div>
                    <span class={`chip${state().tone ? ` chip-${state().tone}` : ""}`}><i class="chip-dot" />{state().word}</span>
                    <Show when={row.trusted} fallback={
                      <Show when={row.range}>{(r) => (
                        <button class="button" type="button" disabled={!!checking()} aria-label={`Trust ${row.title}…`} onClick={() => void ask(r(), row)}>
                          {checking() === row.key ? "Checking…" : "Trust…"}
                        </button>
                      )}</Show>
                    }>
                      <button class="button button-destructive" type="button" disabled={stopping() === row.key} aria-label={`Stop Trusting ${row.title}`} onClick={() => void stop(row)}>
                        {stopping() === row.key ? "Stopping…" : "Stop Trusting"}
                      </button>
                    </Show>
                  </div>
                );
              }}</For>
            </div>
            <Show when={v().trusted.length > 0}>
              <p class="field-hint">A device that can't open Sova on a trusted network may be blocked by this computer's firewall: macOS asks once to allow incoming connections, and a Linux firewall can block it without a word.</p>
            </Show>
            <Show when={!rows().some((r) => r.vpn) && !v().tailscale?.ready}>
              <p>Sova found no VPN on this computer. If yours doesn't show, add its range below.</p>
            </Show>
            <form class="stack stack-2" onSubmit={(e) => { e.preventDefault(); const r = range().trim(); if (r) void ask(r, "typed"); }}>
              <TextField id="access-range" label="Add a range" inputClass="input-mono" placeholder="10.224.0.0/22" autocomplete="off" spellcheck={false}
                value={range()} onInput={(v) => { setRange(v); setRangeError(""); }} error={rangeError() || null}
                hint="For a network Sova can't detect. Private ranges only: 10/8, 172.16/12, 192.168/16, 100.64/10, fd00::/8."
                afterClass="access-range-row"
                after={<button class="button" type="submit" disabled={!range().trim() || !!checking()}>{checking() === "typed" ? "Checking…" : "Trust Range…"}</button>} />
            </form>
          </Show>
        )}
      </Show>
      <Show when={confirm()}>{(c) => (
        <Portal>
          <TrustDialog check={c()} onCancel={() => setConfirm(null)} onTrusted={(v) => trusted(v, c().range)} />
        </Portal>
      )}</Show>
    </section>
  );
}

/** The confirmation: the range, how many addresses, what trusting it allows, and its warnings. */
function TrustDialog(props: { check: RangeCheck & { range: string }; onCancel: () => void; onTrusted: (v: NetworksView) => void }) {
  const words = () => confirmWords(props.check);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const ready = () => !busy() && (!words().retype || retypeMatches(props.check.range, typed()));

  async function go(e: Event) {
    e.preventDefault();
    if (!ready()) return;
    setBusy(true);
    setError("");
    try {
      props.onTrusted(await trustRange({ range: props.check.range, ...(words().retype ? { confirm: typed().trim() } : {}) }));
    } catch (err) {
      setError(errorText(err, `Sova couldn't trust ${props.check.range}.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div class="scrim" onClick={props.onCancel} />
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-body" ref={(el) => trapFocus(el)}
        onKeyDown={(e) => { if (e.key === "Escape") props.onCancel(); }}>
        <div class="modal-head"><h2 class="modal-title" id="trust-title">{words().title}</h2></div>
        <form class="modal-body stack" id="trust-form" onSubmit={go}>
          <Show when={error()}><Banner tone="error" title="Nothing was trusted." body={error()} /></Show>
          <p id="trust-body">{words().body}</p>
          <Show when={words().where}>{(w) => <p>{w()}</p>}</Show>
          <Show when={words().notVpn}>{(w) => <Banner tone="warn" title="Anyone on this network can read Sova's traffic." body={w()} />}</Show>
          <Show when={words().warning}>{(w) => <Banner tone="warn" title="Check this range." body={w()} />}</Show>
          <Show when={words().retype}>{(r) => (
            <TextField id="trust-retype" label={r()} inputClass="input-mono" autocomplete="off" spellcheck={false} placeholder={props.check.range}
              value={typed()} onInput={setTyped} />
          )}</Show>
          <p>Stop Trusting cuts its connections at once. Devices that paired stay signed in, and can come back if you trust it again.</p>
        </form>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button class="button button-ghost" type="button" onClick={props.onCancel}>Cancel</button>
          <button class="button button-primary" type="submit" form="trust-form" disabled={!ready()}>{busy() ? "Trusting…" : "Trust Network"}</button>
        </div>
      </div>
    </>
  );
}
