import { createEffect, createMemo, createSignal, For, on, Show, type Accessor } from "solid-js";
import type { ChatMemoryChoice, ChatProjectModes, ChatServerMessage, MemoryType, ModeApplies, ModeInfo, ProjectMinorInfo, ProjectModeApprovalNeeded } from "../../shared/protocol";
import { memoryRowText, sameMemoryChoice } from "../lib/memory-ui";
import { focusPanel, MemoryTypePanel, panelKeys } from "./MemoryTypePanel";
import { ApiError, fetchProfiles, getChatMode, getMode, pickProfile, postMode, putDefaultProfile, saveCurrentProfile, switchProfile, updateProfileFromChat } from "../lib/api";
import type { ChatProfileState } from "../../shared/protocol";
import type { JoinedProfile, ProfilesListing } from "../../shared/profiles";
import { defaultLabel, defaultTitle, editedName, menuPick, pickDoesSomething, pickerRows, rowDisabledReason, switchedLine, switchRefused, switchWaitingLine, updateOffered } from "../lib/profile-switch";
import {
  APPROVE_HOOKS_LABEL,
  approvalFootFor,
  approvalLeadFor,
  hookWhen,
  hooksLead,
  APPROVE_LABEL,
  bareProgramsNote,
  commandLine,
  filterProfiles,
  majorGear,
  menuModes,
  nextProjectModes,
  noProfileMatch,
  PERSONAL_GROUP_LABEL,
  projectGroupLabel,
  projectRowState,
  footNote,
  savableMode,
  type ShownMode,
} from "../lib/mode-menu";
import { useHostScope } from "../lib/host-scope";
import { usePaneId } from "../lib/pane-scope";
import { openProfiles } from "../lib/settings-nav";
import { announce } from "../lib/ui-state";
import { Banner, Icon } from "./ui";
import { foldLabel, foldedRest } from "../lib/name-fit";
import { ModeGlyph, ModeGlyphs } from "./ModeGlyph";
import { majorGlyph, minorGlyph, modeGlyphs, modeLetter, type ModeGlyph as ModeGlyphData } from "../lib/mode-glyphs";

/** This chat's last WS "mode" message: the mode of THIS chat and how a switch applies here. Before
    that message, the mode known from the list or this tab's last visit (lib/composer-known), whose
    `applies` is absent unless its source said it: then nothing says when a switch applies. */
export type ModeState = Omit<Extract<ChatServerMessage, { type: "mode" }>, "type" | "applies"> & { applies?: ModeApplies };

/** What the chat view hands its composer so the foot can show and switch this chat's mode. */
export interface ModeControl {
  state: Accessor<ModeState | null>;
  /** This chat's session file: POST /api/mode?path= switches this chat and no other. */
  path: string;
  /** Why the switch waits (the chat connecting or starting, §chat.transcript/instant-open), or null. */
  blocked?: () => string | null;
  /** Resolves once this chat is open: a chat closed while quiet wakes for what the menu asks of it
      (§chat.transcript/instant-open); rejects when it doesn't start. Absent: always open. */
  ready?: () => Promise<void>;
  /** A switch is on its way to this chat: a chat closed while quiet starts for it, and the server
      opens it for the request itself, so the request never waits for this view
      (§chat.transcript/send-while-starting). Absent: nothing to start. */
  wake?: () => void;
  /** What this chat can't do in Create (lib/mode-menu createLimits), or null. Absent: nothing. */
  limits?: () => string | null;
  /** Which profile this chat is on, "(edited)" and a waiting switch (the `chat_profile` message); absent
      or null from a server that doesn't send it. */
  profile?: Accessor<ChatProfileState | null>;
  /** The chat's folder: its project's profiles are listed. */
  cwd?: () => string | null;
  /** This chat's model and effort now, for Update {name}'s comparison. */
  model?: () => string | null;
  thinking?: () => string | null;
  /** Before the first message (the empty screen's picker is open): a pick here is a card pick, both parts. */
  beforeFirstMessage?: () => boolean;
  /** A card pick went through (the runtime reopens): the setup reads again, and a profile's first
      message fills an empty composer, as a card pick does. */
  onPicked?: (firstMessage?: string) => void;
}

/** radio: the major mode; check: a minor mode; project: one of this project's own minor modes;
    action: opens a settings screen or the picker, switches nothing. */
type Item = { kind: "radio" | "check" | "project" | "action"; id: string; description: string; label?: string; personal?: true };

/** The gear actions: Delegate's, Create's and spec's rows, since all their settings live in this chat's profile (Settings → Profiles). */
const CONFIGURE_DELEGATE: Item = {
  kind: "action",
  id: "configure-delegate",
  label: "Configure Delegate",
  description: "Which worker each kind of work goes to",
};
/** Create shares Delegate's settings (§chat.create-mode/delegate-parity), so its gear opens the same tab. */
const CONFIGURE_CREATE: Item = { ...CONFIGURE_DELEGATE, id: "configure-create", label: "Configure Create" };
const CONFIGURE_SPEC: Item = {
  kind: "action",
  id: "configure-spec",
  label: "Configure Spec",
  description: "Which worker writes the spec",
};
/** The chevron beside memory's row: opens the Memory type panel (§chat.mode-menu/memory-panel). */
const MEMORY_TYPE: Item = {
  kind: "action",
  id: "memory-type",
  label: "Memory type",
  description: "Choose this chat's memory type",
};
/** The Profile group row: opens the profile picker panel (§chat.subagent-profiles/menu). */
const PROFILE: Item = {
  kind: "action",
  id: "profile",
  label: "Profile",
  description: "Switch this chat's models and helpers",
};

/** The action beside a project mode's row while its hooks wait for your approval (§chat.mode-menu/project-mode-hooks). */
const HOOKS_PREFIX = "approve-hooks:";
const approveHooksItem = (id: string): Item => ({ kind: "action", id: `${HOOKS_PREFIX}${id}`, label: APPROVE_HOOKS_LABEL, description: `Review ${id}'s hooks` });

const itemId = (it: Item) => `mode-${it.kind}-${it.id}`;

