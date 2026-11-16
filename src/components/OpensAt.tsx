import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { PREVIEW_TUNNELS_MAX, type PublicLinksInfo } from "../../shared/public-links";
import { agoTime, clockTime } from "../lib/format";
import { sessionHrefOn } from "../lib/mesh";
import {
  APPLIES_TO_ALL,
  currentLine,
  needsCloudflared,
  needsTurnOn,
  opensAtLine,
  opensAtSections,
  optionName,
  patchFor,
  STATE_WORDS,
  type OpensAtKey,
  type OpensAtOption,
  type OpensAtSetupKind,
} from "../lib/opens-at";
import {
  acceptPublicLinksInfo,
  cancelCandidate,
  candidateOf,
  downloadCloudflared,
  loadPublicLinks,
  noteHandedOut,
  publicLinksInfo,
  putPublicLinks,
  startSetupChat,
  turnOnPublicLinks,
  verifyPublicLinks,
} from "../lib/public-links";
import { closeSettings, openSettings } from "../lib/settings-nav";
import { copyText } from "../lib/ui-state";
import { Banner, Chip, CopyButton, trapFocus } from "./ui";
import { Radio } from "./form";
import { sentence } from "./WorkerSlotRow";

/**
 * "Where links open": one host-wide choice, in sections (Cloudflare: Free, Account · Tailscale:
 * Funnel, Through {computer} · Your own web server · Off). Settings → Public links shows the whole
 * list; every share screen shows the choice as one line with Change, which opens the same list.
 * Options not set up are greyed but selectable: picking one opens its setup help, with Set Up With a
 * Chat. Words: lib/opens-at.ts.
 */

/** The grouped radio list. `selected`: the option shown as chosen; `onPick` gets every pick, set up or not. */
export function OpensAtChoices(props: { info: PublicLinksInfo; selected?: OpensAtKey | null; withOff?: boolean; disabled?: boolean; onPick(o: OpensAtOption): void; idPrefix: string }) {
  const sections = () => opensAtSections(props.info, { selected: props.selected, withOff: props.withOff });
  const name = `${props.idPrefix}-opens-at`;
  return (
    <div class="opens-at" role="radiogroup" aria-label="Where links open" aria-describedby={`${name}-applies`}>
      <For each={sections()}>
        {(s) => (
          <div class="opens-at-section" role="group" aria-labelledby={`${name}-${s.id}`}>
            <p class="opens-at-section-title" id={`${name}-${s.id}`}>
              {s.title}
            </p>
            <For each={s.options}>
              {(o) => (
                <Radio
                  class={`public-links-choice opens-at-option${o.state === "needs-setup" ? " opens-at-needs-setup" : ""}`}
                  name={name}
                  value={o.key}
                  checked={o.state === "on"}
                  disabled={props.disabled}
                  onChange={() => props.onPick(o)}
                  label={
                    <span class="public-links-choice-main">
                      <span class="public-links-choice-name">
                        {o.label}
                        <Show when={o.badge}>{(b) => <span class="chip opens-at-badge">{b()}</span>}</Show>
                        <span class="opens-at-tag"> · {o.stateWord ?? STATE_WORDS[o.state]}</span>
                      </span>
                      <span class="public-links-choice-meta">{o.hint}</span>
                      <Show when={o.note}>{(n) => <span class="public-links-choice-meta opens-at-note">{n()}</span>}</Show>
                    </span>
                  }
                />
              )}
            </For>
          </div>
        )}
      </For>
      <p class="field-hint" id={`${name}-applies`}>
        {APPLIES_TO_ALL}
      </p>
    </div>
  );
}

