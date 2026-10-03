import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { GitSummary, SessionSetup } from "../../shared/protocol";
import { fetchSessionSetup, setSessionLoadout } from "../lib/api";
import { loadGitSummary, UPSTREAM_TITLE } from "../lib/git-summary";
import {
  CONTEXT_NONE,
  contextHeading,
  contextNote,
  contextRows,
  contextSum,
  contextSwitchLabel,
  fileFacts,
  flipped,
  gitView,
  isOff,
  isSumEmpty,
  loadoutView,
  skillsHeading,
  skillsNone,
  skillsNote,
  skillsSum,
  skillSwitchLabel,
  sumFacts,
  SYSTEM_CONTEXT_LABEL,
  SYSTEM_CONTEXT_TITLE,
  systemContextSum,
} from "../lib/session-setup";
import { home, toast } from "../lib/ui-state";
import { Icon } from "./ui";

type Answer<T> = { ok: T } | { error: string };

/**
 * The setup card of a new, empty session: what pi loads into
 * the prompt, the skills it offers, and the repository around the folder. One aggregate line opens
 * it — the whole loadout, which the Context and Skills sections below add up to — then a section
 * per thing summed, each carrying its own total beside its label. Read once when the empty state
 * appears; nothing here polls or links. The card lands whole, once both reads have answered, so it
 * never grows in two steps under the title.
 *
 * Before the first message of a session this server hosts, each context file and skill row carries
 * a switch (§chat.transcript/setup-card-toggles). `editable` is the chat's own word that the window
 * is open (the Profile picker's: pickable and not locked). A flip sends the whole off set and draws
 * the server's fresh read in place.
 */
