import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { DEFAULT_PROFILE_ID, powersText, type ListedProfile, type ProfileProblem, type ProfileSource, type ProfilesListing } from "../../shared/profiles";
import type { PlaybookCatalog } from "../../shared/protocol";
import { linkedPlaybook } from "../../shared/playbooks";
import { approveProfile, fetchPlaybooks, fetchProfiles, setProfileHidden } from "../lib/api";
import { tildePath } from "../lib/format";
import { profileIconName, profileSummary } from "../lib/profiles";
import { home, toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/** Where Settings links for the file format (served from the repo's docs/ on GitHub). */
const FORMAT_URL = "https://github.com/Naomarik/sova/blob/master/docs/profiles.md";

const SOURCE_BADGE: Record<ProfileSource, string> = { sova: "Built in", project: "This project", user: "Yours" };

/**
 * Settings → Profiles (§app.settings-dialog/profiles): every profile a session in the open
 * session's folder can use, read-only. Profiles are files; the only writes here are Approve and
 * Hide From Picker, each saved at once.
 */
export function ProfilesSettingsSection(props: { cwd: string | null }) {
  const [listing, { refetch, mutate }] = createResource(() => fetchProfiles(props.cwd));
  const [playbooks] = createResource(() => fetchPlaybooks(props.cwd).catch(() => undefined as PlaybookCatalog | undefined));
  const [busy, setBusy] = createSignal<string | null>(null);
  onMount(() => void refetch());
  const path = (p: string) => tildePath(p, home());
  const where = () => {
    const l = listing();
    return l?.project.state === "ok" && l.project.dir ? path(l.project.dir) : path(l?.yoursFile ?? "~/.pi/agent/sova/session-profiles.json");
  };
  const act = async (key: string, fn: () => Promise<ProfilesListing>, failed: string) => {
    setBusy(key);
    try {
      mutate(await fn());
    } catch (err) {
      toast(`${failed} ${err instanceof Error ? err.message : String(err)}`);
      void refetch();
    } finally {
      setBusy(null);
    }
  };
  const problemsOf = (source: ProfileSource) => (listing()?.problems ?? []).filter((x) => x.source === source);

  const Row = (rp: { p: ListedProfile }) => {
    const p = rp.p;
    const hidden = () => listing()?.hidden.includes(p.key) ?? false;
    const runs = () => {
      if (!p.playbook) return null;
      const pb = linkedPlaybook(playbooks()?.playbooks ?? [], p.playbook, p.source);
      return pb ? `Runs ${pb.title}` : `Runs "${p.playbook}", not found here`;
    };
    return (
      <li class="profiles-row">
        <Icon name={profileIconName(p.icon)} small />
        <div class="profiles-row-main">
          <span class="profiles-row-name">
            {p.label} <span class="chip">{SOURCE_BADGE[p.source]}</span>
            <Show when={hidden()}>
              <span class="chip">Hidden</span>
            </Show>
            <Show when={p.approval === "approved"}>
              <span class="chip chip-success">Approved</span>
            </Show>
          </span>
          <span class="profile-muted">{profileSummary(p)}</span>
          <Show when={runs()}>{(r) => <span class="profile-muted">{r()}</span>}</Show>
          <Show when={p.file}>{(f) => <span class="profile-muted text-mono profiles-row-file">{path(f())}</span>}</Show>
          <Show when={p.approval === "needed"}>
            <span class="profiles-row-ask">It asks to {powersText(p)}. Approve it before a session can use it.</span>
          </Show>
        </div>
        <div class="profiles-row-actions">
          <Show when={p.approval === "needed" && props.cwd}>
            <button
              type="button"
              class="button button-sm button-primary"
              disabled={busy() === p.key}
              onClick={() => void act(p.key, () => approveProfile(props.cwd!, p), `Couldn't approve ${p.label}.`)}
            >
              Approve
            </button>
          </Show>
          <Show when={!(p.source === "sova" && p.id === DEFAULT_PROFILE_ID)}>
            <button
              type="button"
              class="button button-sm button-ghost"
              disabled={busy() === p.key}
              onClick={() => void act(p.key, () => setProfileHidden(p.key, !hidden(), props.cwd), `Couldn't change ${p.label}.`)}
            >
              {hidden() ? "Show In Picker" : "Hide From Picker"}
            </button>
          </Show>
        </div>
      </li>
    );
  };
  const Problem = (pp: { x: ProfileProblem }) => (
    <li class="profiles-row profiles-row-problem">
      <Icon name="attention" small />
      <div class="profiles-row-main">
        <span class="profiles-row-name">
          {pp.x.file.split("/").pop()} <span class="chip chip-error">Can't be read</span>
        </span>
        <span class="profile-muted text-mono profiles-row-file">{path(pp.x.file)}</span>
        <span class="profiles-row-error">{pp.x.error}</span>
      </div>
    </li>
  );
  const Group = (gp: { title: string; label: string; profiles: ListedProfile[]; problems: ProfileProblem[]; empty?: string }) => (
    <>
      <h4 class="text-eyebrow profiles-group-head">{gp.title}</h4>
      <Show when={gp.profiles.length || gp.problems.length} fallback={<Show when={gp.empty}>{(e) => <p class="profile-muted">{e()}</p>}</Show>}>
        <ul class="profiles-list" aria-label={gp.label}>
          <For each={gp.profiles}>{(p) => <Row p={p} />}</For>
          <For each={gp.problems}>{(x) => <Problem x={x} />}</For>
        </ul>
      </Show>
    </>
  );

  return (
    <section class="settings-section profiles-settings" aria-labelledby="profiles-title">
      <h3 class="settings-section-title" id="profiles-title">
        Profiles
      </h3>
      <p class="field-hint">
        Profiles are files. Ask an agent to add or change one, or edit <code>{where()}</code>.{" "}
        <a href={FORMAT_URL} target="_blank" rel="noopener">
          File Format
        </a>
      </p>
      <Show when={listing.error}>
        <Banner tone="error" title="Couldn't list the profiles." body={String(listing.error?.message ?? listing.error)} />
      </Show>
      <Show when={listing()}>
        {(l) => (
          <>
            <Group title="Built in" label="Built-in profiles" profiles={l().builtins} problems={problemsOf("sova")} />
            <Group
              title={l().project.state === "ok" ? `This project (${l().project.name})` : "This project"}
              label="This project's profiles"
              profiles={l().project.profiles}
              problems={problemsOf("project")}
              empty={
                l().project.state === "ok"
                  ? `None yet. A profile here is a file in ${path(l().project.dir ?? "")}.`
                  : l().project.state === "none"
                    ? "Open a session to see its project's profiles."
                    : (l().project.message ?? "This session's folder has no project profiles.")
              }
            />
            <h4 class="text-eyebrow profiles-group-head">Yours</h4>
            <Show when={l().error}>{(e) => <Banner tone="error" title="Your profiles couldn't be read." body={e()} />}</Show>
            <Show when={l().yours.length} fallback={<Show when={!l().error}><p class="profile-muted">None yet. Yours are in {path(l().yoursFile)}, and every folder can use them.</p></Show>}>
              <ul class="profiles-list" aria-label="Your profiles">
                <For each={l().yours}>{(p) => <Row p={p} />}</For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
