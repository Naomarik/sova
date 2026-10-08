import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { ListedProfile } from "../../shared/profiles";
import { CARD_FILTER_AFTER, cardCount, cardMatches, profileCaption, profileIconName, type pickerProfiles } from "../lib/profiles";
import { Icon } from "./ui";

/** Where focus goes when the grid mounts again after a pick (the runtime reopens and remounts the
    picker): the card that was picked, by session path. Module state, like the board's. */
const focusAfterPick = new Map<string, string>();
const CUSTOM_KEY = "custom";

/**
 * The empty screen's profile cards: one radio group, a card per profile in the picker's groups,
 * then Custom…. Arrow keys move focus between cards (Home and End to the ends); Enter, Space or a
 * click picks. A card that can't be used here is disabled with its reason, and picking it does
 * nothing. A Find a profile field shows past CARD_FILTER_AFTER cards.
 */
export function ProfileGrid(props: {
  path: string;
  groups: ReturnType<typeof pickerProfiles>;
  /** The checked card's key: a profile's, CUSTOM for a board pick. */
  checked: string | null;
  subagents: readonly { id: string; footprint: string }[];
  running: (p: ListedProfile) => boolean;
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
    [
      { id: "builtins", label: "Built in", cards: props.groups.builtins },
      { id: "project", label: `This project (${props.groups.projectName ?? "this folder"})`, cards: props.groups.project },
      { id: "yours", label: "Yours", cards: props.groups.yours },
    ]
      .map((s) => ({ ...s, cards: s.cards.filter((p) => cardMatches(p, q())) }))
      .filter((s) => s.cards.length > 0),
  );
  const keys = createMemo(() => [...sections().flatMap((s) => s.cards.map((p) => p.key)), CUSTOM_KEY]);
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
            <div class="profile-grid-group" role="group" aria-labelledby={`profile-grid-${s.id}`}>
              <p class="profile-grid-label" id={`profile-grid-${s.id}`}>
                {s.label}
              </p>
              <div class="profile-grid">
                <For each={s.cards}>
                  {(p) => (
                    <ProfileTile
                      key={p.key}
                      icon={profileIconName(p.icon)}
                      label={p.label}
                      caption={profileCaption(p, props.subagents)}
                      checked={props.checked === p.key}
                      tabbable={tabbable() === p.key}
                      why={props.unusable(p)}
                      chips={[
                        ...(props.running(p) ? [{ text: "Running" }] : []),
                        ...(p.approval === "needed" ? [{ text: "Needs approval", tone: "warn" as const }] : []),
                        ...(p.singleton ? [{ text: "One at a time" }] : []),
                      ]}
                      onPick={() => pick(p)}
                    />
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
            caption="Adjust this one"
            checked={props.checked === CUSTOM_KEY}
            tabbable={tabbable() === CUSTOM_KEY}
            why={null}
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
  caption: string;
  checked: boolean;
  tabbable: boolean;
  /** Why it can't be picked here: shown as its caption and title. */
  why: string | null;
  chips: { text: string; tone?: "warn" }[];
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      class="profile-tile"
      classList={{ "profile-tile-off": !!props.why }}
      aria-checked={props.checked}
      aria-disabled={props.why ? "true" : undefined}
      tabIndex={props.tabbable ? 0 : -1}
      title={props.why ?? (props.caption || props.label)}
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
      <Show when={props.why ?? props.caption}>{(c) => <span class="profile-tile-caption">{c()}</span>}</Show>
      <Show when={props.chips.length}>
        <span class="profile-tile-chips">
          <For each={props.chips}>{(c) => <span class={`chip${c.tone === "warn" ? " chip-warn" : ""}`}>{c.text}</span>}</For>
        </span>
      </Show>
    </button>
  );
}

export const PROFILE_GRID_CUSTOM = CUSTOM_KEY;
