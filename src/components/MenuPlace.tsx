/**
 * The one menu body (src/lib/menu-place.ts): it draws any place's declaration — Sova's rows in their
 * sections, then what extensions add (`MenuAdded`, after every one of Sova's rows) — and the second
 * screens a row can open: the one name box, the one question, a list of rows, or a worktree's
 * removal flow. A place's right-click (`openMenu`) and its touch/pen hold (`holdMenu`) both draw it
 * through the page's one pointer menu, ContextMenu.tsx, so the doors can't drift. Extension content is
 * data drawn as ordinary menu rows, never markup.
 */
import { createEffect, createMemo, createSignal, createUniqueId, For, Index, Match, on, onCleanup, onMount, Show, Switch, useContext } from "solid-js";
import { sendCommand } from "../lib/api";
import { entryTitle, type MenuAct, type MenuDecl, type MenuEntry, type MenuGroup, type MenuItem, type MenuScreen, type MenuSection, menuGroups, runMenuEntry, sameGroups } from "../lib/menu-place";
import { ExtensionsContext } from "../lib/reply-place";
import { announce, toast } from "../lib/ui-state";
import { type ActionMenuApi } from "./ActionMenu";
import { type ContextPlace, holdContextMenu, openContextMenu } from "./ContextMenu";
import { TextField } from "./form";
import { RemoveAnywayListing } from "./RemoveAnywayListing";
import { Icon } from "./ui";

type Screen<K extends MenuScreen["kind"]> = Extract<MenuScreen, { kind: K }>;

/** Do what a row says; the menu has closed first (lib/menu-place `MenuAct`). A link row's browser navigates. */
function act(a: MenuAct) {
  if ("command" in a) void a.via(() => sendCommand(a.command, a.params));
  else if ("local" in a) void a.local();
}
const keepsFocus = (a: MenuAct) => "keepFocus" in a && !!a.keepFocus;
/** A screen's button: close the menu, then act. */
const runNow = (menu: ActionMenuApi, a: MenuAct) => menu.run(() => act(a), keepsFocus(a));

/** One row, drawn from its data. */
function Row(props: { menu: ActionMenuApi; row: MenuItem }) {
  const r = () => props.row;
  const a = () => r().act;
  return (
    <props.menu.Item
      label={r().label}
      aria={r().aria}
      title={r().title}
      icon={r().icon ? <Icon name={r().icon!} small /> : undefined}
      description={r().description}
      disabled={r().disabled}
      href={"href" in a() ? (a() as { href: string }).href : undefined}
      keepFocus={keepsFocus(a())}
      stayOpen={"screen" in a()}
      onRun={() => ("screen" in a() ? props.menu.show(r().label) : act(a()))}
    />
  );
}

/** Sections in order. Rows keep their nodes while their data changes (`Index`), so a focused row
    stays focused when the list it reads refreshes under an open menu. */
function Sections(props: { menu: ActionMenuApi; sections: readonly MenuSection[] }) {
  const rows = (s: MenuSection) => <Index each={s.rows}>{(r) => <Row menu={props.menu} row={r()} />}</Index>;
  return (
    <Index each={props.sections}>
      {(s) => (
        <Show when={s().rows.length > 0}>
          <Show when={s().name} fallback={rows(s())}>
            <div class="model-menu-group" role="group" aria-label={s().name}>
              <Show when={s().heading}>
                <div class="list-group-label">{s().heading}</div>
              </Show>
              {rows(s())}
            </div>
          </Show>
        </Show>
      )}
    </Index>
  );
}

/**
 * The one name box (every menu's Rename…): the box, its hint, then Save and Cancel. Enter or Save
 * saves; Escape or Cancel closes the whole menu. Leaving the box saves where `leaveSaves` says so
 * (a group or session name); elsewhere a click outside closes the menu and saves nothing. What
 * saving means (an empty box restores, clears or cancels) is the row's `save`.
 */
