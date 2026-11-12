import { createEffect, createMemo, createSignal, For, on, Show, type Accessor } from "solid-js";
import type { DesignBriefQuestion, DesignLinkUse, DesignLook } from "../../shared/design";
import type { DesignAssetCatalogue } from "../../shared/design-assets";
import { designBriefBlock } from "../../shared/design";
import type { DesignSpendAsk } from "../lib/design-api";
import { answerLine, assetsOfRun, pickIsRecommended, recommendedPick, stagedAnswers, startLabel, usedCount, type StagedPick } from "../lib/design-brief";
import type { DesignStore } from "../lib/design-store";
import { coordinatorOf, setupCount, setupSummary, type DesignRunView } from "../lib/design-ui";
import { Inline, QuestionChoices, type QuestionPicker } from "./AlignDocCard";
import { DesignAskPanel, DesignCoordinatorPanel } from "./DesignCoordinator";
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

/** The brief while it is open: what will be built, the choices around it, and Start. Takes over the card between its head and its foot. */
export function DesignBriefStep(props: { run: DesignRunView; store: DesignStore; onOpenCoordinator(): void }) {
  const setup: SetupDraft = createSetupDraft(() => props.run, props.store);
  const [staged, setStaged] = createSignal<Record<string, StagedPick>>({});
  const [uses, setUses] = createSignal<Record<string, DesignLinkUse>>({});
  const [changing, setChanging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [ask, setAsk] = createSignal<DesignSpendAsk | null>(null);
  const [openImage, setOpenImage] = createSignal<string | null>(null);
  const catalogue = createAssetCatalogue(props.store);
  const opened = () => catalogue()?.assets.find((a) => a.name === openImage());
  let scroller: HTMLDivElement | undefined;
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
  const block = () => designBriefBlock({ brief: brief(), setup: setup.draft(), imagesBusy: props.run.imagesBusy });
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
  const sendAnswers = async () => {
    if (await guard(() => props.store.api.briefAnswers(props.run.id, { picks: toSend() }), "Your answers didn't reach the Creative Director. They're still picked.")) setStaged({});
  };
  const recommend = async () => {
    if (await guard(() => props.store.api.briefAnswers(props.run.id, { recommended: true }), "That didn't reach the Creative Director. Try again.")) setStaged({});
  };
  const jumpToWhatBlocks = () => {
    const code = block()?.code;
    const el = code === "question" ? scroller?.querySelector("[data-open-q]") : code === "link-use" ? scroller?.querySelector(".design-link-row") : null;
    if (el && scroller) scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
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
  return (
    <>
      <div class="design-brief-region">
        <div class="design-card-scroll" ref={scroller}>
          <div class="design-card-body design-brief" data-links={anyLinks() ? "" : undefined}>
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
              fold
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
            <DesignSkillsLine run={props.run} />
            <Show when={anyLinks()}>
              <div class="design-brief-links">
                <For each={urls()}>{(url) => <DesignLinkRow url={url} use={useOf(url)} onUse={(use) => setUse(url, use)} />}</For>
              </div>
            </Show>
            <Show when={anyLinks() || brief().screen}>
              <BriefScreen run={props.run} store={props.store} contentOnly={urls().length > 0 && urls().every((u) => useOf(u) === "content")} />
            </Show>
            <Show when={anyLinks() || assetsOfRun(catalogue(), props.run).length > 0}>
              <div class="design-brief-material">
                <div class="design-brief-material-scroll">
                  <Show when={feelLinks().length > 0 || imageLinks().length > 0 || assetsOfRun(catalogue(), props.run).length > 0} fallback={<p class="text-muted">{urls().every((u) => useOf(u) === "content") ? "Your link is part of the page's content, so nothing is read from it." : "Choose how to use your link, and what it gives the designers shows here."}</p>}>
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
                    <Show when={imageLinks().length > 0 || assetsOfRun(catalogue(), props.run).length > 0}>
                      <DesignBriefImages run={props.run} store={props.store} catalogue={catalogue()} onOpen={setOpenImage} />
                    </Show>
                  </Show>
                </div>
                <Show when={opened()}>{(a) => <DesignBriefImageDetail asset={a()} store={props.store} onClose={() => setOpenImage(null)} />}</Show>
              </div>
            </Show>
            {/* On a narrow card the answers button sits with the questions, and the foot keeps only Start. */}
            <Show when={brief().questions.length > 0}>
              <div class="design-brief-answers-narrow">{answersButton()}</div>
            </Show>
            <Show when={brief().questions.length > 0}>
              <ol class="align-questions design-brief-questions" aria-label="The Creative Director's questions">
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
            </Show>
          </div>
        </div>
        {/* What needs you right now lays over the foot of the brief: it takes no room, so nothing moves. */}
        <Show when={brief().conflict || pendingAsk() || props.run.error}>
          <div class="design-brief-overlays">
            <Show when={props.run.error}>
              {(e) => (
                <div class="banner banner-compact banner-error design-brief-banner" role="alert">
                  <Icon name="alert-circle" small class="banner-icon" />
                  <p class="banner-body">{e()}</p>
                </div>
              )}
            </Show>
            <Show when={brief().conflict}>
              {(c) => (
                <div class="design-ask" role="group" aria-label="Your Full Prompt would change">
                  <p>{conflictWords[c().cause]} Your saved Full Prompt doesn't match it now.</p>
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
          </div>
        </Show>
        <Show when={changing()}>
          <div class="design-brief-change" role="group" aria-label="Change models and directions">
            <div class="design-brief-change-scroll design-setup">
              <DesignSetupPickers setup={setup} />
            </div>
            <div class="design-brief-change-foot">
              <button type="button" class="button button-primary" onClick={() => setChanging(false)}>
                Done
              </button>
            </div>
          </div>
        </Show>
      </div>
      <Show when={coordinator()}>
        {(c) => (
          <div class="design-brief-coordinator">
            <DesignCoordinatorPanel strip coordinator={c()} view={props.store.view()} store={props.store} onOpen={props.onOpenCoordinator} />
          </div>
        )}
      </Show>
      <div class="card-foot design-brief-foot">
        <div class="design-brief-line">
          <Show
            when={ask()}
            fallback={
              <>
                <span class="design-brief-count">
                  <span class="design-brief-count-text">{setupSummary(setupCount(setup.draft()))}{brief().estimateUsd ? ` · about $${brief().estimateUsd!.toFixed(2)}` : ""}</span>
                  <button type="button" class="design-brief-change-link" onClick={() => setChanging(!changing())}>
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
          <Show
            when={ask()}
            fallback={answersButton()}
          >
            <button type="button" class="button button-ghost" disabled={busy()} onClick={() => setAsk(null)}>
              Cancel
            </button>
          </Show>
        </div>
        <button type="button" class="button button-primary design-brief-start" aria-disabled={block() ? "true" : undefined} disabled={busy()} title={block()?.label} onClick={() => void start(!!ask())}>
          {/* A new node for each label: new words in the old node would re-centre it, and that counts as a shift. */}
          <Show when={ask() ? `Start ${ask()!.designs} Designs` : startLabel({ brief: brief(), setup: setup.draft(), imagesBusy: props.run.imagesBusy }, designs())} keyed>
            {(label) => <span>{label}</span>}
          </Show>
        </button>
      </div>
    </>
  );
}

/** The brief once designs are being made: one line, and Expand to read what they were started from. */
export function DesignBriefCollapsed(props: { run: DesignRunView; store: DesignStore }) {
  const [open, setOpen] = createSignal(false);
  const [catalogue, setCatalogue] = createSignal<DesignAssetCatalogue | null>(null);
  void props.store.api.assets().then(setCatalogue, () => {});
  const brief = () => props.run.brief;
  const imagesUsed = () => usedCount(assetsOfRun(catalogue(), props.run), {}, brief());
  return (
    <Show when={brief()}>
      {(b) => (
        <section class="design-brief-collapsed" aria-label="Design Brief">
          <button type="button" class="design-brief-fold" aria-expanded={open()} aria-label={`${open() ? "Collapse" : "Expand"} the Design Brief`} onClick={() => setOpen(!open())}>
            <Icon name="chevron-right" small class={`icon-twist${open() ? " design-brief-twist-open" : ""}`} />
            <span class="design-brief-title">Design Brief</span>
            <span class="text-caption text-muted design-brief-used">{imagesUsed() > 0 ? `${imagesUsed()} image${imagesUsed() === 1 ? "" : "s"} used` : ""}</span>
            {/* A new node for each word, so the change can't count as a move. */}
            <Show when={open() ? "Collapse" : "Expand"} keyed>
              {(word) => <span class="text-caption text-muted design-brief-toggle-word">{word}</span>}
            </Show>
          </button>
          <Show when={open()}>
            <div class="design-brief-frozen">
              <Show when={b().startedAt}>
                <p class="text-caption text-muted">This is what the designs were started from. Read only.</p>
              </Show>
              <p class="design-brief-read">{b().summary}</p>
              <DesignSkillsLine run={props.run} />
              <For each={props.run.setup.links ?? []}>
                {(l) => (
                  <p class="text-caption">
                    <code class="design-link-url">{l.url}</code> · {l.use === "feel" ? "Just Its Feel" : l.use === "images" ? "Use Its Images" : "Not chosen"}
                  </p>
                )}
              </For>
              <For each={Object.entries(b().looks).flatMap(([url, look]) => (look.state === "ready" ? [{ url, text: look.text }] : []))}>{(l) => <p class="design-brief-read">{l.text}</p>}</For>
              <For each={b().questions}>
                {(q) => (
                  <p class="text-caption">
                    <span class="text-mono">{q.id}</span> <strong>{q.topic}</strong>: {answerLine(q)}
                  </p>
                )}
              </For>
              <Show when={b().prompt}>
                {(p) => (
                  <details class="design-brief-frozen-prompt">
                    <summary>
                      <Icon name="chevron-right" small class="icon-twist" />
                      Full Prompt
                    </summary>
                    <div class="design-brief-read">{p()}</div>
                  </details>
                )}
              </Show>
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}

