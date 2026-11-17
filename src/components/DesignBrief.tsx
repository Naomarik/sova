import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js";
import type { DesignBriefQuestion, DesignLinkUse, DesignLook } from "../../shared/design";
import type { DesignAsset, DesignAssetCatalogue } from "../../shared/design-assets";
import { assetKind, shotWords } from "../../shared/design-assets";
import { designBriefBlock, designerSkills } from "../../shared/design";
import type { DesignSpendAsk } from "../lib/design-api";
import { answerLine, assetsOfRun, pickIsRecommended, recommendedPick, runScreenshots, screenUseBy, screenUseOf, shotWordsText, shotWordsToSave, stagedAnswers, startLabel, usedCount, type StagedPick } from "../lib/design-brief";
import type { DesignStore } from "../lib/design-store";
import type { DesignOpener } from "../lib/design-history";
import { coordinatorOf, setupCount, setupSummary, type DesignRunView } from "../lib/design-ui";
import { Inline, QuestionChoices, type QuestionPicker } from "./AlignDocCard";
import { coordinatorChip, DesignAskPanel } from "./DesignCoordinator";
import { DesignCardFoot } from "./DesignCardFoot";
import { createSetupDraft, DesignLinkRow, DesignSetupPickers, type SetupDraft } from "./DesignSetupControls";
import { createAssetCatalogue, DesignBriefImageDetail, DesignBriefImages } from "./DesignBriefImages";
import { DesignSkillsLine } from "./DesignSkills";
import { TextArea, TextField } from "./form";
import { Chip, Icon } from "./ui";
import "./DesignBrief.css";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** A piece of text you can read and press Edit on. What you type is yours until you save or cancel: an update only changes what's shown when you aren't editing. */
function BriefText(props: {
  title: string;
  editLabel: string;
  text: string | null;
  empty: string;
  note?: string;
  boxClass: string;
  fold?: boolean;
  canEdit: boolean;
  noEditWhy?: string;
  save(text: string): Promise<unknown>;
}) {
  const [open, setOpen] = createSignal(!props.fold);
  const [draft, setDraft] = createSignal<string | null>(null);
  const [base, setBase] = createSignal("");
  const [held, setHeld] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const text = createMemo(() => props.text);
  createEffect(on(text, () => setHeld(null), { defer: true }));
  const shown = () => held() ?? text();
  const start = () => {
    setBase(shown() ?? "");
    setDraft(shown() ?? "");
    setError("");
  };
  const save = async () => {
    const next = draft();
    if (next === null) return;
    setBusy(true);
    setError("");
    try {
      await props.save(next);
      setHeld(next);
      setDraft(null);
    } catch (e) {
      setError(`${message(e, "That couldn't be saved.")} Your text is still in the box.`);
    } finally {
      setBusy(false);
    }
  };
  const movedOn = () => draft() !== null && (text() ?? "") !== base() && held() === null;
  const note = () => error() || (movedOn() ? "The Creative Director changed this while you typed. Saving replaces its version." : props.note || "");
  return (
    <section class="design-brief-text" data-fold={props.fold ? "" : undefined} aria-label={props.title}>
      <div class="design-brief-text-head">
        <Show when={props.fold} fallback={<h4 class="design-brief-title">{props.title}</h4>}>
          <button type="button" class="design-brief-fold" aria-expanded={open()} onClick={() => setOpen(!open())}>
            <Icon name="chevron-right" small class={`icon-twist${open() ? " design-brief-twist-open" : ""}`} />
            <span class="design-brief-title">{props.title}</span>
          </button>
        </Show>
        <span class={`text-caption design-brief-note${error() ? " field-error" : " text-muted"}`} role={error() ? "alert" : undefined} title={note()}>
          {note()}
        </span>
        <Show when={open()}>
          <Show
            when={draft() !== null}
            fallback={
              <button type="button" class="button button-sm" disabled={!props.canEdit} title={props.canEdit ? undefined : props.noEditWhy} onClick={start}>
                {props.editLabel}
              </button>
            }
          >
            <div class="design-brief-edit-actions">
              <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="button" class="button button-sm button-primary" disabled={busy() || !draft()!.trim() || draft() === base()} onClick={() => void save()}>
                Save
              </button>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={open()}>
        <div class={`design-brief-box ${props.boxClass}`}>
          <Show when={draft() !== null} fallback={<div class={shown() ? "design-brief-read" : "design-brief-read text-muted"}>{shown() || props.empty}</div>}>
            <TextArea class="design-brief-area" label={props.title} hideLabel value={draft()!} onInput={setDraft} />
          </Show>
        </div>
      </Show>
    </section>
  );
}

