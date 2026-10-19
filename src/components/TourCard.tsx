import { createContext, createEffect, createMemo, createSignal, For, on, onCleanup, Show, useContext } from "solid-js";
import { Portal } from "solid-js/web";
import type { TourCardDetails, TourJob } from "../../shared/tour";
import { TOUR_ASK_TO_RECORD, TOUR_SIGNED_IN_CAPTION, TOUR_SIGNIN_EMPTY, TOUR_SIGNIN_PRIVACY, takeTourSignIn, tourJobActive, tourSignInWantsAccount, tourJobLabel, tourJobLocation, tourRecordAgain, tourShareAllowed, tourSignInPayload, type TourSignInFields } from "../lib/tour-state";
import { ownerTourApi, type TourSite } from "../lib/tour-api";
import { Icon } from "./ui";
import { TourReadCard } from "./TourReadCard";
import { TourShare, type TourBinding } from "./TourShare";
import "./TourViewer.css";

export interface TourSessionHost {
  sessionId(): string | undefined;
  host(): string | null;
  canAsk(): boolean;
  ask(question: string): void;
}
export const TourSessionContext = createContext<TourSessionHost | null>(null);

/** Owner adapter only. Public/hand-off hosts use TourReadCard with their own scoped callbacks. */
export function TourCard(props: { details: TourCardDetails }) {
  const host = useContext(TourSessionContext);
  const [job, setJob] = createSignal<TourJob>();
  const [edition, setEdition] = createSignal(props.details.editionId);
  const [share, setShare] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [testAccount, setTestAccount] = createSignal(false);
  // The form sign-in: typed values live only here until submit, then go straight to the request.
  const [signIn, setSignIn] = createSignal<TourSignInFields>({ ...TOUR_SIGNIN_EMPTY });
  const setField = (key: keyof TourSignInFields, value: string) => setSignIn(f => ({ ...f, [key]: value }));
  // The edition's share lock as the server last reported it; Share stays hidden until it has.
  const [lock, setLock] = createSignal({ loaded: false, signedIn: false });
  const [bindings, setBindings] = createSignal<TourBinding[]>([]);
  const [bindingsError, setBindingsError] = createSignal("");
  const [detachConfirm, setDetachConfirm] = createSignal<string>();
  const [sites, setSites] = createSignal<TourSite[]>([]);
  const [removeConfirm, setRemoveConfirm] = createSignal<string>();
  const sid = createMemo(() => host?.sessionId());
  const peer = createMemo(() => host?.host() ?? null);
  const api = createMemo(() => sid() ? ownerTourApi(sid()!, props.details.tourId, peer()) : undefined);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const phase = () => job()?.phase ?? props.details.status;
  const refresh = async () => {
    const a = api(); if (!a) return;
    try {
      const latest = await a.latest();
      if (disposed) return;
      if (latest.editionId) setEdition(latest.editionId);
      setLock({ loaded: !!latest.editionId && latest.editionId === edition(), signedIn: latest.signedIn });
      setSites(latest.sites);
      if (latest.job) setJob(latest.job);
      else if (props.details.jobId) setJob(await a.job(props.details.jobId));
      setError("");
    } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Recording status couldn't be loaded."); }
    if (!disposed && tourJobActive(phase())) timer = setTimeout(() => void refresh(), 1500);
  };
  const refreshBindings = async () => {
    const a = api(), ed = edition();
    if (!a || !ed) return;
    try { const rows = await a.bindings(ed); if (!disposed && ed === edition()) { setBindings(rows); setBindingsError(""); } }
    catch (e) { if (!disposed) setBindingsError(e instanceof Error ? e.message : "Tour attachments couldn't be loaded."); }
  };
  createEffect(on(api, () => { clearTimeout(timer); void refresh(); }));
  createEffect(on(() => [api(), edition()] as const, () => { setBindings([]); setDetachConfirm(undefined); void refreshBindings(); }));
  onCleanup(() => { disposed = true; clearTimeout(timer); setPassword(""); setUsername(""); setSignIn({ ...TOUR_SIGNIN_EMPTY }); });
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); clearTimeout(timer); await refresh(); }
    catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "The request failed. Try again."); }
    finally { if (!disposed) setBusy(false); }
  };
  const recordAgain = () => { const a = api(); if (a) void action(async () => { const next = await a.recordAgain(); setJob(next); }); };
  const ask = (text: string) => { if (host?.canAsk()) host.ask(text); };
  return <div class="tour-owner-card">
    <Show when={!host?.sessionId()}><p class="field-hint">Open this conversation in its chat to load the tour.</p></Show>
    <Show when={api()}>{a => <>
      <Show when={phase() !== "ready"}><section class="tour-card card tour-job" aria-label={`Tour recording: ${props.details.title}`}><div class="tour-job-head"><div><span class="text-caption text-muted">Guided tour</span><h3>{props.details.title}</h3></div><span class={`chip ${phase() === "failed" ? "chip-error" : phase() === "interrupted" || phase() === "needs-sign-in" ? "chip-warn" : ""}`} role="status"><i class="chip-dot" />{tourJobLabel(phase(), job()?.size, job()?.queuePosition, job()?.requirements?.signIn)}</span></div>
        <Show when={job()}>{j => <><p class="text-caption text-muted">{tourJobLocation(j())}</p><Show when={j().failure}>{f => <div class="tour-job-failure"><p>{f().message}</p><p>{f().guidance}</p><Show when={f().nearest?.length}><p>Nearest matches: {f().nearest!.join(", ")}</p></Show></div>}</Show></>}</Show>
        <Show when={edition()}><p class="text-caption text-muted">The previous checked edition stays available below.</p></Show>
        <Show when={phase() === "needs-site-approval" && job()?.requirements?.origins?.length}><p>Approve each site for this recording. Approval doesn't change the chat's sandbox access.</p><Show when={job()!.requirements!.origins!.length > 1}><div class="button-row"><button type="button" class="button button-primary" disabled={busy()} onClick={() => { const shown = [...job()!.requirements!.origins!]; void action(() => a().approveAll(job()!.id, shown)); }}>Approve All</button></div></Show><For each={job()?.requirements?.origins}>{origin => <div class="tour-site-approval"><code>{origin}</code><button type="button" class="button" disabled={busy()} onClick={() => void action(() => a().approve(job()!.id, origin))}>Approve Site</button></div>}</For></Show>
        <Show when={phase() === "needs-test-account" && job()?.requirements?.testAccount}>{account => <form class="tour-account" onSubmit={e => { e.preventDefault(); if (!testAccount() || !username().trim() || !password()) return; const secret = password(); setPassword(""); void action(() => a().account(job()!.id, { origin: account().origin, username: username(), password: secret, testAccount: true })); }}><p>Use a test account for <code>{account().origin}</code>. Only HTTP Basic sign-in is supported here. Its password is stored in protected local account state, never in this tour.</p><Show when={account().reason}><p>{account().reason}</p></Show><label class="field"><span class="field-label">Test username</span><input class="input" autocomplete="off" value={username()} onInput={e => setUsername(e.currentTarget.value)} /></label><label class="field"><span class="field-label">Test password</span><input class="input" type="password" autocomplete="new-password" value={password()} onInput={e => setPassword(e.currentTarget.value)} /></label><label class="tour-review-check"><input type="checkbox" checked={testAccount()} onChange={e => setTestAccount(e.currentTarget.checked)} /><span>This is a test account, not my personal account.</span></label><button type="submit" class="button" disabled={busy() || !testAccount() || !username().trim() || !password()}>Use Test Account</button></form>}</Show>
        <Show when={phase() === "needs-sign-in" && job()?.requirements?.signIn}>{need => <form class="tour-account tour-signin" aria-describedby="tour-signin-privacy" onSubmit={e => { e.preventDefault(); const taken = takeTourSignIn(need(), signIn()); if (!taken.body) return; setSignIn(taken.fields); const body = taken.body, id = job()!.id; void action(() => a().signIn(id, body)); }}><p>Sign in to <code>{need().origin}</code> so the recording can continue.</p><Show when={need().reason}><p>{need().reason}</p></Show><Show when={need().fields[0] === "code"} fallback={<><Show when={tourSignInWantsAccount(need())}><label class="field"><span class="field-label">Account</span><input class="input" name="account" autocomplete="off" value={signIn().account} onInput={e => setField("account", e.currentTarget.value)} /></label></Show><label class="field"><span class="field-label">Username</span><input class="input" name="username" autocomplete="username" value={signIn().username} onInput={e => setField("username", e.currentTarget.value)} /></label><label class="field"><span class="field-label">Password</span><input class="input" name="password" type="password" autocomplete="current-password" value={signIn().password} onInput={e => setField("password", e.currentTarget.value)} /></label></>}><label class="field"><span class="field-label">One-Time Code</span><input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" value={signIn().code} onInput={e => setField("code", e.currentTarget.value)} /></label></Show><p id="tour-signin-privacy" class="field-hint">{TOUR_SIGNIN_PRIVACY}</p><button type="submit" class="button button-primary" disabled={busy() || !tourSignInPayload(need(), signIn())}>{need().fields[0] === "code" ? "Send Code" : "Sign In"}</button></form>}</Show>
        <div class="button-row"><Show when={tourJobActive(phase()) && (job()?.id ?? props.details.jobId)}><button type="button" class="button button-ghost" disabled={busy()} onClick={() => void action(() => a().cancel(job()?.id ?? props.details.jobId!))}>Cancel</button></Show><Show when={tourRecordAgain(phase(), !!edition()) === "button"}><button type="button" class="button" disabled={busy()} onClick={recordAgain}>Re-record</button></Show></div>
        <Show when={tourRecordAgain(phase(), !!edition()) === "ask"}><p class="field-hint">{TOUR_ASK_TO_RECORD}</p></Show>
      </section></Show>
      <Show when={edition()} keyed>{ed => <TourReadCard title={props.details.title} steps={props.details.steps} loadManifest={() => a().manifest(ed)} assetUrl={file => a().assetUrl(ed, file)} loadProgress={() => a().progress(ed)} saveProgress={p => a().saveProgress(ed, p)} loadDestinations={() => a().destinations(ed)} onAsk={host?.canAsk() ? ask : undefined} onShare={tourShareAllowed(lock()) ? () => setShare(ed) : undefined} actions={<button type="button" class="button button-ghost" disabled={busy() || tourJobActive(phase())} onClick={recordAgain}><Icon name="refresh" />Re-record</button>} />}</Show>
      <Show when={edition() && lock().loaded && lock().signedIn}><p class="field-hint">{TOUR_SIGNED_IN_CAPTION}</p></Show>
      <Show when={bindings().length}><section class="tour-card card tour-job" aria-label="Attached hand-offs"><h3>Attached Hand-offs</h3><For each={bindings()}>{binding => <div class="tour-binding"><p><b>{binding.publicTitle}</b> · {binding.orgName} · {binding.holder ? `With ${binding.holder}` : "With you"}</p><Show when={detachConfirm() === binding.handle} fallback={<button type="button" class="button button-ghost" disabled={busy()} onClick={() => setDetachConfirm(binding.handle)}>Detach</button>}><p>The tour stops opening in this hand-off. Its conversation and the original tour stay.</p><div class="button-row"><button type="button" class="button button-destructive" disabled={busy()} onClick={() => void action(async () => { await a().detach(edition()!, binding.handle, binding.destinationSessionId); setDetachConfirm(undefined); await refreshBindings(); })}>Detach Tour</button><button type="button" class="button button-ghost" onClick={() => setDetachConfirm(undefined)}>Cancel</button></div></Show></div>}</For></section></Show>
      <Show when={sites().some(s => s.approved || s.account)}><section class="tour-card card tour-job" aria-label="Sites and test accounts"><h3>Sites and Test Accounts</h3><p class="text-caption text-muted">Approvals and test accounts apply to every tour on this computer. A recording that needs one again asks again.</p><For each={sites().filter(s => s.approved || s.account)}>{site => <div class="tour-site-approval"><code>{site.origin}</code><div class="button-row"><Show when={site.approved}><button type="button" class="button button-ghost" disabled={busy()} onClick={() => void action(async () => setSites(await a().revokeSite(site.origin)))}>{tourJobActive(phase()) ? "Revoke Site and Stop Recording" : "Revoke Site"}</button></Show><Show when={site.account && removeConfirm() !== site.origin}><button type="button" class="button button-ghost" disabled={busy()} onClick={() => setRemoveConfirm(site.origin)}>Remove Account</button></Show></div><Show when={site.account && removeConfirm() === site.origin}><p>Remove this test account? You'll need to enter its password again.</p><div class="button-row"><button type="button" class="button button-destructive" disabled={busy()} onClick={() => void action(async () => { setSites(await a().removeAccount(site.origin)); setRemoveConfirm(undefined); })}>Remove Account</button><button type="button" class="button button-ghost" onClick={() => setRemoveConfirm(undefined)}>Cancel</button></div></Show></div>}</For></section></Show>
      <Show when={bindingsError()}><p class="field-error" role="status">{bindingsError()} <button type="button" class="button button-ghost" onClick={() => void refreshBindings()}>Retry Attachments</button></p></Show>
      <Show when={share()} keyed>{ed => <Portal><TourShare loadPreview={() => a().sharePreview(ed)} assetUrl={file => a().assetUrl(ed, file)} createLink={(id, expires) => a().share(ed, id, expires)} loadDestinations={() => a().bindingDestinations(ed)} loadBindingPreview={sid => a().bindingPreview(ed, sid)} bind={(id, sid) => a().bind(ed, id, sid)} onBound={() => void refreshBindings()} onClose={() => setShare(undefined)} /></Portal>}</Show>
    </>}</Show>
    <Show when={error()}><p class="field-error" role="alert">{error()} <button type="button" class="button button-ghost" disabled={busy()} onClick={() => { clearTimeout(timer); void refresh(); }}>Retry Status</button></p></Show>
  </div>;
}
