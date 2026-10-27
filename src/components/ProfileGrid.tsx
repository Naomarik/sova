import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ListedProfile } from "../../shared/profiles";
import { CARD_FILTER_AFTER, cardCount, cardMatches, pickerSections, profileCaptionParts, profileIconName, type CaptionPart, type CardCaption, type pickerProfiles } from "../lib/profiles";
import { foldLabel, foldedRest } from "../lib/name-fit";
import { EffortRing } from "./EffortRing";
import { foldFit } from "./fold-fit";
import { ModeGlyph } from "./ModeGlyph";
import { Icon } from "./ui";

/** Where focus goes when the grid mounts again after a pick (the runtime reopens and remounts the
    picker): the card that was picked, by session path. Module state, like the board's. */
const focusAfterPick = new Map<string, string>();
const CUSTOM_KEY = "custom";

/**
 * The empty screen's profile cards: one radio group, My settings first under no label, a card per
 * profile in the picker's groups, then Custom…. Arrow keys move focus between cards (Home and End
 * to the ends); Enter, Space or a click picks. A card that can't be used here is disabled with its
 * reason, and picking it does nothing. A One at a time profile live in another session is a link
 * to that session instead (no radio: Tab reaches it, the arrow keys skip it). A Find a profile
 * field shows past CARD_FILTER_AFTER cards.
 */