function BriefQuestion(props: { q: DesignBriefQuestion; staged: Accessor<StagedPick | undefined>; stage(pick: StagedPick | undefined): void }) {
  const answered = () => props.q.answer;
  const picker: QuestionPicker = {
    blocked: () => (answered() ? "Already answered" : null),
    picked: () => answered()?.option ?? props.staged()?.option,
    pick: (i) => props.stage(i === null ? undefined : { option: i }),
    ticked: () => pickIsRecommended(props.q, answered() ?? props.staged()),
    tick: (on) => props.stage(on ? recommendedPick(props.q) : undefined),
  };
  return (
    <li class="align-q design-brief-q" data-open-q={answered() ? undefined : ""}>
      <p class="align-q-head">
        <span class="text-mono align-q-id">{props.q.id}</span>
        <strong class="align-q-topic">{props.q.topic}</strong>
        <Chip tone={answered() ? "success" : "accent"}>{answered() ? `Answered · ${answered()!.by === "you" ? "you" : "recommended"}` : "Open"}</Chip>
      </p>
      <p class="align-q-ask">
        <Inline text={props.q.ask} />
      </p>
      <Show when={props.q.context}>
        <p class="align-q-context">
          <Inline text={props.q.context ?? ""} />
        </p>
      </Show>
      <QuestionChoices id={props.q.id} options={props.q.options} recommendation={props.q.recommendation} picker={picker} />
      <Show when={!props.q.options?.length}>
        <TextField label={`Your answer to ${props.q.id}`} hideLabel placeholder="Or say it in your own words" disabled={!!answered()} value={answered()?.text ?? props.staged()?.text ?? ""} onInput={(text) => props.stage(text ? { text } : undefined)} />
      </Show>
    </li>
  );
}

function LookText(props: { url: string; look: DesignLook | undefined; run: DesignRunView; store: DesignStore; many: boolean }) {
  const ready = () => (props.look?.state === "ready" ? props.look : undefined);
  const empty = () => (props.look?.state === "unread" ? props.look.reason : "Reading the page's look.");
  const note = () => (ready()?.by === "user" ? "Yours" : ready()?.model ? `Read by ${ready()!.model}` : "");
  return (
    <BriefText
      title={props.many ? props.url : "The look designers will get, in words"}
      editLabel="Edit Look"
      text={ready()?.text ?? null}
      empty={empty()}
      note={note()}
      boxClass="design-brief-look"
      canEdit={!!ready()}
      noEditWhy="Waits until the look is read."
      save={(text) => props.store.api.briefEdit(props.run.id, { field: "look", url: props.url, text })}
    />
  );
}

function BriefScreen(props: { run: DesignRunView; store: DesignStore; contentOnly: boolean }) {
  const [redirecting, setRedirecting] = createSignal(false);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const screen = () => props.run.brief?.screen;
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await props.store.api.briefNotThisScreen(props.run.id, text().trim() || undefined);
      setText("");
      setRedirecting(false);
      props.store.refresh();
    } catch (e) {
      setError(message(e, "That didn't reach the Creative Director. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="design-brief-screen" aria-label={screen() ? "The screen found" : "The screen"}>
      <div class="design-brief-text-head">
        {/* The slot keeps its room in every state; only its heading and words say which. */}
        <h4 class="design-brief-title">{screen() ? "The screen found" : props.contentOnly ? "No screen" : "The screen"}</h4>
        <span class="text-caption text-muted design-brief-note" title={screen()?.url}>
          {screen()?.url ?? ""}
        </span>
        <Show when={screen()}>
          <button type="button" class="button button-sm" onClick={() => setRedirecting(true)}>
            Not This Screen
          </button>
        </Show>
      </div>
      <div class="design-brief-screen-picture">
        <Show when={screen()} fallback={<p class="text-muted design-brief-screen-empty">{props.contentOnly ? "Your link is part of the page's content, so no screen is looked at." : "The Creative Director hasn't shown a screen yet."}</p>}>
          {(s) => (
            <>
              <For each={s().screenshots}>{(src) => <img src={props.store.api.shotUrl(src)} alt="The screen the Creative Director found" />}</For>
              <Show when={s().screenshots.length === 0 && s().outline}>{(o) => <pre class="design-confirm-outline">{o()}</pre>}</Show>
            </>
          )}
        </Show>
      </div>
      <Show when={screen()?.text}>
        <p class="text-caption text-muted design-brief-screen-caption" title={screen()?.text}>
          {screen()?.text}
        </p>
      </Show>
      <Show when={redirecting()}>
        <form
          class="design-brief-redirect"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <TextArea label="Which screen or address to use instead" rows="2" value={text()} onInput={setText} />
          <Show when={error()}>
            <p class="field-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="button-row design-brief-edit-actions">
            <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => setRedirecting(false)}>
              Cancel
            </button>
            <button type="submit" class="button button-sm button-primary" disabled={busy()}>
              Send to Creative Director
            </button>
          </div>
        </form>
      </Show>
    </section>
  );
}