/** What each setup help says, and whether a setup chat can do it. */
const SETUP: Readonly<Record<OpensAtSetupKind, { title: string; body: string; chat: boolean }>> = {
  account: {
    title: "Set up Cloudflare Account",
    body: "Make a tunnel in your Cloudflare dashboard, point your domain at this computer, then paste the address and the tunnel's token in Settings → Public links.",
    chat: true,
  },
  funnel: {
    title: "Set up Tailscale Funnel",
    body: "Turn on Funnel for this computer in Tailscale, then save its address in Settings → Public links and verify it.",
    chat: true,
  },
  "web-server": {
    title: "Set up your own web server",
    body: "Point your domain at this computer and have Caddy or nginx forward it to Sova's share port, then save the address in Settings → Public links and verify it.",
    chat: true,
  },
  through: {
    title: "Set up Through another computer",
    body: "Turn on public links on another of your computers on Tailscale, as its own web server. It shows up here once it offers to carry links.",
    chat: false,
  },
};

/** Set Up With a Chat: a new chat that runs the setup steps with your approval. It never saves a setting. */
export function SetupChatButton(props: { option: "account" | "web-server" | "funnel"; primary?: boolean; onOpened?(): void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const start = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const s = await startSetupChat(props.option);
      props.onOpened?.();
      closeSettings();
      location.hash = sessionHrefOn(null, s.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" class={`button button-sm${props.primary ? " button-primary" : ""}`} disabled={busy()} onClick={() => void start()}>
        {busy() ? "Starting Chat…" : "Set Up With a Chat"}
      </button>
      <Show when={error()}>{(e) => <span class="field-error">{sentence(e())} Nothing was set up.</span>}</Show>
    </>
  );
}

/** One option's setup help: what to do, Set Up With a Chat, and (off Settings) Open Settings. */
export function OpensAtSetup(props: { kind: OpensAtSetupKind; inSettings?: boolean; onOpened?(): void }) {
  const s = () => SETUP[props.kind];
  return (
    <div class="opens-at-setup stack-2" role="region" aria-label={s().title}>
      <p class="opens-at-setup-title">{s().title}</p>
      <p class="field-hint">{s().body}</p>
      <p class="field-hint">Your links keep opening where they open now until you save this.</p>
      <div class="cluster">
        <Show when={s().chat && props.kind !== "through"}>
          <SetupChatButton option={props.kind as "account" | "web-server" | "funnel"} primary={!props.inSettings} onOpened={props.onOpened} />
        </Show>
        <Show when={!props.inSettings}>
          <button
            type="button"
            class="button button-sm button-ghost"
            onClick={() => {
              props.onOpened?.();
              openSettings("public-links");
            }}
          >
            Open Settings
          </button>
        </Show>
      </div>
    </div>
  );
}

/**
 * A share screen's line: where this computer's links open, with Change, and the one prompt that
 * applies (Turn On, the cloudflared download, a setup that can't be read). Only for this computer's
 * own shares: a peer's share has its own setting, on that peer.
 */
export function OpensAtLine(props: { host?: string | null; /** Where the Change sheet mounts: a native modal dialog makes the rest of the page inert. */ mount?: Node }) {
  onMount(() => {
    if (!publicLinksInfo()) void loadPublicLinks();
  });
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  return (
    <Show when={!props.host && publicLinksInfo()}>
      {(i) => (
        <div class="opens-at-line stack-2">
          <Show when={!i().sharingOff} fallback={<SharingOffNote />}>
            <p class="opens-at-current">
              <span class="opens-at-current-name">{opensAtLine(i())}</span>
              <button ref={trigger} type="button" class="button button-sm button-ghost" onClick={() => setOpen(true)}>
                Change
              </button>
            </p>
          </Show>
          <TunnelPrompts info={i()} />
          <CandidateNotice info={i()} />
          <Show when={open()}>
            <OpensAtSheet
              info={i()}
              mount={props.mount}
              onClose={() => {
                setOpen(false);
                trigger?.focus();
              }}
            />
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Sharing is off on this computer (§mesh.public/sharing-off): said in place of the share line, with the way to turn it on. */
export function SharingOffNote() {
  return (
    <p class="opens-at-current">
      <span class="opens-at-current-name">Sharing is off.</span>
      <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("public-links")}>
        Open Settings
      </button>
    </p>
  );
}

/** The prompts a share screen and Settings show above the links: a setup that can't be read, Turn On, Download. */
export function TunnelPrompts(props: { info: PublicLinksInfo }) {
  return (
    <Switch>
      <Match when={props.info.broken}>
        <Banner
          tone="warn"
          title="Your public links setup can't be read."
          body="Fix it or save it again in Settings → Public links."
          action={
            <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("public-links")}>
              Open Settings
            </button>
          }
        />
      </Match>
      <Match when={needsTurnOn(props.info)}>
        <TurnOnBanner />
      </Match>
      <Match when={needsCloudflared(props.info)}>
        <CloudflaredPrompt info={props.info} />
      </Match>
    </Switch>
  );
}

/**
 * A new address saved but not in use yet (Account, Funnel or Your own web server, saved while the
 * current route works): "Waiting for verification", its address, the last Verify's reason, and
 * Verify and Cancel. Links keep opening with the current choice until Verify passes.
 */
export function CandidateNotice(props: { info: PublicLinksInfo }) {
  const c = () => candidateOf(props.info);
  const [busy, setBusy] = createSignal<"verify" | "cancel" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (kind: "verify" | "cancel") => {
    if (busy()) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "cancel") acceptPublicLinksInfo(await cancelCandidate());
      else {
        const r = await verifyPublicLinks();
        if (!r.ok && !candidateOf(await loadPublicLinks())?.failure) setError(r.error ?? (r.status ? `It answered ${r.status}` : "No answer"));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      void loadPublicLinks();
    }
  };
  const name = () => (c()?.route === "account" ? "Cloudflare Account" : c()?.front === "funnel" ? "Tailscale Funnel" : c()?.front === "cloudflared" ? "your own Cloudflare tunnel" : "Your own web server");
  return (
    <Show when={c()}>
      {(cand) => (
        <Banner
          tone={cand().failure ? "warn" : "info"}
          title="Waiting for verification"
          body={
            <span class="stack-2">
              <span>
                <code class="text-mono public-links-url">{cand().publicUrl}</code> ({name()}) is saved, not in use yet. Links keep opening with {currentLine(props.info)} until it passes Verify.
              </span>
              <Show when={cand().failure}>{(f) => <span class="field-error">Verify failed: {sentence(f().reason)}</span>}</Show>
              <Show when={error()}>{(e) => <span class="field-error">{sentence(e())}</span>}</Show>
            </span>
          }
          action={
            <>
              <button type="button" class="button button-sm" disabled={!!busy()} onClick={() => void run("verify")}>
                {busy() === "verify" ? "Verifying…" : "Verify Address"}
              </button>
              <button type="button" class="button button-sm button-ghost" disabled={!!busy()} onClick={() => void run("cancel")}>
                {busy() === "cancel" ? "Canceling…" : "Cancel"}
              </button>
            </>
          }
        />
      )}
    </Show>
  );
}

/** Turn On (q11): the first public Free tunnel waits for this one click. Never an agent's. */
export function TurnOnBanner() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      acceptPublicLinksInfo(await turnOnPublicLinks());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      tone="info"
      title="Turn on public links?"
      body={
        <>
          Links you share will open from anywhere, through a free Cloudflare address. Nothing is public until you turn it on.
          <Show when={error()}>{(e) => <span class="field-error"> {sentence(e())}</span>}</Show>
        </>
      }
      action={
        <button type="button" class="button button-sm" disabled={busy()} onClick={() => void turnOn()}>
          {busy() ? "Turning On…" : "Turn On"}
        </button>
      }
    />
  );
}