function NameScreen(props: { menu: ActionMenuApi; screen: Screen<"name"> }) {
  const opened = props.screen.initial;
  const [value, setValue] = createSignal(opened);
  let form!: HTMLFormElement;
  // One ending per box: saving closes the menu, and that blur must not save again (or cancel after a save).
  let settled = false;
  const end = (save: boolean, via: "enter" | "leave" = "enter") => {
    if (settled) return;
    settled = true;
    const then = save ? props.screen.save(value(), opened, via) : null;
    if (then) runNow(props.menu, then);
    else props.menu.dismiss();
  };
  // Pressing a button keeps focus in the box, so the box isn't left (and saved) on the way to Cancel.
  const stay = (e: MouseEvent) => e.preventDefault();
  return (
    <form
      ref={form}
      class="group-menu-screen"
      aria-label={props.screen.label}
      onSubmit={(e) => {
        e.preventDefault();
        end(true);
      }}
    >
      <TextField
        label={props.screen.label}
        hideLabel
        hint={props.screen.hint}
        value={value()}
        onInput={setValue}
        maxlength={props.screen.max}
        placeholder={props.screen.placeholder}
        ref={(el: HTMLInputElement) => queueMicrotask(() => (el.focus(), el.select()))}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation(); // Escape belongs to the box while it is open, not to the page
          end(false);
        }}
        onBlur={(e) => {
          // Settled first: a box that has ended is gone with its screen, and so is what it read.
          if (!settled && props.screen.leaveSaves && !(e.relatedTarget instanceof Node && form.contains(e.relatedTarget))) end(true, "leave");
        }}
      />
      <div class="cluster">
        <button type="submit" class="button button-sm" onMouseDown={stay}>
          Save
        </button>
        <button type="button" class="button button-sm button-ghost" onMouseDown={stay} onClick={() => end(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The one question (Delete group…, Rewind…, Regenerate…): its sentence, said to its button, which has focus, then Cancel. */
function ConfirmScreen(props: { menu: ActionMenuApi; screen: Screen<"confirm">; name: string }) {
  const note = createUniqueId();
  return (
    <div class="group-menu-screen" role="group" aria-label={props.name}>
      <p class="group-tools-question" id={note}>{props.screen.note}</p>
      <div class="cluster">
        <button ref={(b) => queueMicrotask(() => b.focus())} type="button" class="button button-sm button-destructive" aria-describedby={note} onClick={() => runNow(props.menu, props.screen.act)}>
          {props.screen.confirm}
        </button>
        <button type="button" class="button button-sm button-ghost" onClick={() => props.menu.dismiss()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Remove Worktree's dry run, reason and, when offered, its exact Remove Anyway listing. */
function WorktreeRemoveScreen(props: { menu: ActionMenuApi; screen: Screen<"worktree-remove">; name: string }) {
  const note = createUniqueId();
  let live = true;
  let unload: (() => void) | undefined;
  onMount(() => {
    props.screen.load?.();
    unload = props.screen.unload;
  });
  onCleanup(() => {
    live = false;
    unload?.();
  });
  const listing = () => props.screen.listing;
  let destructive: HTMLButtonElement | undefined;
  let back!: HTMLButtonElement;
  // Listing starts on Back. If a dry-run hard hold removes the focused destructive button, the
  // screen's remaining safe control takes focus instead of dropping it back to the page.
  createEffect(() => {
    if (!live) return;
    if (listing() || !props.screen.confirm) queueMicrotask(() => live && back.focus());
  });
  return (
    <div class="group-menu-screen" role="group" aria-label={props.name}>
      <Show when={listing()} fallback={<p class="group-tools-question" id={note}>{props.screen.note}</p>}>
        {(a) => <RemoveAnywayListing listing={a().data} home={a().home} />}
      </Show>
      <div class="cluster">
        <Show when={props.screen.confirm}>
          {(c) => {
            return (
              <button
                ref={(b) => {
                  destructive = b;
                  const focus = !listing();
                  queueMicrotask(() => live && focus && b.focus());
                }}
                type="button"
                class="button button-sm button-destructive"
                aria-describedby={listing() ? undefined : note}
                aria-disabled={c().disabled ? "true" : undefined}
                onClick={() => {
                  const current = c();
                  if (current.disabled) return;
                  if ("show" in current) current.show();
                  else runNow(props.menu, current.act);
                }}
              >
                {c().label}
              </button>
            );
          }}
        </Show>
        <button
          ref={(b) => {
            back = b;
            if (!props.screen.confirm) queueMicrotask(() => live && b.focus());
          }}
          type="button"
          class="button button-sm button-ghost"
          onKeyDown={(e) => {
            if (!listing() || e.key !== "Tab" || e.shiftKey) return;
            e.preventDefault();
            destructive?.focus();
          }}
          onClick={() => {
            if (listing()) props.screen.back?.();
            else props.menu.dismiss();
          }}
        >
          {listing() ? "Back" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

/** A list of rows in place of the menu's own (Move to Group…). */
function RowsScreen(props: { menu: ActionMenuApi; screen: Screen<"rows"> }) {
  onMount(() => props.screen.load?.());
  return (
    <div class="model-menu-list" role="menu" aria-label={props.screen.label}>
      <Sections menu={props.menu} sections={props.screen.sections} />
    </div>
  );
}

/** Run an extension's entry, and say how it went. */
async function runEntry(entry: MenuEntry, payload: Record<string, string>) {
  const said = await runMenuEntry(entry, payload);
  toast(said);
  announce(said);
}

/**
 * The one menu body, for every place and every door: the declaration's rows, then what extensions
 * add, and the screen a row opened. A screen is read from the table as it is now, so it acts on the
 * newest data; once its row can't run (a turn started) or is gone, the rows come back with focus on
 * that row, which now says why.
 */
export function MenuBody<T>(props: { menu: ActionMenuApi; decl: MenuDecl<T>; subject: T }) {
  const menu = props.menu;
  const table = createMemo(() => props.decl.table(props.subject));
  const rowOf = (label: string | null) => (label === null ? undefined : table().flatMap((s) => s.rows).find((r) => r.label === label));
  const asking = createMemo(() => {
    const r = rowOf(menu.screen());
    return r && !r.disabled && "screen" in r.act ? r : undefined;
  });
  const screen = <K extends MenuScreen["kind"]>(kind: K) => {
    const a = asking()?.act;
    return a && "screen" in a && a.screen.kind === kind ? (a.screen as Screen<K>) : undefined;
  };
  let list: HTMLDivElement | undefined;
  createEffect(
    on(
      () => menu.screen() !== null && !asking(),
      (gaveWay) => {
        if (!gaveWay) return;
        const aria = rowOf(menu.screen())?.aria;
        menu.show(null);
        if (aria) queueMicrotask(() => list?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(aria)}"]`)?.focus());
      },
      { defer: true },
    ),
  );
  /** What extensions add, where the place has an extension lane and its payload for this subject. */
  const extensions = useContext(ExtensionsContext);
  const lane = () => props.decl.extensions;
  const added = createMemo(() => (lane()?.payload(props.subject) ? menuGroups(extensions(), lane()!.place) : []), [], { equals: sameGroups });
  return (
    <Switch
      fallback={
        <div ref={list} class="model-menu-list" role="menu" aria-label={props.decl.label(props.subject)}>
          <Sections menu={menu} sections={table()} />
          <MenuAdded menu={menu} groups={added()} subject={lane()?.name(props.subject) ?? ""} run={(e) => void runEntry(e, lane()!.payload(props.subject)!)} />
        </div>
      }
    >
      <Match when={screen("name")}>{(s) => <NameScreen menu={menu} screen={s()} />}</Match>
      <Match when={screen("confirm")}>{(s) => <ConfirmScreen menu={menu} screen={s()} name={asking()!.aria} />}</Match>
      <Match when={screen("rows")}>{(s) => <RowsScreen menu={menu} screen={s()} />}</Match>
      <Match when={screen("worktree-remove")}>{(s) => <WorktreeRemoveScreen menu={menu} screen={s()} name={asking()!.aria} />}</Match>
    </Switch>
  );
}

/** Where a place's pointer menu opens, and where its focus returns. */
type MenuAt = { el: Element; origin(): HTMLElement; ownLink?: Element | null; holds?: boolean; drag?: ContextPlace["drag"]; lift?: ContextPlace["lift"] };

function placeOf<T>(decl: MenuDecl<T>, subject: () => T, at: MenuAt): ContextPlace {
  return {
    el: at.el,
    ownLink: at.ownLink,
    holds: at.holds,
    drag: at.drag,
    lift: at.lift,
    menu: () => ({ origin: at.origin(), body: (menu) => <MenuBody menu={menu} decl={decl} subject={subject()} /> }),
  };
}

/** A place's right-click: the same declaration's menu, at the pointer. */
export function openMenu<T>(e: MouseEvent, decl: MenuDecl<T>, subject: () => T, at: MenuAt) {
  return openContextMenu(e, placeOf(decl, subject, at));
}

/** A place's touch/pen press: at a stationary 500ms, the same declaration's menu opens. */
export function holdMenu<T>(e: PointerEvent, decl: MenuDecl<T>, subject: () => T, at: MenuAt) {
  holdContextMenu(e, placeOf(decl, subject, at));
}

/** What extensions add: one group per extension, headed by its title. Nothing at all with none. */
export function MenuAdded(props: {
  menu: ActionMenuApi;
  groups: readonly MenuGroup[];
  /** What the rows act on, as their accessible names say it: the session's quoted title. */
  subject: string;
  run(entry: MenuEntry): void;
}) {
  return (
    <For each={props.groups}>
      {(g) => {
        const head = createUniqueId();
        return (
          <div class="model-menu-group" role="group" aria-labelledby={head}>
            <div class="list-group-label" id={head}>
              {g.title}
            </div>
            <For each={g.entries}>
              {(e) => (
                <props.menu.Item
                  label={e.label}
                  aria={`${e.label} for ${props.subject} · From ${e.extensionTitle}`}
                  title={entryTitle(e)}
                  description={e.summary}
                  icon={<Icon name="command" small />}
                  onRun={() => props.run(e)}
                />
              )}
            </For>
          </div>
        );
      }}
    </For>
  );
}