/** A pasted screenshot on the brief: its kind, its measured colours, its words for designers, and Rebuild or Feel. */
function BriefShot(props: { asset: DesignAsset; run: DesignRunView; store: DesignStore; use: "rebuild" | "feel" | null; onUse(use: "rebuild" | "feel"): void; onOpen(): void }) {
  const found = () => shotWords(props.asset);
  const colors = () => found()?.words.colors ?? (props.asset.palette ?? []).map((p) => ({ hex: p.hex, role: "" }));
  const describing = () => props.run.imagesBusy === "describing" || (!props.asset.description && !props.asset.describeError) || !!props.asset.describeAgain;
  const feelEmpty = () => (describing() ? "Its words are being drafted." : "Its feel couldn't be read, so designers get only its colours. Edit to say it yourself.");
  const by = () => ({ user: "Yours", coordinator: "The Creative Director's", helper: "A first draft" })[found()?.by ?? "helper"];
  const save = async (text: string) => {
    const words = shotWordsToSave(text, found()?.words.colors ?? []);
    await props.store.api.imageNote(props.asset.name, { words });
    props.store.refresh();
  };
  const [dropping, setDropping] = createSignal(false);
  const drop = async () => {
    setDropping(true);
    try {
      await props.store.api.imageNote(props.asset.name, { words: null });
      props.store.refresh();
    } catch {
      // The words stay as they were; the button can be pressed again.
    } finally {
      setDropping(false);
    }
  };
  const choice = (use: "rebuild" | "feel", label: string) => (
    <button type="button" class="button" aria-pressed={props.use === use} onClick={() => props.onUse(use)}>
      {label}
    </button>
  );
  return (
    <section class="design-shot" aria-label={`Screenshot ${props.asset.name}`}>
      <div class="design-shot-head">
        <button type="button" class="design-shot-thumb" aria-label={`Details of ${props.asset.name}`} onClick={() => props.onOpen()}>
          <img src={props.store.api.assetUrl(props.asset.name, "small")} alt="" loading="lazy" />
        </button>
        <div class="design-shot-facts">
          <p class="design-shot-title">
            <span class="text-mono design-asset-name">{props.asset.name}</span> <span class="design-asset-kind">{assetKind(props.asset)}</span>
            <span class="text-caption text-muted design-shot-by">{screenUseBy(props.run.brief, props.asset.name)}</span>
            <Show when={found()?.by === "user"}>
              <button type="button" class="button button-sm button-ghost design-shot-drop" disabled={dropping()} title="Your words go; the Creative Director's or the first draft's come back." onClick={() => void drop()}>
                Drop My Words
              </button>
            </Show>
          </p>
          <ul class="design-shot-swatches" aria-label={`Colours of ${props.asset.name}`}>
            <For each={colors()} fallback={<li class="text-caption text-muted">No colours measured.</li>}>
              {(c) => (
                <li class="design-shot-swatch" title={c.role ? `${c.hex} · ${c.role}` : c.hex}>
                  <span class="design-shot-chip" style={{ background: c.hex }} aria-hidden="true" />
                  <code class="text-mono">{c.hex}</code>
                  <span class="visually-hidden">{c.role}</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
      <div class="design-link-use design-shot-use" role="group" aria-label={`How to use ${props.asset.name}`}>
        {choice("rebuild", "Rebuild This Screen")}
        {choice("feel", "Just Its Feel")}
      </div>
      <BriefText
        title={`Words for designers · ${props.asset.name}`}
        editLabel="Edit Words"
        text={found()?.words.feel || found()?.words.colors.length ? shotWordsText(found()!.words) : null}
        empty={feelEmpty()}
        note={found() && !found()!.words.feel && !describing() ? "The feel couldn't be read" : found() ? by() : ""}
        boxClass="design-brief-notes"
        canEdit
        save={save}
      />
    </section>
  );
}

/**
 * The brief at full size: a native dialog over the window (a sheet on a phone), so it reads at its own
 * length instead of scrolling inside the card. Opened with showModal, so the page behind is inert;
 * Escape and Close put focus back on what opened it.
 */
export function DesignBriefDialog(props: { title: string; sub?: string; onClose(): void; children: JSX.Element; focus?: string | null }) {
  let dialog!: HTMLDialogElement;
  const opener = document.activeElement as HTMLElement | null;
  onMount(() => {
    dialog.showModal();
    // Opened to settle something (a link's use): that thing is brought into view.
    if (props.focus) queueMicrotask(() => dialog.querySelector(props.focus!)?.scrollIntoView({ block: "center" }));
  });
  onCleanup(() => {
    if (opener?.isConnected) opener.focus();
  });
  return (
    <dialog ref={dialog} class="design-brief-dialog" aria-label={props.title} onClose={() => props.onClose()}>
      <div class="sheet-grip" aria-hidden="true" />
      <div class="modal-head design-brief-dialog-head">
        <div class="design-brief-dialog-titles">
          <h2 class="modal-title">{props.title}</h2>
          <Show when={props.sub}>
            <p class="text-caption text-muted design-brief-dialog-sub">{props.sub}</p>
          </Show>
        </div>
        <button type="button" class="button button-icon button-ghost" aria-label="Close" onClick={() => dialog.close()}>
          <Icon name="close" />
        </button>
      </div>
      <div class="modal-body design-brief-dialog-body">{props.children}</div>
      <div class="modal-foot">
        <span class="modal-spacer" />
        <button type="button" class="button" autofocus onClick={() => dialog.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/** Whether the chat's open Lookbook view is this run's brief. */
const briefShown = (nav: DesignOpener, runId: string): boolean => {
  const t = nav.target();
  return t?.kind === "brief" && t.runId === runId;
};

/** "Revision 3 · 2 answers · 3 images used": the brief's line under its name. */
function briefFacts(run: DesignRunView, imagesUsed: number): string {
  const b = run.brief;
  if (!b) return "";
  const answered = b.questions.filter((q) => q.answer).length;
  const parts = [`Revision ${b.rev}`];
  if (answered) parts.push(`${answered} answer${answered === 1 ? "" : "s"}`);
  if (imagesUsed) parts.push(`${imagesUsed} image${imagesUsed === 1 ? "" : "s"} used`);
  return parts.join(" · ");
}

/** The brief while it is open: a short preview, the Creative Director's questions and Start. The rest opens full size. */
export function DesignBriefStep(props: { run: DesignRunView; store: DesignStore; nav: DesignOpener; onOpenCoordinator(): void }) {
  const setup: SetupDraft = createSetupDraft(() => props.run, props.store);
  const [staged, setStaged] = createSignal<Record<string, StagedPick>>({});
  const [uses, setUses] = createSignal<Record<string, DesignLinkUse>>({});
  const [changing, setChanging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [ask, setAsk] = createSignal<DesignSpendAsk | null>(null);
  const [openImage, setOpenImage] = createSignal<string | null>(null);
  // The full-size brief is one step in the browser's history (Back closes it), shared with the chat's
  // other Lookbook views; `focus` is what it was last opened to settle.
  const [focus, setFocus] = createSignal<string | null>(null);
  const dialogOpen = () => briefShown(props.nav, props.run.id);
  const setDialog = (d: { focus: string | null }) => {
    setFocus(d.focus);
    props.nav.open({ kind: "brief", runId: props.run.id });
  };
  const catalogue = createAssetCatalogue(props.store);
  const opened = () => catalogue()?.assets.find((a) => a.name === openImage());
  let questions: HTMLOListElement | undefined;
  const brief = () => props.run.brief!;
  const urls = createMemo(() => (props.run.setup.links ?? []).map((l) => l.url), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const linkOf = (url: string) => props.run.setup.links?.find((l) => l.url === url);
  const useOf = (url: string) => uses()[url] ?? linkOf(url)?.use ?? null;
  // A click shows at once; the server's word replaces it when it says the same.
  createEffect(() => {
    const held = uses();
    const left = Object.entries(held).filter(([url, use]) => linkOf(url)?.use !== use);
    if (left.length !== Object.keys(held).length) setUses(Object.fromEntries(left));
  });
  const anyLinks = () => urls().length > 0;
  const feelLinks = () => urls().filter((u) => useOf(u) === "feel");
  const imageLinks = () => urls().filter((u) => useOf(u) === "images");
  const openQuestions = () => brief().questions.filter((q) => !q.answer);
  const toSend = () => stagedAnswers(staged(), brief().questions);
  const runAssets = createMemo(() => assetsOfRun(catalogue(), props.run));
  const shots = createMemo(() => runScreenshots(runAssets(), brief()), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const shotOf = (name: string) => runAssets().find((a) => a.name === name);
  const [shotUses, setShotUses] = createSignal<Record<string, "rebuild" | "feel">>({});
  createEffect(() => {
    const held = shotUses();
    const left = Object.entries(held).filter(([name, use]) => brief().screenUse?.[name]?.use !== use);
    if (left.length !== Object.keys(held).length) setShotUses(Object.fromEntries(left));
  });
  const block = () => designBriefBlock({ brief: brief(), setup: setup.draft(), imagesBusy: props.run.imagesBusy }, shots());
  const designs = () => setupCount(setup.draft()).designs;
  const guard = async (run: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError("");
    try {
      await run();
      props.store.refresh();
      return true;
    } catch (e) {
      setError(message(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setUse = (url: string, use: DesignLinkUse) => {
    setUses({ ...uses(), [url]: use });
    void guard(() => props.store.api.briefLink(props.run.id, url, use), "That choice couldn't be saved. Try again.").then((ok) => {
      if (ok) return;
      const { [url]: _gone, ...rest } = uses();
      setUses(rest);
    });
  };
  const setShotUse = (name: string, use: "rebuild" | "feel") => {
    setShotUses({ ...shotUses(), [name]: use });
    void guard(() => props.store.api.briefScreen(props.run.id, name, use), "That choice couldn't be saved. Try again.").then((ok) => {
      if (ok) return;
      const { [name]: _gone, ...rest } = shotUses();
      setShotUses(rest);
    });
  };
  const sendAnswers = async () => {
    if (await guard(() => props.store.api.briefAnswers(props.run.id, { picks: toSend() }), "Your answers didn't reach the Creative Director. They're still picked.")) setStaged({});
  };
  const recommend = async () => {
    if (await guard(() => props.store.api.briefAnswers(props.run.id, { recommended: true }), "That didn't reach the Creative Director. Try again.")) setStaged({});
  };
  // Start waiting on something takes you to it: a question on the card, a choice in the full brief.
  const jumpToWhatBlocks = () => {
    const code = block()?.code;
    if (code === "question") questions?.querySelector("[data-open-q]")?.scrollIntoView({ block: "center", behavior: "smooth" });
    else if (code === "link-use") setDialog({ focus: ".design-link-row" });
    else if (code === "screenshot-use") setDialog({ focus: ".design-shot" });
  };
  const start = async (confirmSpend: boolean) => {
    if (block()) return jumpToWhatBlocks();
    setBusy(true);
    setError("");
    try {
      await setup.flush();
      const asks = await props.store.api.briefStart(props.run.id, brief().rev, confirmSpend);
      if (asks) setAsk(asks);
      else props.store.refresh();
    } catch (e) {
      setError(message(e, "The designs couldn't start. Try again."));
      props.store.refresh();
    } finally {
      setBusy(false);
    }
  };
  const answersButton = () => (
    <Show when={openQuestions().length > 0}>
      <Show
        when={toSend().length > 0}
        fallback={
          <button type="button" class="button" disabled={busy()} onClick={() => void recommend()}>
            Go With Recommendations
          </button>
        }
      >
        <button type="button" class="button" disabled={busy()} onClick={() => void sendAnswers()}>
          Send Answers
        </button>
      </Show>
    </Show>
  );
  const coordinator = () => coordinatorOf(props.store.view());
  const pendingAsk = () => coordinator()?.ask;
  const promptNote = () => {
    if (brief().writing) return brief().writing!.stalled ? "The Creative Director stopped before writing this" : "Being written";
    return brief().promptBy === "user" ? "Yours" : "What the design sessions get";
  };
  const conflictWords: Record<string, string> = {
    summary: "You edited the summary.",
    told: "You told the Creative Director something new.",
    answer: "You answered a question.",
    screen: "The screen changed.",
  };
  const facts = () => briefFacts(props.run, usedCount(runAssets(), {}, brief()));
  // What still waits on you inside the full brief, said on the card so Start's reason is never hidden.
  const waitingInside = () => (block()?.code === "link-use" ? "Choose how to use your link in the full brief." : block()?.code === "screenshot-use" ? "Choose how to use your screenshot in the full brief." : "");
  return (
    <>
      <div class="design-brief-region">
        <section class="design-sect design-brief-preview" aria-label="Design Brief">
          <div class="design-sect-label">
            <h4 class="design-sect-title">Design Brief</h4>
            <p class="text-caption text-muted design-sect-sub">{facts()}</p>
          </div>
          <div class="design-sect-main">
            {/* Four lines kept, whatever the summary's length: the summary being written moves nothing. */}
            <p class={`design-brief-teaser${brief().summary ? "" : " text-muted"}`}>{brief().summary || "The Creative Director is writing the summary."}</p>
            <div class="design-brief-preview-foot">
              <span class={`text-caption design-brief-waiting${waitingInside() ? "" : " text-muted"}`}>{waitingInside() || promptNote()}</span>
              <button type="button" class="button button-sm" onClick={() => setDialog({ focus: null })}>
                Open Brief
              </button>
            </div>
          </div>
        </section>
        <Show when={changing()}>
          <section class="design-sect design-brief-change" aria-label="Change models and directions">
            <div class="design-sect-label">
              <h4 class="design-sect-title">Models and directions</h4>
              <p class="text-caption text-muted design-sect-sub">{setupSummary(setupCount(setup.draft()))}</p>
            </div>
            <div class="design-sect-main design-setup">
              <DesignSetupPickers setup={setup} run={props.run} store={props.store} openKey={`${props.run.id}:brief`} modelsOpen />
              <div class="design-brief-change-foot">
                <button type="button" class="button button-primary" onClick={() => setChanging(false)}>
                  Done
                </button>
              </div>
            </div>
          </section>
        </Show>
        <Show when={brief().questions.length > 0}>
          <section class="design-sect design-brief-questions-sect" aria-label="Questions">
            <div class="design-sect-label">
              <h4 class="design-sect-title">Questions</h4>
              <p class="text-caption text-muted design-sect-sub">
                {brief().questions.length - openQuestions().length} of {brief().questions.length} answered
              </p>
            </div>
            <div class="design-sect-main">
              {/* On a narrow card the answers button sits with the questions, and the foot keeps only Start. */}
              <div class="design-brief-answers-narrow">{answersButton()}</div>
              <ol class="align-questions design-brief-questions" aria-label="The Creative Director's questions" ref={questions}>
                <For each={brief().questions}>
                  {(q) => (
                    <BriefQuestion
                      q={q}
                      staged={() => staged()[q.id]}
                      stage={(pick) => {
                        const { [q.id]: _old, ...rest } = staged();
                        setStaged(pick ? { ...rest, [q.id]: pick } : rest);
                      }}
                    />
                  )}
                </For>
              </ol>
            </div>
          </section>
        </Show>
        {/* The Creative Director last, so its asks coming and going move only what's below them. */}
        <Show when={coordinator()}>
          {(c) => {
            const chip = () => coordinatorChip(c(), props.store.view());
            return (
              <section class="design-card-coordinator design-brief-coordinator" aria-label="Creative Director">
                <div class="design-coordinator-head">
                  <strong class="design-coordinator-title">Creative Director</strong>
                  <Chip live={chip().live} tone={chip().tone}>
                    {chip().text}
                  </Chip>
                  <button type="button" class="button button-sm" onClick={() => props.onOpenCoordinator()}>
                    Chat with the Creative Director
                  </button>
                </div>
                <Show when={props.run.error}>
                  {(e) => (
                    <div class="banner banner-compact banner-error design-brief-banner" role="alert">
                      <Icon name="alert-circle" small class="banner-icon" />
                      <p class="banner-body">{e()}</p>
                    </div>
                  )}
                </Show>
                <Show when={brief().conflict}>
                  {(cf) => (
                    <div class="design-ask" role="group" aria-label="Your Full Prompt would change">
                      <p>{conflictWords[cf().cause]} Your saved Full Prompt doesn't match it now.</p>
                      <div class="design-brief-choice">
                        <button type="button" class="button button-sm" disabled={busy()} onClick={() => void guard(() => props.store.api.briefConflict(props.run.id, "keep"), "That choice couldn't be saved. Try again.")}>
                          Keep My Prompt
                        </button>
                        <button type="button" class="button button-sm" disabled={busy()} onClick={() => void guard(() => props.store.api.briefConflict(props.run.id, "rewrite"), "That choice couldn't be saved. Try again.")}>
                          Rewrite It
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={pendingAsk()}>{(a) => <DesignAskPanel ask={a()} store={props.store} />}</Show>
              </section>
            );
          }}
        </Show>
      </div>
      <DesignCardFoot class="design-brief-foot">
        <div class="design-brief-line">
          <Show
            when={ask()}
            fallback={
              <>
                <span class="design-brief-count">
                  {/* The estimate never gives way: only the count before it is cut when the line runs short; the whole line is its tooltip. */}
                  <span class="design-brief-plan" title={`${setupSummary(setupCount(setup.draft()))}${brief().estimateUsd ? ` · about $${brief().estimateUsd!.toFixed(2)}` : ""}`}>
                    <span class="design-brief-count-text">{setupSummary(setupCount(setup.draft()))}{brief().estimateUsd ? " ·" : ""}</span>
                    <Show when={brief().estimateUsd}>{(usd) => <span class="design-brief-estimate">{`\u00a0about $${usd().toFixed(2)}`}</span>}</Show>
                  </span>
                  <button type="button" class="design-brief-change-link" aria-expanded={changing()} onClick={() => setChanging(!changing())}>
                    Change
                  </button>
                </span>
                <span class={error() || setup.saving() === "error" ? "field-error" : "text-muted"} role={error() ? "alert" : undefined} title={error() || undefined}>
                  {setup.saving() === "error" ? "This selection couldn't be saved. Your clicks are still here." : error()}
                </span>
              </>
            }
          >
            {(a) => (
              <>
                <span>
                  {a().designs} designs{a().estimateUsd ? `, about $${a().estimateUsd!.toFixed(2)}` : ""}.
                </span>
                <span class="text-muted">That's more than {props.store.view()?.caps.askAbove}, so we ask before starting.</span>
                <button type="button" class="button button-sm button-ghost design-brief-line-cancel" disabled={busy()} onClick={() => setAsk(null)}>
                  Cancel
                </button>
              </>
            )}
          </Show>
        </div>
        <div class="design-brief-slot">
          <Show when={ask()} fallback={answersButton()}>
            <button type="button" class="button button-ghost" disabled={busy()} onClick={() => setAsk(null)}>
              Cancel
            </button>
          </Show>
        </div>
        <button type="button" class="button button-primary design-brief-start" aria-disabled={block() ? "true" : undefined} disabled={busy()} title={block()?.label} onClick={() => void start(!!ask())}>
          {/* A new node for each label: new words in the old node would re-centre it, and that counts as a shift. */}
          <Show when={ask() ? `Start ${ask()!.designs} Designs` : startLabel({ brief: brief(), setup: setup.draft(), imagesBusy: props.run.imagesBusy }, designs(), shots())} keyed>
            {(label) => <span>{label}</span>}
          </Show>
        </button>
      </DesignCardFoot>
      <Show when={dialogOpen()}>
        {(_open) => (
          <DesignBriefDialog title="Design Brief" sub={facts()} focus={focus()} onClose={() => props.nav.close()}>
            <div class="design-brief" data-links={anyLinks() ? "" : undefined}>
              <BriefText
                title="Summary"
                editLabel="Edit Summary"
                text={brief().summary}
                empty="The Creative Director is writing the summary."
                boxClass="design-brief-summary"
                canEdit
                save={(text) => props.store.api.briefEdit(props.run.id, { field: "summary", text })}
              />
              <BriefText
                title="Full Prompt"
                editLabel="Edit Prompt"
                text={brief().prompt}
                empty="The Creative Director writes this once your questions are answered."
                note={promptNote()}
                boxClass="design-brief-prompt"
                canEdit={brief().prompt !== null}
                noEditWhy="Waits until it's written."
                save={(text) => props.store.api.briefEdit(props.run.id, { field: "prompt", text })}
              />
              <Show when={(props.run.skills?.length ?? 0) > 0}>
                <DesignSkillsLine run={{ skills: designerSkills(props.run) }} />
              </Show>
              <Show when={anyLinks()}>
                <div class="design-brief-links">
                  <For each={urls()}>{(url) => <DesignLinkRow url={url} use={useOf(url)} onUse={(use) => setUse(url, use)} />}</For>
                </div>
              </Show>
              <Show when={anyLinks() || brief().screen}>
                <BriefScreen run={props.run} store={props.store} contentOnly={urls().length > 0 && urls().every((u) => useOf(u) === "content")} />
              </Show>
              <Show when={anyLinks() || runAssets().length > 0}>
                <div class="design-brief-material">
                  <Show when={opened()}>{(a) => <DesignBriefImageDetail asset={a()} store={props.store} onClose={() => setOpenImage(null)} />}</Show>
                  <Show when={feelLinks().length > 0 || imageLinks().length > 0 || runAssets().length > 0} fallback={<p class="text-muted">{urls().every((u) => useOf(u) === "content") ? "Your link is part of the page's content, so nothing is read from it." : "Choose how to use your link, and what it gives the designers shows here."}</p>}>
                    <For each={feelLinks()}>{(url) => <LookText url={url} look={brief().looks[url]} run={props.run} store={props.store} many={urls().length > 1} />}</For>
                    <For each={imageLinks()}>
                      {(url) => (
                        <BriefText
                          title={urls().length > 1 ? `Colors and fonts · ${url}` : "Colors and fonts from the page"}
                          editLabel="Edit Notes"
                          text={brief().notes?.[url]?.text ?? null}
                          empty="Read from the page once it's captured. Designers get these after the image list."
                          note={brief().notes?.[url]?.by === "user" ? "Yours" : ""}
                          boxClass="design-brief-notes"
                          canEdit
                          save={(text) => props.store.api.briefEdit(props.run.id, { field: "notes", url, text })}
                        />
                      )}
                    </For>
                    <For each={shots()}>
                      {(name) => <Show when={shotOf(name)}>{(a) => <BriefShot asset={a()} run={props.run} store={props.store} use={screenUseOf(brief(), shotUses(), name)} onUse={(use) => setShotUse(name, use)} onOpen={() => setOpenImage(name)} />}</Show>}
                    </For>
                    <Show when={imageLinks().length > 0 || runAssets().length > 0}>
                      <DesignBriefImages run={props.run} store={props.store} catalogue={catalogue()} onOpen={setOpenImage} />
                    </Show>
                  </Show>
                </div>
              </Show>
            </div>
          </DesignBriefDialog>
        )}
      </Show>
    </>
  );
}

/** The brief once designs are being made: one row, and Open Brief to read, full size, what they were started from. */
export function DesignBriefRow(props: { run: DesignRunView; store: DesignStore; nav: DesignOpener }) {
  const open = () => briefShown(props.nav, props.run.id);
  const setOpen = (on: boolean) => (on ? props.nav.open({ kind: "brief", runId: props.run.id }) : props.nav.close());
  const [catalogue, setCatalogue] = createSignal<DesignAssetCatalogue | null>(null);
  void props.store.api.assets().then(setCatalogue, () => {});
  const brief = () => props.run.brief;
  const runAssets = createMemo(() => assetsOfRun(catalogue(), props.run));
  const imagesUsed = () => usedCount(runAssets(), {}, brief());
  return (
    <Show when={brief()}>
      {(b) => (
        <section class="design-sect design-brief-row" aria-label="Design Brief">
          <div class="design-sect-label">
            <h4 class="design-sect-title">Design Brief</h4>
            <p class="text-caption text-muted design-sect-sub">{briefFacts(props.run, imagesUsed())}</p>
          </div>
          <div class="design-sect-main design-brief-row-main">
            <p class="design-brief-row-text" title={b().summary}>
              {b().summary}
            </p>
            <button type="button" class="button button-sm" onClick={() => setOpen(true)}>
              Open Brief
            </button>
          </div>
          <Show when={open()}>
            <DesignBriefDialog title="Design Brief" sub={`${briefFacts(props.run, imagesUsed())}${b().startedAt ? " · what the designs were started from, read only" : ""}`} onClose={() => setOpen(false)}>
              <div class="design-brief-frozen">
                <section class="design-brief-text" aria-label="Summary">
                  <h4 class="design-brief-title">Summary</h4>
                  <p class="design-brief-read">{b().summary}</p>
                </section>
                <Show when={b().prompt}>
                  {(p) => (
                    <section class="design-brief-text" aria-label="Full Prompt">
                      <h4 class="design-brief-title">Full Prompt</h4>
                      <div class="design-brief-box">
                        <div class="design-brief-read">{p()}</div>
                      </div>
                    </section>
                  )}
                </Show>
                <Show when={(props.run.skills?.length ?? 0) > 0}>
                  <DesignSkillsLine run={{ skills: designerSkills(props.run) }} />
                </Show>
                <For each={props.run.setup.links ?? []}>
                  {(l) => (
                    <p class="text-caption">
                      <code class="design-link-url">{l.url}</code> · {l.use === "feel" ? "Just Its Feel" : l.use === "images" ? "Use Its Images" : "Not chosen"}
                    </p>
                  )}
                </For>
                <For each={Object.entries(b().screenUse ?? {})}>
                  {([name, u]) => (
                    <p class="text-caption">
                      <span class="text-mono">{name}</span> · {u.use === "rebuild" ? "Rebuild This Screen" : "Just Its Feel"}
                    </p>
                  )}
                </For>
                <For each={Object.entries(b().looks).flatMap(([url, look]) => (look.state === "ready" ? [{ url, text: look.text }] : []))}>{(l) => <p class="design-brief-read">{l.text}</p>}</For>
                <Show when={b().questions.length > 0}>
                  <section class="design-brief-text" aria-label="Answers">
                    <h4 class="design-brief-title">Answers</h4>
                    <For each={b().questions}>
                      {(q) => (
                        <p class="text-caption">
                          <span class="text-mono">{q.id}</span> <strong>{q.topic}</strong>: {answerLine(q)}
                        </p>
                      )}
                    </For>
                  </section>
                </Show>
                <Show when={runAssets().length > 0}>
                  <DesignBriefImages run={props.run} store={props.store} catalogue={catalogue()} onOpen={() => {}} readOnly />
                </Show>
              </div>
            </DesignBriefDialog>
          </Show>
        </section>
      )}
    </Show>
  );
}