/** cloudflared isn't on this computer: Download (your click, once, checksum-verified), or the install line. */
export function CloudflaredPrompt(props: { info: PublicLinksInfo }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const cf = () => props.info.tunnel?.cloudflared;
  const canDownload = () => !!cf()?.canDownload;
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadCloudflared();
      await loadPublicLinks().then((i) => i && acceptPublicLinksInfo(i));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      tone="info"
      title="Cloudflare's tunnel program isn't on this computer."
      body={
        <span class="stack-2 opens-at-cloudflared">
          <Show when={cf()?.reason}>{(r) => <span>{sentence(r())}</span>}</Show>
          <Show when={canDownload()} fallback={<span>Install cloudflared yourself, then reload this page.</span>}>
            <Show when={cf()?.install}>
              {(cmd) => (
                <span class="cluster">
                  <span>Or install it yourself:</span>
                  <code class="text-mono opens-at-install">{cmd()}</code>
                  <CopyButton label="Copy Command" text={() => cmd()} onCopy={(t) => copyText(t, "Copied the command.")} />
                </span>
              )}
            </Show>
          </Show>
          <Show when={!canDownload() && cf()?.install}>{(cmd) => <code class="text-mono opens-at-install">{cmd()}</code>}</Show>
          <Show when={error()}>{(e) => <span class="field-error">{downloadError(e())}</span>}</Show>
        </span>
      }
      action={
        <Show when={canDownload()}>
          <button type="button" class="button button-sm" disabled={busy()} onClick={() => void download()}>
            {busy() ? "Downloading…" : "Download"}
          </button>
        </Show>
      }
    />
  );
}