export function ProfileGrid(props: {
  path: string;
  groups: ReturnType<typeof pickerProfiles>;
  /** The checked card's key: a profile's, CUSTOM for a board pick. */
  checked: string | null;
  subagents: readonly { id: string; footprint: string; models?: number }[];
  /** My settings' caption (mySettingsCaptionParts). */
  mineCaption: CardCaption;
  /** The live session holding a One at a time profile elsewhere, or null. */
  holder: (p: ListedProfile) => { id: string; title: string } | null;
  unusable: (p: ListedProfile) => string | null;
  onPick: (p: ListedProfile) => void;
  onCustom: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [focused, setFocused] = createSignal<string | null>(null);
  let root!: HTMLDivElement;
  const filtering = () => cardCount(props.groups) > CARD_FILTER_AFTER;
  const q = () => (filtering() ? query() : "");
  const sections = createMemo(() =>
    pickerSections(props.groups)
      .map((s) => ({ ...s, cards: s.cards.filter((p) => cardMatches(p, q())) }))
      .filter((s) => s.cards.length > 0),
  );
  const active = (p: ListedProfile) => (p.singleton ? props.holder(p) : null);
  // The radios only: an active One at a time card is a link, never in the radio group's order.
  const keys = createMemo(() => [...sections().flatMap((s) => s.cards.filter((p) => !active(p)).map((p) => p.key)), CUSTOM_KEY]);
  // One card is in the tab order: the one focus last moved to, else the checked one, else the first.
  const tabbable = () => {
    const k = keys();
    const f = focused();
    if (f && k.includes(f)) return f;
    return props.checked && k.includes(props.checked) ? props.checked : (k[0] ?? null);
  };
  const cardsEls = () => [...root.querySelectorAll<HTMLElement>('[role="radio"]')];
  const move = (e: KeyboardEvent) => {
    const els = cardsEls();
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (at + 1) % els.length
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (at - 1 + els.length) % els.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? els.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    els[to]!.focus();
  };
  const pick = (p: ListedProfile) => {
    if (props.unusable(p)) return;
    focusAfterPick.set(props.path, p.key);
    props.onPick(p);
  };
  // The remounted grid may draw before the listing has answered: focus the card once it is there.
  createEffect(() => {
    const want = focusAfterPick.get(props.path);
    if (!want || !keys().includes(want)) return;
    focusAfterPick.delete(props.path);
    queueMicrotask(() => root.querySelector<HTMLElement>(`[data-key="${CSS.escape(want)}"]`)?.focus());
  });

  return (
    <div class="profile-grid-wrap">
      <Show when={filtering()}>
        <input
          class="input profile-grid-filter"
          type="search"
          placeholder="Find a profile"
          aria-label="Find a profile"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </Show>
      <div class="profile-grid-groups" role="radiogroup" aria-label="Profile" ref={root} onKeyDown={move} onFocusIn={(e) => setFocused((e.target as HTMLElement).dataset.key ?? null)}>
        <For each={sections()}>
          {(s) => (
            <div class="profile-grid-group" {...(s.label ? { role: "group", "aria-labelledby": `profile-grid-${s.id}` } : {})}>
              <Show when={s.label}>
                {(l) => (
                  <p class="profile-grid-label" id={`profile-grid-${s.id}`}>
                    {l()}
                  </p>
                )}
              </Show>
              <div class="profile-grid">
                <For each={s.cards}>
                  {(p) => (
                    <Show
                      when={active(p)}
                      fallback={
                        <ProfileTile
                          key={p.key}
                          icon={profileIconName(p.icon)}
                          label={p.label}
                          caption={s.id === "mine" && !props.unusable(p) ? props.mineCaption : profileCaptionParts(p, props.subagents, props.unusable(p))}
                          checked={props.checked === p.key}
                          tabbable={tabbable() === p.key}
                          off={!!props.unusable(p)}
                          chips={[
                            ...(p.approval === "needed" ? [{ text: "Needs approval", tone: "warn" as const }] : []),
                            ...(p.singleton ? [{ text: "One at a time" }] : []),
                          ]}
                          onPick={() => pick(p)}
                        />
                      }
                    >
                      {(h) => <ActiveTile key={p.key} icon={profileIconName(p.icon)} label={p.label} holder={h()} />}
                    </Show>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
        <div class="profile-grid" role="group" aria-label="Custom">
          <ProfileTile
            key={CUSTOM_KEY}
            icon="wrench"
            label="Custom…"
            caption={{ kind: "words", text: "Adjust this one" }}
            checked={props.checked === CUSTOM_KEY}
            tabbable={tabbable() === CUSTOM_KEY}
            off={false}
            chips={[]}
            onPick={() => props.onCustom()}
          />
        </div>
      </div>
    </div>
  );
}

function ProfileTile(props: {
  key: string;
  icon: ReturnType<typeof profileIconName>;
  label: string;
  /** Its caption: words, or the glyphs of what it sets (a reason it can't be picked here is words, warn). */
  caption: CardCaption;
  checked: boolean;
  tabbable: boolean;
  /** It can't be picked here: its caption says why. */
  off: boolean;
  chips: { text: string; tone?: "warn" }[];
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      class="profile-tile"
      classList={{ "profile-tile-off": props.off }}
      aria-checked={props.checked}
      aria-disabled={props.off ? "true" : undefined}
      tabIndex={props.tabbable ? 0 : -1}
      title={captionWords(props.caption) || props.label}
      data-key={props.key}
      onClick={() => props.onPick()}
    >
      <span class="profile-tile-head">
        <Icon name={props.icon} small />
        <span class="profile-tile-label">{props.label}</span>
        <Show when={props.checked}>
          <Icon name="check" small class="profile-tile-check" />
        </Show>
      </span>
      <Caption caption={props.caption} />
      <Show when={props.chips.length}>
        <span class="profile-tile-chips">
          <For each={props.chips}>{(c) => <span class={`chip${c.tone === "warn" ? " chip-warn" : ""}`}>{c.text}</span>}</For>
        </span>
      </Show>
    </button>
  );
}

/** A One at a time profile live in another session (§chat.profiles/singleton): a link that opens
    that session, never a pick, so no radio. */
function ActiveTile(props: { key: string; icon: ReturnType<typeof profileIconName>; label: string; holder: { id: string; title: string } }) {
  const caption = () => `Opens the running session: ${props.holder.title}`;
  return (
    <a class="profile-tile profile-tile-active" href={`#/sid/${encodeURIComponent(props.holder.id)}`} title={caption()} data-key={props.key}>
      <span class="profile-tile-head">
        <Icon name={props.icon} small />
        <span class="profile-tile-label">{props.label}</span>
        <Icon name="arrow-right" small class="profile-tile-check" />
      </span>
      <span class="profile-tile-caption">{caption()}</span>
      <span class="profile-tile-chips">
        <span class="chip">
          <span class="live-dot" />
          Live
        </span>
      </span>
    </a>
  );
}

/** A caption's complete words: its accessible name and hover text. */
const captionWords = (c: CardCaption): string => (c.kind === "words" ? c.text : c.label);

/**
 * A card's caption line (§chat.profiles/picker): words, or one glyph item per setting the profile
 * sets, each with its words as its hover text; the whole caption in words for screen readers. On
 * a card wide enough, words come back beside the glyphs. Where the caption runs out of room, its
 * mode icons fold to the first and a "+N" before the model's name is cut (foldFit); the words
 * still name every mode.
 */
function Caption(props: { caption: CardCaption }) {
  return (
    <Switch>
      <Match when={props.caption.kind === "words" && props.caption}>
        {(c) => (
          <Show when={c().text}>
            <span class="profile-tile-caption">{c().text}</span>
          </Show>
        )}
      </Match>
      <Match when={props.caption.kind === "glyphs" && props.caption}>
        {(c) => (
          <span class="profile-tile-caption profile-tile-glyphs">
            <span class="visually-hidden">{c().label}</span>
            <GlyphParts parts={c().parts} />
          </span>
        )}
      </Match>
    </Switch>
  );
}

/** The caption's glyph row, with its "+N" after the last mode icon, shown only while folded. */
function GlyphParts(props: { parts: CaptionPart[] }) {
  const modes = () => props.parts.filter((p) => p.kind === "mode").length;
  const lastMode = () => props.parts.reduce((at, p, i) => (p.kind === "mode" ? i : at), -1);
  return (
    <span
      class="caption-parts"
      aria-hidden="true"
      ref={(row) =>
        foldFit(row, {
          target: () => row,
          boxes: () => [row.querySelector<HTMLElement>(".caption-part-name"), row],
          modes,
        })
      }
    >
      <For each={props.parts}>
        {(part, i) => (
          <>
            <CaptionItem part={part} />
            <Show when={i() === lastMode() && foldedRest(modes()) > 0}>
              <span class="caption-part caption-more">{foldLabel(modes())}</span>
            </Show>
          </>
        )}
      </For>
    </span>
  );
}

function CaptionItem(props: { part: CaptionPart }) {
  const p = props.part;
  return (
    <span class={`caption-part caption-part-${p.kind}`} title={p.title}>
      <Switch>
        <Match when={p.kind === "model" && p}>
          {(m) => (
            <>
              <Show when={m().level}>{(l) => <EffortRing level={l()} />}</Show>
              <Show when={m().name}>{(n) => <span class="caption-part-name">{n()}</span>}</Show>
              <Show when={m().level}>{(l) => <span class="caption-word">{l()}</span>}</Show>
            </>
          )}
        </Match>
        <Match when={p.kind === "subagents" && p}>
          {(a) => (
            <>
              <Icon name="subagents" small />
              <span class="caption-word">subagents</span>
              <span>{a().text}</span>
            </>
          )}
        </Match>
        <Match when={p.kind === "mode" && p}>
          {(m) => (
            <>
              <ModeGlyph glyph={m().glyph} />
              <span class="caption-word">{m().glyph.id}</span>
            </>
          )}
        </Match>
        <Match when={p.kind === "words" && p}>{(w) => <span>{w().text}</span>}</Match>
      </Switch>
    </span>
  );
}

export const PROFILE_GRID_CUSTOM = CUSTOM_KEY;