export function SessionSetupCard(props: { path: string; editable?: boolean }) {
  const [setup, setSetup] = createSignal<Answer<SessionSetup> | null>(null);
  const [git, setGit] = createSignal<Answer<GitSummary> | null>(null);
  const [landed, setLanded] = createSignal(false);
  // `run` is the session being read (a new path, or the card going away, drops every answer in
  // flight); `rev` counts the loadout answers drawn since, so the first read never draws over a
  // newer one (a re-read when the window opened, or a flip's answer).
  let run = 0;
  let rev = 0;
  const settle = <T,>(p: Promise<T>): Promise<Answer<T>> => p.then((ok) => ({ ok }), (err: Error) => ({ error: err.message }));
  // A memo, so a new props object for the same session never reads as a new session.
  const path = createMemo(() => props.path);
  createEffect(
    on(path, (p) => {
      const mine = ++run;
      const seen = rev;
      setLanded(false);
      void Promise.all([settle(fetchSessionSetup(p)), settle(loadGitSummary(p))]).then(([s, g]) => {
        if (mine !== run) return;
        if (seen === rev) setSetup(s);
        setGit(g);
        setLanded(true);
      });
    }),
  );
  onCleanup(() => run++); // an answer that lands after the empty state went writes to nothing

  // The chat says the window opened after the card read (the runtime wasn't held yet, or it was
  // rebuilt by a flip from another tab): read again, so the switches the server allows appear.
  const editable = createMemo(() => !!props.editable);
  createEffect(
    on(editable, (now, before) => {
      if (!now || before === undefined) return;
      const s = setup();
      if (s && "ok" in s && s.ok.state === "ok" && s.ok.toggleable) return;
      const mine = run;
      void settle(fetchSessionSetup(path(), true)).then((next) => {
        if (mine !== run || !("ok" in next)) return;
        rev++;
        setSetup(next);
      });
    }),
  );

  const [applying, setApplying] = createSignal(false);
  const flip = (kind: "context" | "skill", key: string, input: HTMLInputElement) => {
    const on = input.checked;
    const s = setup();
    if (!s || !("ok" in s) || s.ok.state !== "ok" || applying()) return;
    const set = flipped(s.ok, kind, key, on);
    const mine = run;
    setApplying(true);
    setSessionLoadout(path(), set.offContext, set.offSkills)
      .then((next) => {
        if (mine !== run) return;
        rev++;
        setSetup({ ok: next });
      })
      .catch((err: Error) => {
        // Nothing was written: the switch goes back to what the server has.
        input.checked = !on;
        toast(`Couldn't switch that ${kind === "context" ? "file" : "skill"}. ${err.message}`);
      })
      .finally(() => setApplying(false));
  };
  const switchable = () => {
    const s = setup();
    return !!props.editable && !!s && "ok" in s && s.ok.state === "ok" && !!s.ok.toggleable;
  };

  const view = () => {
    const s = setup();
    return s && "ok" in s ? loadoutView(s.ok) : null;
  };
  const groups = () => {
    const v = view();
    return v?.kind === "groups" ? v.setup : null;
  };

  return (
    <Show when={landed()}>
      <section class="setup-card" aria-label="Session setup">
        <Switch>
          <Match when={setup() && "error" in setup()! && (setup() as { error: string })}>
            {(e) => (
              <div class="setup-group">
                <p class="setup-note">Couldn't read what pi loads here. {e().error}</p>
              </div>
            )}
          </Match>
          <Match when={groups()}>
            {(s) => {
              const rows = createMemo(() => contextRows(s(), home()));
              const context = createMemo(() => contextSum(s()));
              const skills = createMemo(() => skillsSum(s()));
              const whole = createMemo(() => systemContextSum(s()));
              return (
                <>
                  {/* The card's one aggregate line: the two sections below add up to it. Empty files
                      sum to zero, and a zero line says nothing the sections don't. */}
                  <Show when={!isSumEmpty(whole())}>
                    <div class="setup-group">
                      <p class="setup-sum" title={SYSTEM_CONTEXT_TITLE}>
                        <span class="setup-sum-label">{SYSTEM_CONTEXT_LABEL}</span>
                        <span class="setup-sum-facts">{sumFacts(whole())}</span>
                      </p>
                    </div>
                  </Show>
                  <div class="setup-group">
                    <div class="setup-head">
                      <h2 class="text-eyebrow setup-label">{contextHeading(rows().length)}</h2>
                      <Show when={!isSumEmpty(context())}>
                        <span class="setup-total">{sumFacts(context())}</span>
                      </Show>
                    </div>
                    <Show when={rows().length > 0} fallback={<p class="setup-note">{CONTEXT_NONE}</p>}>
                      <p class="setup-note">{contextNote(s())}</p>
                      <ul class="setup-list">
                        <For each={rows()}>
                          {(r) => (
                            <li class="setup-row" classList={{ "setup-row-off": isOff(r.file) }} title={r.file.path}>
                              <span class="setup-name">
                                <span class="setup-path">{r.label}</span>
                                <Show when={r.role}>{(role) => <span class="setup-role">{role()}</span>}</Show>
                              </span>
                              <span class="setup-facts">{fileFacts(r.file)}</span>
                              <Show when={switchable() && r.switchable}>
                                <label class="toggle toggle-switch setup-toggle">
                                  <input
                                    type="checkbox"
                                    aria-label={contextSwitchLabel(r.label)}
                                    checked={!isOff(r.file)}
                                    disabled={applying()}
                                    onChange={(e) => flip("context", r.file.path, e.currentTarget)}
                                  />
                                  <span class="toggle-box" />
                                </label>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                  <div class="setup-group">
                    <div class="setup-head">
                      <h2 class="text-eyebrow setup-label">{skillsHeading(s().skills.length)}</h2>
                      <Show when={!isSumEmpty(skills())}>
                        <span class="setup-total">{sumFacts(skills())}</span>
                      </Show>
                    </div>
                    <Show when={s().skills.length > 0} fallback={<p class="setup-note">{skillsNone(s())}</p>}>
                      <p class="setup-note">{skillsNote(s())}</p>
                      <ul class="setup-list">
                        <For each={s().skills}>
                          {(k) => (
                            <li class="setup-row" classList={{ "setup-row-off": isOff(k) }} title={k.description ? `${k.path}\n${k.description}` : k.path}>
                              <span class="setup-name">
                                <span class="setup-path">{k.name}</span>
                              </span>
                              <span class="setup-facts">{fileFacts(k)}</span>
                              <Show when={switchable()}>
                                <label class="toggle toggle-switch setup-toggle">
                                  <input
                                    type="checkbox"
                                    aria-label={skillSwitchLabel(k.name)}
                                    checked={!isOff(k)}
                                    disabled={applying()}
                                    onChange={(e) => flip("skill", k.name, e.currentTarget)}
                                  />
                                  <span class="toggle-box" />
                                </label>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </>
              );
            }}
          </Match>
          <Match when={view()?.kind === "line" && (view() as { kind: "line"; text: string })}>
            {(v) => (
              <div class="setup-group">
                <p class="setup-note">{v().text}</p>
              </div>
            )}
          </Match>
        </Switch>
        <div class="setup-group">
          <h2 class="text-eyebrow setup-label">Repository</h2>
          <GitFacts answer={git()!} />
        </div>
      </section>
    </Show>
  );
}

function GitFacts(props: { answer: Answer<GitSummary> }) {
  const view = () => ("ok" in props.answer ? gitView(props.answer.ok, home(), Date.now()) : null);
  const repo = () => {
    const v = view();
    return v?.kind === "repo" ? v : null;
  };
  return (
    <Switch>
      <Match when={"error" in props.answer && (props.answer as { error: string })}>
        {(e) => <p class="setup-note">Couldn't read this session's repository. {e().error}</p>}
      </Match>
      <Match when={view()?.kind === "line" && (view() as { kind: "line"; text: string })}>
        {(v) => <p class="setup-note">{v().text}</p>}
      </Match>
      <Match when={repo()}>
        {(v) => (
          <>
            <p class="setup-git">
              <Icon name="branch" small />
              <span class="setup-git-head">{v().head}</span>
              <Show when={v().upstream}>
                {(u) => (
                  <>
                    <span class="setup-sep">·</span>
                    <span title={UPSTREAM_TITLE}>{u()}</span>
                  </>
                )}
              </Show>
            </p>
            <p class="setup-git">
              <Icon name="file" small />
              <span>{v().changes}</span>
              <Show when={v().lines}>
                {(l) => (
                  <span class="setup-num">
                    <span class="setup-add">+{l().added}</span> <span class="setup-del">−{l().removed}</span>
                  </span>
                )}
              </Show>
            </p>
            <Show when={v().commits.length > 0} fallback={<Show when={v().noCommit}>{(t) => <p class="setup-note">{t()}</p>}</Show>}>
              <ul class="setup-list setup-commits">
                <For each={v().commits}>
                  {(c) => (
                    <li class="setup-git setup-commit">
                      <Icon name="clock" small />
                      <span class="setup-oid">{c.oid}</span>
                      <span class="setup-subject" title={c.subject}>
                        {c.subject}
                      </span>
                      <span class="setup-ago">{c.ago}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={v().note}>{(n) => <p class="setup-note">{n()}</p>}</Show>
          </>
        )}
      </Match>
    </Switch>
  );
}