/** A failed download as the prompt says it: a checksum mismatch in its own words, else the server's reason. */
const downloadError = (reason: string): string =>
  /checksum/i.test(reason) ? "The download didn't match its checksum, so it was deleted." : `Couldn't download cloudflared. ${sentence(reason)}`;

/**
 * The sheet Change opens on a share screen: the same sections (no Off: that is in Settings), then a
 * confirm for a set-up option ("Applies to every link from this computer") or the setup help for one
 * that isn't.
 */
export function OpensAtSheet(props: { info: PublicLinksInfo; mount?: Node; onClose(): void }) {
  const [step, setStep] = createSignal<{ kind: "list" } | { kind: "confirm"; option: OpensAtOption } | { kind: "setup"; option: OpensAtOption }>({ kind: "list" });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const chosen = (kind: "confirm" | "setup"): OpensAtOption | false => {
    const s = step();
    return s.kind === kind ? s.option : false;
  };
  const pick = (o: OpensAtOption) => {
    setError(null);
    if (o.state === "on") return;
    setStep(o.state === "needs-setup" ? { kind: "setup", option: o } : { kind: "confirm", option: o });
  };
  const confirm = async (o: OpensAtOption) => {
    const patch = patchFor(props.info, o.key);
    if (!patch) return;
    setBusy(true);
    setError(null);
    try {
      acceptPublicLinksInfo(await putPublicLinks(patch));
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Portal mount={props.mount}>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal opens-at-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="opens-at-sheet-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id="opens-at-sheet-title">
            Where links open
          </h2>
        </div>
        <div class="modal-body stack">
          <Switch>
            <Match when={step().kind === "list"}>
              <OpensAtChoices info={props.info} idPrefix="sheet" onPick={pick} />
            </Match>
            <Match when={chosen("confirm")}>
              {(o) => (
                <p>
                  Links open with {optionName(o())}. {APPLIES_TO_ALL}
                </p>
              )}
            </Match>
            <Match when={chosen("setup")}>{(o) => <OpensAtSetup kind={o().setup ?? "through"} onOpened={props.onClose} />}</Match>
          </Switch>
          <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't change where links open." body={`${sentence(e())} Your setting is unchanged.`} />}</Show>
        </div>
        <div class="modal-foot">
          <Show when={step().kind !== "list"} fallback={<button type="button" class="button button-ghost" onClick={() => props.onClose()}>Cancel</button>}>
            <button type="button" class="button button-ghost" disabled={busy()} onClick={() => setStep({ kind: "list" })}>
              Back
            </button>
          </Show>
          <Show when={chosen("confirm")}>
            {(o) => (
              <button type="button" class="button button-primary" disabled={busy()} onClick={() => void confirm(o())}>
                {busy() ? "Saving…" : `Use ${optionName(o())}`}
              </button>
            )}
          </Show>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The links that stopped opening because the Free address changed (F3): each kept one with Copy New
 * Link, each other one "Share again". On the Shares page, an open Share sheet and the Previews card.
 */
export function BrokenLinksNotice(props: { kinds?: readonly string[] }) {
  const b = () => {
    const br = publicLinksInfo()?.tunnel?.broken;
    if (!br) return null;
    const links = props.kinds ? br.links.filter((l) => props.kinds!.includes(l.kind)) : br.links;
    return links.length ? { since: br.since, links } : null;
  };
  return (
    <Show when={b()}>
      {(br) => (
        <Banner
          tone="warn"
          title="The public address changed."
          body={
            <span class="stack-2">
              <span>Links sent before {clockOrDay(br().since)} no longer open.</span>
              <span class="opens-at-broken">
                <For each={br().links}>
                  {(l) => (
                    <span class="project-link-row">
                      <span class="project-link-name">{l.title}</span>
                      <Show when={l.kept && l.url} fallback={<span class="field-hint">Share again</span>}>
                        {(url) => (
                          <CopyButton
                            label="Copy New Link"
                            title={`Copy ${l.title}'s new link`}
                            text={() => url()}
                            onCopy={async (t) => {
                              const ok = await copyText(t, "New link copied.");
                              if (ok) void noteHandedOut([t]).then(() => loadPublicLinks());
                              return ok;
                            }}
                          />
                        )}
                      </Show>
                    </span>
                  )}
                </For>
              </span>
            </span>
          }
        />
      )}
    </Show>
  );
}

/** "14:06" today, else "Mar 4, 14:06". */
const clockOrDay = (ms: number): string => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? clockTime(ms) : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clockTime(ms)}`;
};

/** A Free preview's limits, on the Previews card while previews open on free Cloudflare addresses. */
export function FreePreviewNote(props: { running?: number }) {
  return (
    <p class="field-hint opens-at-preview-note">
      Free previews open in a browser only. Scripts, webhooks and apps that stream with server-sent events need Cloudflare Account or your own web server.
      <Show when={props.running !== undefined}>{` ${props.running} of ${PREVIEW_TUNNELS_MAX} free previews running.`}</Show>
    </p>
  );
}

/** The share tunnel's state, for Settings → Public links under Free or Account. */
export function TunnelState(props: { info: PublicLinksInfo }) {
  const t = () => props.info.tunnel?.share;
  const chip = (): { word: string; tone?: "success" | "warn" | "error" | "info" } => {
    if (needsTurnOn(props.info)) return { word: "Not turned on", tone: "warn" };
    switch (t()?.state) {
      case "up":
        return { word: "Verified", tone: "success" };
      case "starting":
        return { word: "Starting", tone: "info" };
      case "needs-cloudflared":
        return { word: "Needs cloudflared", tone: "warn" };
      case "degraded":
      case "failed":
        return { word: "Tunnel down", tone: "error" };
      default:
        return { word: "Starts when you share" };
    }
  };
  return (
    <Show when={t()}>
      {(s) => (
        <dl class="public-links-address">
          <dt>Tunnel</dt>
          <dd>
            <Chip tone={chip().tone}>{chip().word}</Chip>
            <Show when={s().origin}>{(o) => <code class="text-mono public-links-url">{o()}</code>}</Show>
            <Show when={s().epoch && s().state === "up"}>
              <span class="public-links-source">Since {agoTime(s().epoch!)}</span>
            </Show>
          </dd>
          <Show when={s().reason}>
            <dt class="visually-hidden">Why</dt>
            <dd class="field-hint">{s().reason}</dd>
          </Show>
        </dl>
      )}
    </Show>
  );
}