/** A 409 refusal's fresh facts about one project mode, when that is what refused the switch. */
function approvalNeeded(err: unknown, id: string): ProjectMinorInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as Partial<ProjectModeApprovalNeeded> | undefined;
  return (Array.isArray(body?.needsApproval) ? body.needsApproval : []).find((m) => m?.id === id) ?? null;
}

// Lists of what exists; fetched on first open, refreshed on every open. Only `modes`/`minors` are read from it: what is checked comes from this chat.
const [info, setInfo] = createSignal<ModeInfo | null>(null);
const shownOf = (m: Pick<ModeInfo, "mode" | "minorModes" | "strict"> & { saveMode?: string }): ShownMode => ({ mode: m.mode, minorModes: [...m.minorModes], strict: m.strict, ...(m.saveMode ? { saveMode: m.saveMode } : {}) });

/**
 * The composer foot's mode switch: a trigger plus a native popover menu. One major mode
 * (menuitemradio, picking stays open), any minor modes (menuitemcheckbox, toggling stays open) and the
 * Subagents group, whose one row swaps the menu for the profile picker panel (the composer
 * flyout's panel pattern) and back. The mode and the pick are per chat: only this chat follows.
 */
export function ModeMenu(props: { control: ModeControl }) {
  /** This chat open for what the menu asks of it (ModeControl.ready). */
  const chatReady = () => props.control.ready?.() ?? Promise.resolve();
  /** A write goes now: the server opens the chat for it; the view connects meanwhile. */
  const wakeChat = () => props.control.wake?.();
  const paneId = usePaneId();
  /** A peer session's profiles and library are its host's. */
  const host = useHostScope();
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let searchInput!: HTMLInputElement;
  let nameInput!: HTMLInputElement;
  let closedByChoice = false;
  let tabbedAway = false;

  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ title: string; body: string } | null>(null);
  const [active, setActive] = createSignal(0);
  /** The save's own request. `busy` is the rows' (a switch): the button says "Saving…" only for this. */
  const [saving, setSaving] = createSignal(false);
  // The picker panel: the joined profiles this chat can switch to, its own roving row, and the
  // inline flow that saves what this chat uses now as a new profile.
  const [listing, setListing] = createSignal<ProfilesListing | null>(null);
  /** Why Save Current As Profile was refused, under its field until the name changes. */
  const [saveError, setSaveError] = createSignal<string | null>(null);
  /** The Update {name} request in flight. */
  const [updating, setUpdating] = createSignal(false);
  const [picker, setPicker] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [pActive, setPActive] = createSignal(0);
  const [saveName, setSaveName] = createSignal<string | null>(null);
  // The Memory type panel (§chat.mode-menu/memory-panel), the picker's sibling in the same popover.
  let memPanelEl: HTMLDivElement | undefined;
  const [memPanel, setMemPanel] = createSignal(false);
  const [memError, setMemError] = createSignal<string | null>(null);
  // The approval panel: a project mode with tools asks before its first turn-on, and again when they change.
  let approvalEl: HTMLDivElement | undefined;
  const [approving, setApproving] = createSignal<ProjectMinorInfo | null>(null);
  /** Set when the server refused the hash shown: the tools changed while the panel was open. */
  const [approvalStale, setApprovalStale] = createSignal(false);
  /** The panel approves an on mode's hooks only (the Overseer turned it on), switching nothing. */
  const [hooksOnly, setHooksOnly] = createSignal(false);
  /** This chat's memory choice, as its "mode" message says it; absent where memory can't run. */
  const memChoice = createMemo(() => {
    const m = props.control.state()?.memory;
    return m ? { type: m.type, size: m.size } : null;
  }, null, { equals: (a, b) => a === b || (!!a && !!b && sameMemoryChoice(a, b)) });

  /** This chat's profile as its own `chat_profile` message says; null from an older server. */
  const chatProfile = () => props.control.profile?.() ?? null;
  const joined = createMemo(() => listing()?.joined ?? []);
  /** This chat's row in the joined list, once both have arrived. */
  const currentRow = createMemo((): JoinedProfile | undefined => {
    const c = chatProfile()?.current;
    if (!c) return undefined;
    return joined().find((r) => (c.key ? r.key === c.key : false)) ?? joined().find((r) => r.id === c.id);
  });
  const profileName = () => chatProfile()?.current.name ?? "…";
  /** "Claude (edited)" while the chat's model was changed by hand (§chat.profiles/edited). */
  const shownProfile = () => editedName(profileName(), !!chatProfile()?.current.edited);
  const listed = createMemo(() => pickerRows(joined()));
  const matches = createMemo(() => filterProfiles(listed(), search()));
  const isCurrent = (r: JoinedProfile) => r.key === currentRow()?.key || (!currentRow() && r.id === chatProfile()?.current.id);
  /** Save Current is for a chat ON something: Off configures nothing. */
  const canSaveCurrent = () => !!chatProfile() && chatProfile()!.current.id !== "off";

  // This chat's own state only: its WS "mode" message, or before it the mode known from the list or
  // this tab's last visit. With neither there is nothing to show: the default in `info()` is not
  // this chat's mode, so the label stays "Mode" and nothing is checked.
  const current = () => props.control.state();
  /** This project's own minor modes, as this chat's mode message lists them (on, off, broken). */
  /** The project rows as read on open or by the last switch: fresher than the mode message, which
      the server sends only at connect and on a switch. Which modes are ON stays the message's. */
  const [freshProject, setFreshProject] = createSignal<ChatProjectModes | null>(null);
  // A mode message that arrives later (a switch here or in another tab) is newer than the read: it wins.
  createEffect(on(() => current()?.projectMinors, () => setFreshProject(null), { defer: true }));
  const projectName = () => (freshProject() ?? current())?.project?.name;
  // This project's modes, then yours ("Your modes"), each by id: the roving order is the order drawn.
  const projectMinors = createMemo(() =>
    [...((freshProject() ?? current())?.projectMinors ?? [])].sort((a, b) => Number(!!a.personal) - Number(!!b.personal) || a.id.localeCompare(b.id, "en")),
  );
  const projectOn = () => current()?.projectModes ?? [];
  const projectInfo = (id: string) => projectMinors().find((m) => m.id === id);
  const items = createMemo<Item[]>(() => {
    const i = info();
    if (!i) return [PROFILE];
    // Each gear follows its row in the roving order, as it follows it on the row. Subagents is the
    // one row of its own group, last.
    return [
      ...i.modes.flatMap((m) => {
        const row = { kind: "radio" as const, ...m };
        const gear = majorGear(m.id);
        return gear ? [row, gear === "configure-create" ? CONFIGURE_CREATE : CONFIGURE_DELEGATE] : [row];
      }),
      ...i.minors.flatMap((m) =>
        m.id === "spec"
          ? [{ kind: "check" as const, ...m }, CONFIGURE_SPEC]
          : m.id === "memory"
            ? // Only where this chat's mode message carries a memory choice: its runtime can run memory.
              memChoice()
              ? [{ kind: "check" as const, ...m }, MEMORY_TYPE]
              : []
            : [{ kind: "check" as const, ...m }],
      ),
      ...projectMinors().flatMap((m) => {
        const row: Item = { kind: "project" as const, id: m.id, description: m.description, ...(m.personal ? { personal: true as const } : {}) };
        return m.hooksNeedApproval && projectOn().includes(m.id) ? [row, approveHooksItem(m.id)] : [row];
      }),
      PROFILE,
    ];
  });
  const checked = (it: Item) => {
    const c = current();
    if (!c || it.kind === "action") return false;
    if (it.kind === "project") return (c.projectModes ?? []).includes(it.id);
    return it.kind === "radio" ? c.mode === it.id : c.minorModes.includes(it.id);
  };
  /** The minor half of the trigger: built-in minors, then this project's. */
  const minorLabel = () => {
    const c = current();
    return c ? [...c.minorModes, ...(c.projectModes ?? [])] : [];
  };
  const label = () => {
    const c = current();
    return c ? [c.mode, ...minorLabel()].join(" · ") : "Mode";
  };
  /** The trigger's glyphs; before this chat's state arrives, the sliders alone (with "Mode"). */
  const triggerGlyphs = () => {
    const c = current();
    return c ? modeGlyphs(c.mode, c.minorModes, c.projectModes ?? []) : [majorGlyph("normal")];
  };
  /** A mode row's glyph, the trigger's for the same mode: the menu is its legend. */
  const rowGlyph = (it: Item): ModeGlyphData | null =>
    it.kind === "radio" ? majorGlyph(it.id) : it.kind === "check" ? minorGlyph(it.id) : it.kind === "project" ? { kind: "letter", id: it.id, letter: modeLetter(it.id) } : null;
  const name = () => `Mode: ${label()}${current()?.applies === "after-turn" ? ", applies after this turn" : ""}`;

  /** This chat's mode as the footer reads it, or null before its "mode" message arrives. */
  const shown = (): ShownMode | null => {
    const c = current();
    return c ? shownOf(c) : null;
  };
  /** Is this chat's profile this computer's default? The server's answer (the listing read on open,
      or the save's reply), never a switch's: unknown either side is not "already the default". */
  const alreadyDefault = () => {
    const d = listing()?.defaultProfile;
    const c = chatProfile()?.current;
    return !!d && !!c && (c.key ? d.key === c.key : d.id === c.id);
  };
  const saveState = (): "idle" | "saving" | "done" => (saving() ? "saving" : alreadyDefault() ? "done" : "idle");
  /** Update {name}: offered only for one of yours, while this chat's model, effort, mode or add-ons differ. */
  const updatable = () => {
    const s = shown();
    return updateOffered(currentRow(), {
      profile: currentRow()?.session,
      chat: { model: props.control.model?.() ?? null, thinking: props.control.thinking?.() ?? null, mode: s ? savableMode(s).mode : null, minorModes: s?.minorModes ?? null },
    });
  };

  const focusItem = (i: number) => {
    setActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>("[role^=menuitem]")[i]?.focus());
  };
  const focusChoice = (i: number) => {
    setPActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[i]?.focus());
  };

  const openPicker = () => {
    setPicker(true);
    setSaveName(null);
    // The current row first (or Off's: the list's own start), never the input: focusing it would
    // raise a phone's keyboard. Typing from a row moves into the input (onKeyDown below).
    const at = Math.max(0, matches().findIndex(isCurrent));
    focusChoice(at);
  };
  const closePicker = () => {
    setPicker(false);
    focusItem(items().findIndex((it) => it.id === PROFILE.id));
  };
  const openMemPanel = () => {
    setMemError(null);
    setMemPanel(true);
    queueMicrotask(() => focusPanel(memPanelEl));
  };
  const closeMemPanel = () => {
    setMemPanel(false);
    focusItem(items().findIndex((it) => it.id === MEMORY_TYPE.id));
  };
  /** A type for this chat (§chat.memory/choice): the menu stays open; the check moves with the "mode" message. */
  const pickMemory = async (type: MemoryType) => {
    if (busy()) return;
    if (memChoice()?.type === type) return;
    setBusy(true);
    setMemError(null);
    try {
      wakeChat();
      setInfo(await postMode({ memory: { type } }, props.control.path));
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setMemError(`${why}. Your memory choice is unchanged.`);
    } finally {
      setBusy(false);
    }
  };

  const openMenu = async (keepError = false) => {
    if (open()) return;
    const r = trigger.getBoundingClientRect();
    // The foot is pinned to the pane's bottom edge, so the menu grows upward from the trigger.
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.round(innerWidth - r.right)}px`);
    closedByChoice = false;
    tabbedAway = false;
    if (!keepError) setError(null);
    setPicker(false);
    setMemPanel(false);
    setMemError(null);
    setApproving(null);
    setFreshProject(null);
    setSearch("");
    setSaveName(null);
    menu.showPopover();
    setSaveError(null);
    try {
      setListing(await fetchProfiles(props.control.cwd?.() ?? null, host()));
    } catch (err) {
      setListing(null);
      setError({ title: "Couldn't load the profiles.", body: `${(err instanceof Error ? err.message : String(err)).replace(/\.$/, "")}. This chat's profile is unchanged.` });
    }
    try {
      const read = await getMode(host());
      // A local chat's own answer below replaces this list; a peer's chat has only this one.
      setInfo({ ...read, modes: menuModes(read) });
    } catch {
      if (!info()) setError({ title: "Couldn't load the modes.", body: "Your mode is unchanged. Close this and try again." });
    }
    // A peer's chat is read through its host's list only: this server can't read its folder.
    if (!host()) {
      try {
        const read = await getChatMode(props.control.path);
        // Which major modes this chat offers is the chat's own answer (§chat.create-mode/where-offered).
        setInfo((i) => (i ? { ...i, modes: read.modes } : read));
        if (read.projectMinors) setFreshProject({ project: read.project, projectMinors: read.projectMinors });
      } catch {
        // Keep the mode message's rows: they are older, never wrong about what is on.
      }
    }
    const at = items().findIndex((it) => it.kind === "radio" && checked(it));
    focusItem(Math.max(0, at));
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };

  const activate = async (it: Item) => {
    if (it.id === PROFILE.id) {
      openPicker();
      return;
    }
    if (it.id === MEMORY_TYPE.id) {
      openMemPanel();
      return;
    }
    if (it.id.startsWith(HOOKS_PREFIX)) {
      const m = projectInfo(it.id.slice(HOOKS_PREFIX.length));
      if (m?.hooksNeedApproval && m.toolsHash) openApproval(m, false, true);
      return;
    }
    if (it.kind === "action") {
      // Opens Settings → Profiles on this chat's profile, at its Models part (the spec writer's row
      // for spec's gear). This chat's mode is left as it is.
      closedByChoice = true;
      closeMenu();
      manageProfiles(it.id === CONFIGURE_SPEC.id ? "spec" : undefined);
      return;
    }
    const c = current();
    if (!c || busy()) return;
    if (it.kind === "project") {
      const m = projectInfo(it.id);
      const on = checked(it);
      if (!m || !projectRowState(m, on).canToggle) return;
      // A turn-on whose tools aren't approved asks first, in place; a turn-off never asks.
      if (!on && m.needsApproval) {
        openApproval(m, false);
        return;
      }
      await switchProject(it.id, nextProjectModes(projectOn(), it.id));
      return;
    }
    let patch: { mode?: string; minorModes?: string[] };
    // A pick, like a toggle, keeps the menu open: the check moves and focus stays on the row.
    if (it.kind === "radio") {
      if (it.id === c.mode) return;
      patch = { mode: it.id };
    } else {
      patch = { minorModes: checked(it) ? c.minorModes.filter((m) => m !== it.id) : [...c.minorModes, it.id] };
    }
    setBusy(true);
    setError(null);
    try {
      wakeChat();
      setInfo(await postMode(patch, props.control.path)); // this chat's "mode" message follows over the socket
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't switch the mode.", body: `${why}. Your mode is unchanged.` });
    } finally {
      setBusy(false);
      // The rows re-render as the mode arrives, which can drop focus to <body>: once that settles,
      // put it back on the row just chosen, unless the menu closed or focus moved elsewhere in it.
      requestAnimationFrame(() => {
        if (!menu.matches(":popover-open") || menu.contains(document.activeElement)) return;
        const at = items().findIndex((x) => x.id === it.id);
        if (at >= 0) focusItem(at);
      });
    }
  };

  /** Put focus back on a row once the rows settle, unless the menu closed or focus moved within it. */
  const refocus = (id: string) =>
    requestAnimationFrame(() => {
      if (!menu.matches(":popover-open") || menu.contains(document.activeElement)) return;
      const at = items().findIndex((x) => x.id === id);
      if (at >= 0) focusItem(at);
    });

  /** Switch this chat's project modes to `next` (the whole ON set), with an approval when one was given. */
  const switchProject = async (id: string, next: string[], approval?: { id: string; hash: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postMode({ projectModes: next, ...(approval ? { approve: [approval] } : {}) }, props.control.path);
      setInfo(r);
      if ("projectMinors" in r && r.projectMinors) setFreshProject({ project: r.project, projectMinors: r.projectMinors });
      if (approval) {
        setApproving(null);
        announce(`${id} approved and on.`);
      }
    } catch (err) {
      // Its tools changed since they were shown (or since the row was drawn): show the new ones.
      const fresh = approvalNeeded(err, id);
      if (fresh) {
        openApproval(fresh, !!approval);
        return;
      }
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      if (approval) setApproving(null);
      setError({ title: "Couldn't switch the mode.", body: `${why}. Your mode is unchanged.` });
    } finally {
      setBusy(false);
      if (!approving()) refocus(id);
    }
  };

  const openApproval = (m: ProjectMinorInfo, stale: boolean, hooks = false) => {
    setApprovalStale(stale);
    setHooksOnly(hooks);
    setApproving(m);
    // Focus starts on Back, first in reading order: the approval is read before it is pressed.
    queueMicrotask(() => approvalEl?.querySelector<HTMLElement>("button")?.focus());
  };
  const closeApproval = () => {
    const id = approving()?.id;
    setApproving(null);
    if (id) focusItem(items().findIndex((it) => it.kind === "project" && it.id === id));
  };
  const approve = () => {
    const m = approving();
    if (!m || busy() || !m.toolsHash) return;
    if (hooksOnly()) return void approveHooks(m.id, m.toolsHash);
    void switchProject(m.id, nextProjectModes(projectOn(), m.id), { id: m.id, hash: m.toolsHash });
  };
  /** Your approval of an on mode's hooks: records it, switches nothing. A changed version shows itself again. */
  const approveHooks = async (id: string, hash: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postMode({ approveHooks: [{ id, hash }] }, props.control.path);
      setInfo(r);
      if ("projectMinors" in r && r.projectMinors) setFreshProject({ project: r.project, projectMinors: r.projectMinors });
      setApproving(null);
      announce(`${id}'s hooks approved.`);
    } catch (err) {
      const fresh = approvalNeeded(err, id);
      if (fresh?.hooksNeedApproval) {
        openApproval(fresh, true, true);
        return;
      }
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setApproving(null);
      setError({ title: "Couldn't approve the hooks.", body: `${why}. Nothing was approved.` });
    } finally {
      setBusy(false);
      if (!approving()) refocus(id);
    }
  };

  /** Settings → Profiles on this chat's profile, at its Models part (the spec writer's row for spec). */
  const manageProfiles = (section?: "spec") => {
    const key = currentRow()?.key ?? chatProfile()?.current.key;
    openProfiles({ ...(key ? { profile: key } : {}), ...(host() ? {} : { path: props.control.path }), part: "models", ...(section ? { section } : {}) });
  };

  /**
   * `Make {name} the Default`: THIS chat's profile becomes this computer's default
   * (§chat.profiles/default), and this chat's strict flag and memory type are saved for new chats as
   * before. The request carries no profile of its own: the server takes this chat's, so a switch
   * landing between the click and the request can't make the default something the user never saw.
   * The answer (the fresh listing) is what `alreadyDefault` reads from then on.
   */
  const saveAsDefault = async () => {
    if (busy() || saving() || alreadyDefault()) return;
    const name = profileName();
    setSaving(true);
    setError(null);
    try {
      wakeChat();
      setListing(await putDefaultProfile({ path: props.control.path, cwd: props.control.cwd?.() ?? null }));
      announce(`Default: ${listing()?.defaultProfile?.name ?? name}. New chats start here.`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't save the default.", body: `${why}.` });
    } finally {
      setSaving(false);
    }
  };

  /** `Update {name}`: this chat's model, effort, mode and add-ons into its profile; nothing switches here. */
  const updateProfile = async () => {
    if (busy() || updating() || !updatable()) return;
    const name = profileName();
    setUpdating(true);
    setError(null);
    try {
      setListing(await updateProfileFromChat(props.control.path, props.control.cwd?.() ?? null));
      announce(`Updated ${name}.`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: `Couldn't update ${name}.`, body: `${why}. The profile is unchanged.` });
    } finally {
      setUpdating(false);
    }
  };

  /**
   * A profile pick: switches this chat's whole Models part, all at once (§chat.profiles/switch). The
   * main panel returns with focus on the Profile row and the menu stays open; a switch that waits for
   * the reply shows its line there (and in the thread), a refusal its banner, and nothing changed.
   */
  const chooseProfile = async (r: JoinedProfile) => {
    if (busy() || rowDisabledReason(r)) return;
    if (!pickDoesSomething(r, { key: currentRow()?.key ?? null, edited: !!chatProfile()?.current.edited }) && currentRow()) {
      closePicker();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      wakeChat();
      // Before the first message it is the empty screen's card pick, both parts; the runtime
      // reopens, so the menu closes. After it, the switch of the Models part (§chat.profiles/switch).
      const done = await menuPick(r, !!props.control.beforeFirstMessage?.(), {
        pick: (ref) => pickProfile(props.control.path, ref),
        switchTo: (id) => switchProfile(props.control.path, id, host()),
      });
      if (done.kind === "card") {
        props.control.onPicked?.(r.session?.firstMessage);
        closedByChoice = true;
        closeMenu();
        announce(`Profile: ${r.name}.`);
        return;
      }
      const res = done.result;
      closePicker();
      announce(res.applies === "after-turn" ? switchWaitingLine(r.name, res.state.pending?.helpers ?? r.helperRoles, res.state.pending?.setsModel ?? !!r.session?.model) : switchedLine(r.name));
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      const named = (err instanceof ApiError ? (err.body as { name?: unknown } | undefined)?.name : undefined);
      setError(switchRefused(typeof named === "string" && named ? named : r.name, why));
      closePicker();
    } finally {
      setBusy(false);
    }
  };

  /** Save Current as Profile: this chat's model and effort, with a copy of its helpers, as a new
      profile of yours with both halves, linked. Nothing about this chat changes. */
  const saveCurrent = async () => {
    const chosen = saveName()?.trim();
    if (!chosen || busy() || !canSaveCurrent()) return;
    setBusy(true);
    setSaveError(null);
    try {
      setListing(await saveCurrentProfile(props.control.path, chosen, props.control.cwd?.() ?? null));
      setSaveName(null);
      announce(`Saved ${chosen} to your profiles.`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setSaveError(`Couldn't save ${chosen}. ${why}.`);
    } finally {
      setBusy(false);
    }
  };

  const pickKeyed = (key: string) => {
    const r = matches().find((x) => x.key === key);
    if (r) void chooseProfile(r);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (approving()) return; // its buttons keep their own keys
    if (memPanel()) {
      if (memPanelEl) panelKeys(e, memPanelEl);
      return;
    }
    if (picker()) {
      const target = e.target as HTMLElement | null;
      if (target === nameInput) return; // the name field keeps its own keys
      const radios = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      if (target === searchInput) {
        // In the field, Home/End and Space are the caret's; only ↓/↑ leave it, and Enter takes the
        // one match when the list has been narrowed to exactly one.
        if (e.key === "ArrowDown" && radios.length > 0) {
          e.preventDefault();
          focusChoice(0);
        } else if (e.key === "ArrowUp" && radios.length > 0) {
          e.preventDefault();
          focusChoice(radios.length - 1);
        } else if (e.key === "Enter" && matches().length === 1) {
          e.preventDefault();
          void chooseProfile(matches()[0]!);
        }
        return;
      }
      const radio = target?.closest?.("[role=menuitemradio]") as HTMLElement | null;
      if (!radio) return; // the head's Back and the footer's buttons keep their Enter and Space
      const i = radios.indexOf(radio);
      const typeahead = (append: string | null) => {
        // Typing from a row goes into the search field, which takes focus (the user chose to type).
        e.preventDefault();
        setSearch(append === null ? search().slice(0, -1) : search() + append);
        setPActive(0);
        searchInput.focus();
        const end = searchInput.value.length;
        searchInput.setSelectionRange(end, end);
      };
      const keys: Record<string, () => void> = {
        ArrowDown: () => focusChoice((i + 1) % radios.length),
        ArrowUp: () => focusChoice((i - 1 + radios.length) % radios.length),
        Home: () => focusChoice(0),
        End: () => focusChoice(radios.length - 1),
        Enter: () => void pickKeyed(radio.dataset.profile!),
        " ": () => void pickKeyed(radio.dataset.profile!),
      };
      const act = radios.length > 0 ? keys[e.key] : undefined;
      if (act) {
        e.preventDefault();
        act();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeahead(e.key);
      else if (e.key === "Backspace" && search()) typeahead(null);
      return;
    }
    // Only the menu's own items take keys here: the footer's button is a button, and Enter or Space
    // on it must press IT, not whichever row was last focused.
    if (!(e.target as HTMLElement | null)?.closest?.("[role^=menuitem]")) return;
    const n = items().length;
    if (n === 0) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem((active() + 1) % n),
      ArrowUp: () => focusItem((active() - 1 + n) % n),
      Home: () => focusItem(0),
      End: () => focusItem(n - 1),
      Enter: () => void activate(items()[active()]!),
      " ": () => void activate(items()[active()]!),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  /** A project mode's row state, or null for every other row. */
  const projectState = (it: Item) => {
    if (it.kind !== "project") return null;
    const m = projectInfo(it.id);
    return m ? projectRowState(m, checked(it)) : null;
  };
  const Row = (p: { it: Item; index: number }) => (
    <div
      class="popover-item popover-item-detail popover-item-mono"
      role={p.it.kind === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      id={itemId(p.it)}
      tabindex={active() === p.index ? 0 : -1}
      aria-checked={checked(p.it) ? "true" : "false"}
      aria-disabled={busy() || projectState(p.it)?.canToggle === false ? "true" : undefined}
      aria-haspopup={projectState(p.it)?.kind === "approval" ? "true" : undefined}
      data-project-state={projectState(p.it)?.kind}
      onClick={() => {
        setActive(p.index);
        void activate(p.it);
      }}
      onFocus={() => setActive(p.index)}
    >
      <Icon name="check" small class="popover-item-check" />
      <Show when={rowGlyph(p.it)}>
        {(g) => (
          <span class="popover-item-icon">
            <ModeGlyph glyph={g()} />
          </span>
        )}
      </Show>
      <span class="popover-item-text">
        <span class="popover-item-label">{p.it.label ?? p.it.id}</span>
        <Show
          when={p.it.id === "memory"}
          fallback={<span class="popover-item-desc">{p.it.id === "delegate" ? `Profile: ${shownProfile()}` : p.it.description}</span>}
        >
          <span class="popover-item-desc">{memoryRowText(info()?.memory?.types, memChoice() ?? undefined, checked(p.it)).description}</span>
          <Show when={memoryRowText(info()?.memory?.types, memChoice() ?? undefined, checked(p.it)).detail}>
            {(d) => <span class="popover-item-desc mode-menu-detail">{d()}</span>}
          </Show>
        </Show>
        <Show when={p.it.id === "create" && p.it.kind === "radio" ? props.control.limits?.() : null}>
          {(limits) => <span class="popover-item-desc mode-menu-detail">{limits()}</span>}
        </Show>
        <Show when={projectState(p.it)?.note}>{(note) => <span class="popover-item-desc mode-menu-detail mode-menu-project-note">{note()}</span>}</Show>
      </span>
    </div>
  );
  // A sibling of its row, not inside it: a button nested in a menuitemradio (or menuitemcheckbox) loses its role.
  const Gear = (p: { it: Item; index: number }) => (
    <button
      type="button"
      class="button button-ghost button-icon mode-menu-gear"
      role="menuitem"
      id={itemId(p.it)}
      tabindex={active() === p.index ? 0 : -1}
      aria-label={p.it.label}
      aria-haspopup={p.it.id === MEMORY_TYPE.id ? "true" : undefined}
      title={p.it.label}
      onClick={() => {
        setActive(p.index);
        void activate(p.it);
      }}
      onFocus={() => setActive(p.index)}
    >
      <Icon name={p.it.id === MEMORY_TYPE.id || p.it.id.startsWith(HOOKS_PREFIX) ? "chevron-right" : "settings"} small />
    </button>
  );
  /** A row, with its gear beside it when an action follows it in the roving order. */
  const WithGear = (p: { it: Item; index: number }) => {
    const gear = () => (items()[p.index + 1]?.kind === "action" && items()[p.index + 1]?.id !== PROFILE.id ? items()[p.index + 1]! : null);
    return (
      <Show when={gear()} fallback={<Row it={p.it} index={p.index} />}>
        {(g) => (
          <div class="mode-menu-row" role="none">
            <Row it={p.it} index={p.index} />
            <Gear it={g()} index={p.index + 1} />
          </div>
        )}
      </Show>
    );
  };
  const group = (kind: Item["kind"]) => items().map((it, index) => ({ it, index })).filter((x) => x.it.kind === kind);
  /** The project rows of one group: this project's, or yours (§chat.mode-menu/personal-modes). */
  const projectGroup = (personal: boolean) => group("project").filter((x) => !!x.it.personal === personal);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-ghost mode-trigger"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={paneId("mode-popover")}
        aria-label={name()}
        title={name()}
        data-applies={current()?.applies}
        aria-disabled={props.control.blocked?.() ? "true" : undefined}
        aria-describedby={props.control.blocked?.() ? paneId("composer-reason") : undefined}
        onClick={() => {
          if (open()) closeMenu();
          else if (!props.control.blocked?.()) void openMenu();
        }}
      >
        {/* Icon-first (§chat.mode-menu/trigger): the major mode's, one per minor mode on, a letter
            per project mode on. The words come back beside them only where the foot has room. */}
        <ModeGlyphs glyphs={triggerGlyphs()} />
        {/* Where the composer foot is too tight, the icons fold to the first and this count of the
            rest (the foot's foldFit sets data-folded); the name and the menu keep every mode. */}
        <Show when={foldedRest(triggerGlyphs().length) > 0}>
          <span class="mode-more" aria-hidden="true">
            {foldLabel(triggerGlyphs().length)}
          </span>
        </Show>
        {/* Two parts, so a narrow foot ellipsizes the minor modes before the major one. */}
        <span class="mode-trigger-label" aria-hidden="true">
          {current()?.mode ?? "Mode"}
        </span>
        <Show when={minorLabel().length}>
          <span class="mode-trigger-label mode-trigger-minor" aria-hidden="true">
            · {minorLabel().join(" · ")}
          </span>
        </Show>
        <Icon name="chevron-down" small />
      </button>

      <div
        ref={menu}
        class="model-menu mode-menu"
        id={paneId("mode-popover")}
        popover="auto"
        onKeyDown={onKeyDown}
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (!isOpen && !closedByChoice && !tabbedAway) trigger.focus();
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !menu.contains(to) && to !== trigger) {
            tabbedAway = true;
            closeMenu();
          }
        }}
      >
        <Show when={current()?.applies === "after-turn"}>
          <Banner
            tone="info"
            title="Applies after this turn."
            body="This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one."
          />
        </Show>
        <Show when={current()?.applies === "new-chats"}>
          <Banner
            tone="warn"
            title="This chat can't switch."
            body="Modes aren't available in this chat, or another program wrote this session."
          />
        </Show>
        <Show when={error()}>{(e) => <Banner tone="error" title={e().title} body={e().body} />}</Show>
        <Show when={chatProfile()?.pending}>{(p) => <Banner tone="info" title={switchWaitingLine(p().name, p().helpers, p().setsModel)} />}</Show>

        <Show when={approving()}>
          {(m) => (
            <div ref={approvalEl} class="mode-approval" role="group" aria-labelledby={paneId("mode-approval-title")}>
              <div class="composer-flyout-head">
                <button type="button" class="button button-sm button-ghost composer-flyout-back" disabled={busy()} onClick={closeApproval}>
                  <Icon name="chevron-left" small />
                  Back
                </button>
                <span class="model-menu-head-title" id={paneId("mode-approval-title")}>
                  <Show when={hooksOnly()} fallback={<>Turn on <span class="text-mono">{m().id}</span>?</>}>
                    Approve <span class="text-mono">{m().id}</span>'s hooks?
                  </Show>
                </span>
              </div>
              <Show when={approvalStale()}>
                <Banner tone="warn" title="Its tools changed while this was open." body="These are the tools it has now. Check them again before you approve." />
              </Show>
              <p class="mode-approval-lead">{hooksOnly() ? hooksLead(m().id) : approvalLeadFor(m().id, projectName(), m())}</p>
              <Show when={!hooksOnly() && m().tools.length > 0}>
              <ul class="mode-approval-tools" aria-label={`${m().id}'s tools`}>
                <For each={m().tools}>
                  {(t) => (
                    <li class="mode-approval-tool">
                      <span class="mode-approval-tool-name text-mono">{t.name}</span>
                      <Show when={t.description}>
                        <span class="mode-approval-tool-desc">{t.description}</span>
                      </Show>
                      <code class="mode-approval-tool-cmd">{commandLine(t.command)}</code>
                    </li>
                  )}
                </For>
              </ul>
              </Show>
              <Show when={!hooksOnly() && (m().commands?.length ?? 0) > 0}>
                <ul class="mode-approval-tools" aria-label={`${m().id}'s commands`}>
                  <For each={m().commands}>
                    {(t) => (
                      <li class="mode-approval-tool">
                        <span class="mode-approval-tool-name text-mono">mode.{m().id}.{t.name}</span>
                        <Show when={t.description}>
                          <span class="mode-approval-tool-desc">{t.description}</span>
                        </Show>
                        <code class="mode-approval-tool-cmd">{commandLine(t.command)}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={(m().hooks?.length ?? 0) > 0}>
                <ul class="mode-approval-tools" aria-label={`${m().id}'s hooks`}>
                  <For each={m().hooks}>
                    {(h) => (
                      <li class="mode-approval-tool">
                        <span class="mode-approval-tool-name">{hookWhen(h.on)}</span>
                        <code class="mode-approval-tool-cmd">{commandLine(h.command)}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="mode-menu-foot">
                <p class="mode-menu-foot-line">
                  Runs from <span class="text-mono">{m().dir}</span>. {approvalFootFor(m())}
                </p>
                <Show when={bareProgramsNote([...(hooksOnly() ? [] : [...m().tools, ...(m().commands ?? [])]), ...(m().hooks ?? [])])}>{(note) => <p class="mode-menu-foot-line">{note()}</p>}</Show>
                <div class="button-row">
                  <button type="button" class="button button-primary button-sm" aria-disabled={busy() || !m().toolsHash ? "true" : undefined} onClick={approve}>
                    {busy() ? (hooksOnly() ? "Approving…" : "Turning On…") : hooksOnly() ? APPROVE_HOOKS_LABEL : APPROVE_LABEL}
                  </button>
                  <button type="button" class="button button-ghost button-sm" disabled={busy()} onClick={closeApproval}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>

        <Show when={!approving()}>
        <Show
          when={!memPanel()}
          fallback={
            <>
              {/* The Memory type panel (§chat.mode-menu/memory-panel): Back, the types (scrolling between), a foot line. */}
              <div class="composer-flyout-head">
                <button type="button" class="button button-sm button-ghost composer-flyout-back" onClick={closeMemPanel}>
                  <Icon name="chevron-left" small />
                  Back
                </button>
                <span class="model-menu-head-title">Memory type</span>
              </div>
              <Show when={memError()}>{(why) => <Banner tone="error" title="Couldn't change memory." body={why()} />}</Show>
              <div class="memory-panel-scroll" ref={memPanelEl}>
                <MemoryTypePanel
                  idPrefix={paneId("memory-panel")}
                  types={info()?.memory?.types}
                  choice={memChoice()}
                  busy={busy()}
                  onPick={(type) => void pickMemory(type)}
                />
              </div>
              <div class="mode-menu-foot">
                <p class="mode-menu-foot-line">This chat only. Kept while memory is off.</p>
              </div>
            </>
          }
        >
        <Show
          when={!picker()}
          fallback={
            <>
              {/* The picker panel (§chat.subagent-profiles/menu): Back, search, Off then your
                  profiles and this project's, each with its footprint, then Manage and Save Current. */}
              <div class="composer-flyout-head">
                <button type="button" class="button button-sm button-ghost composer-flyout-back" onClick={closePicker}>
                  <Icon name="chevron-left" small />
                  Back
                </button>
                <span class="model-menu-head-title">Profiles</span>
              </div>
              <div class="model-menu-search">
                <div class="search">
                  <Icon name="search" />
                  <input
                    ref={searchInput}
                    class="input"
                    type="search"
                    aria-label="Search profiles"
                    placeholder="Search profiles"
                    autocomplete="off"
                    spellcheck={false}
                    value={search()}
                    onInput={(e) => {
                      setSearch(e.currentTarget.value);
                      setPActive(0);
                    }}
                  />
                </div>
              </div>
              <div class="model-menu-list" role="menu" aria-label="Profiles">
                <For
                  each={matches()}
                  fallback={<p class="model-menu-empty">{listing() ? (search() ? noProfileMatch(search()) : "No profiles yet. Save Current as Profile makes one.") : "Couldn't load them."}</p>}
                >
                  {(p, i) => (
                    <div
                      class="popover-item popover-item-detail"
                      role="menuitemradio"
                      id={paneId(`profile-choice-${p.key}`)}
                      data-profile={p.key}
                      tabindex={pActive() === i() ? 0 : -1}
                      aria-checked={isCurrent(p) ? "true" : "false"}
                      aria-disabled={busy() || rowDisabledReason(p) ? "true" : undefined}
                      title={rowDisabledReason(p) ?? undefined}
                      onClick={() => void chooseProfile(p)}
                      onFocus={() => setPActive(i())}
                    >
                      <Icon name="check" small class="popover-item-check" />
                      <span class="popover-item-text">
                        <span class="popover-item-label">{isCurrent(p) ? shownProfile() : p.name}</span>
                        <span class="popover-item-desc" classList={{ "mode-menu-profile-off": !!rowDisabledReason(p) }}>
                          {rowDisabledReason(p) ?? p.footprint}
                        </span>
                      </span>
                    </div>
                  )}
                </For>
              </div>
              <div class="mode-menu-foot">
                <div class="button-row">
                  <button
                    type="button"
                    class="button button-ghost button-sm"
                    onClick={() => {
                      closedByChoice = true;
                      closeMenu();
                      manageProfiles();
                    }}
                  >
                    Manage Profiles…
                  </button>
                  <Show when={canSaveCurrent()}>
                    <button
                      type="button"
                      class="button button-ghost button-sm"
                      disabled={busy() || saveName() !== null}
                      onClick={() => {
                        setSaveName("");
                        setSaveError(null);
                        queueMicrotask(() => nameInput?.focus());
                      }}
                    >
                      Save Current as Profile
                    </button>
                  </Show>
                </div>
                <Show when={saveName() !== null}>
                  <form
                    class="mode-menu-save-as"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveCurrent();
                    }}
                  >
                    <div class="field">
                      <label class="field-label" for={paneId("profile-name")}>
                        Profile name
                      </label>
                      <input
                        ref={nameInput}
                        class="input"
                        id={paneId("profile-name")}
                        maxlength={48}
                        value={saveName() ?? ""}
                        disabled={busy()}
                        aria-invalid={saveError() ? "true" : undefined}
                        aria-describedby={saveError() ? paneId("profile-name-error") : undefined}
                        onInput={(e) => {
                          setSaveName(e.currentTarget.value);
                          setSaveError(null);
                        }}
                      />
                      <Show when={saveError()}>
                        {(why) => (
                          <p class="field-error" id={paneId("profile-name-error")}>
                            {why()}
                          </p>
                        )}
                      </Show>
                    </div>
                    <div class="button-row">
                      <button type="submit" class="button button-sm" disabled={busy() || !saveName()?.trim()}>
                        Save Profile
                      </button>
                      <button
                        type="button"
                        class="button button-ghost button-sm"
                        disabled={busy()}
                        onClick={() => {
                          setSaveName(null);
                          setSaveError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </Show>
              </div>
            </>
          }
        >
          <div class="model-menu-list" role="menu" id={paneId("mode-menu")} aria-label="Mode">
            <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-major")}>
              <div class="list-group-label" id={paneId("mode-group-major")}>
                Major mode
              </div>
              <For each={group("radio")}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
            </div>
            <Show when={group("check").length > 0}>
              <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-minor")}>
                <div class="list-group-label" id={paneId("mode-group-minor")}>
                  Minor modes
                </div>
                <For each={group("check")}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
              </div>
            </Show>
            <Show when={projectGroup(false).length > 0}>
              <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-project")}>
                <div class="list-group-label" id={paneId("mode-group-project")}>
                  {projectGroupLabel(projectName())}
                </div>
                <For each={projectGroup(false)}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
              </div>
            </Show>
            <Show when={projectGroup(true).length > 0}>
              <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-personal")}>
                <div class="list-group-label" id={paneId("mode-group-personal")}>
                  {PERSONAL_GROUP_LABEL}
                </div>
                <For each={projectGroup(true)}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
              </div>
            </Show>
            <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-profile")}>
              <div class="list-group-label" id={paneId("mode-group-profile")}>
                Profile
              </div>
              <div
                class="popover-item"
                role="menuitem"
                id={itemId(PROFILE)}
                tabindex={active() === items().findIndex((it) => it.id === PROFILE.id) ? 0 : -1}
                aria-haspopup="true"
                onClick={() => {
                  setActive(items().findIndex((it) => it.id === PROFILE.id));
                  void activate(PROFILE);
                }}
                onFocus={() => setActive(items().findIndex((it) => it.id === PROFILE.id))}
              >
                <Icon name="subagents" small />
                <span class="popover-item-text">
                  <span class="popover-item-label">Profile · {shownProfile()}</span>
                </span>
                <Icon name="chevron-right" small class="popover-item-end" />
              </div>
            </div>
          </div>

          <div class="mode-menu-foot">
            <p class="mode-menu-foot-line">
              <span class="text-mono">strict: {current()?.strict ? "on" : "off"}</span> · {footNote(shown(), chatProfile() && updatable() ? profileName() : null)}
            </p>
            <div class="button-row">
              <Show when={updatable()}>
                <button
                  type="button"
                  class="button button-ghost button-sm mode-menu-update"
                  aria-disabled={busy() || updating() ? "true" : undefined}
                  title={`Save this chat's model and modes into ${profileName()}.`}
                  onClick={() => void updateProfile()}
                >
                  {updating() ? "Saving…" : `Update ${profileName()}`}
                </button>
              </Show>
              <button
                type="button"
                class="button button-ghost button-sm mode-menu-save"
                aria-disabled={busy() || saving() || alreadyDefault() ? "true" : undefined}
                title={defaultTitle(chatProfile() ? profileName() : null, alreadyDefault())}
                onClick={() => void saveAsDefault()}
              >
                <Show when={alreadyDefault() && !saving()}>
                  <Icon name="check" small />
                </Show>
                {defaultLabel(saveState(), chatProfile() ? profileName() : null)}
              </button>
            </div>
          </div>
        </Show>
        </Show>
        </Show>
      </div>
    </>
  );
}
