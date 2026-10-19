import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { normalizeTourPresentation, normalizeTourProgress, type TourPresentation, type TourProgress } from "../../shared/tour";
import { TourViewer } from "../components/TourViewer";
import { createTourProgressSaver } from "../lib/tour-progress-save";
import { visitTab } from "./visit-tab";

/** Standalone edition reader: no conversation, owner API, recorded-site URL or recording controls. */
export function TourShareApp() {
  const token = /^\/t\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1];
  const base = token ? `/api/t/${token}` : "";
  const [manifest, setManifest] = createSignal<TourPresentation>();
  const [progress, setProgress] = createSignal<TourProgress>();
  const [reader, setReader] = createSignal<string>();
  const [open, setOpen] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const [note, setNote] = createSignal("Your place is saved for this resume link, independently of other readers.");
  const [resume, setResume] = createSignal<string>();
  // A place picked before the resume reader exists is written once it does, not dropped.
  let readerKnown!: (value: string | null) => void;
  const readerReady = new Promise<string | null>(resolve => { readerKnown = resolve; });
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(path, { ...init, signal: controller.signal, credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 404 ? "This tour link is no longer available. Ask the person who sent it for a new one." : response.status === 429 ? "This tour is being read a lot right now. Wait a minute, then reload." : "This tour could not be loaded. Nothing has changed. Try reloading the page.");
    return response.json();
  }
  onMount(() => {
    void (async () => {
      if (!token) throw new Error("This link doesn't open a tour. Check that you copied the whole link.");
      let visitStorage: Storage | null = null;
      try { visitStorage = sessionStorage; } catch { /* A blocked tab store still gets an independent visit id. */ }
      const m = normalizeTourPresentation(await json(`${base}?v=${visitTab(visitStorage)}`));
      if (!m) throw new Error("This tour could not be read. Ask the person who sent it for a new link.");
      setManifest(m);
      const existing = new URL(location.href).searchParams.get("reader");
      if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) {
        const p = normalizeTourProgress(await json(`${base}/progress?reader=${existing}`));
        setReader(existing); setProgress(p); readerKnown(existing);
      } else {
        const created = await json(`${base}/readers`, { method: "POST" }) as { reader?: unknown; resumeUrl?: unknown };
        if (typeof created.reader !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(created.reader)) throw new Error("Your place can't be saved yet. You can still read this tour; reload to try again.");
        setReader(created.reader); readerKnown(created.reader);
        const url = new URL(location.href); url.searchParams.set("reader", created.reader); history.replaceState(null, "", url);
      }
    })().catch(error => { readerKnown(null); if (!controller.signal.aborted) { if (manifest()) setNote(error.message); else setProblem(error.message); } });
  });
  const progressWrites = createTourProgressSaver(async position => {
    const current = reader() ?? await readerReady;
    if (!current) throw new Error("No resume link is available.");
    const p = normalizeTourProgress(await json(`${base}/progress?reader=${current}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(position) }));
    if (!p) throw new Error("Position could not be saved.");
    setProgress(p);
  });
  const copyResume = async () => {
    if (!reader()) { setNote("Your place could not be saved. Reload the page before copying a resume link."); return; }
    try { await progressWrites.settled(); }
    catch { setNote("Your latest place couldn't be saved. Reopen the tour and retry saving before copying a resume link."); return; }
    const url = new URL(`/t/${token}`, location.origin); url.searchParams.set("reader", reader()!);
    try { await navigator.clipboard.writeText(url.href); setNote("Resume link copied. Open it on another device to continue from your saved step."); }
    catch { setOpen(false); setResume(url.href); }
  };
  return <main class="share">
    <header class="share-head"><h1 class="share-title">{manifest()?.title ?? "Loading the tour."}</h1><p class="share-status">Recorded tour · read only</p></header>
    <Show when={problem()}><p class="share-note" role="alert">{problem()}</p></Show>
    <Show when={manifest()}>{m => <section class="share-thread" aria-label="Shared tour">
      <p>{m().summary}</p><p class="text-caption text-muted">{m().steps.length} steps · desktop and phone recordings</p>
      <button type="button" class="button button-primary" onClick={() => setOpen(true)}>{progress() ? "Continue Tour" : "Read Tour"}</button>
      <button type="button" class="button button-ghost" disabled={!reader()} onClick={() => void copyResume()}>Copy Resume Link</button>
      <p class="share-note" role="status">{note()}</p>
      <Show when={resume()}><label class="field"><span class="field-label">Resume link</span><input class="input" readonly value={resume()} onFocus={e => e.currentTarget.select()} /></label></Show>
      <Show when={open()}><TourViewer manifest={m()} assetUrl={file => `${base}/assets/${encodeURIComponent(file)}`} initialProgress={progress()} onProgress={progressWrites.save} progressNote={note()} onContinueAcrossDevices={() => void copyResume()} onClose={() => setOpen(false)} /></Show>
    </section>}</Show>
  </main>;
}
