import { For, Show } from "solid-js";
import { getOrgs } from "../lib/api";
import { relativeTime, stampTime } from "../lib/format";
import { needsYouCount, needsYouLabel, orgCountsLine } from "../lib/org-cards";
import { orgsGlance } from "../lib/overview-orgs";
import { ORGS_HREF, orgHref } from "../lib/orgs-route";
import { createPoll } from "../lib/poll";
import { Chip, Icon } from "./ui";
import "../home.css";

const ORGS_POLL_MS = 30_000;

/**
 * The overview's last section (§chat.transcript/landing-page): every organization at a glance —
 * totals, then the most recently active few, each row a link to its org. The title links to
 * #/orgs; nothing interactive nests inside another.
 */
export function OverviewOrgsCard(props: { now: number }) {
  const poll = createPoll(getOrgs, ORGS_POLL_MS);
  const glance = () => {
    const info = poll.data();
    return info ? orgsGlance(info.orgs) : null;
  };
  const needs = () => glance()?.totals.needsYou ?? 0;
  const stats = () => {
    const t = glance()?.totals;
    if (!t) return [];
    return [
      { label: t.orgs === 1 ? "Organization" : "Organizations", value: t.orgs },
      { label: t.people === 1 ? "Person" : "People", value: t.people },
      { label: t.projects === 1 ? "Project" : "Projects", value: t.projects },
      { label: t.openBatons === 1 ? "Open hand-off" : "Open hand-offs", value: t.openBatons },
    ];
  };
  return (
    <section class="explain-section" aria-labelledby="overview-orgs-title">
      <h2 class="explain-section-head" id="overview-orgs-title">
        Organizations
      </h2>
      <div class="card overview-orgs" classList={{ "overview-orgs-needs": needs() > 0 }}>
        <div class="overview-orgs-head">
          <span class="action-card-mark">
            <Icon name="network" />
          </span>
          <div class="overview-orgs-intro">
            <h3 class="overview-orgs-title">
              <a class="overview-orgs-title-link" href={ORGS_HREF}>
                Organizations
              </a>
            </h3>
            <p class="overview-orgs-body">Keep each client's people, projects, and hand-off sessions together.</p>
          </div>
        </div>
        <Show when={poll.error() && !glance()}>
          <p class="overview-orgs-error">Couldn't load your organizations: {String(poll.error()).replace(/[.\s]+$/, "")}. We'll try again shortly.</p>
        </Show>
        <Show when={glance()}>
          {(g) => (
            <Show
              when={g().totals.orgs > 0}
              fallback={
                <div class="overview-orgs-empty">
                  <a class="button" href={ORGS_HREF}>
                    <Icon name="plus" />
                    Create Your First Organization
                  </a>
                </div>
              }
            >
              <dl class="overview-orgs-totals">
                <For each={stats()}>
                  {(s) => (
                    <div class="overview-orgs-stat">
                      <dt>{s.label}</dt>
                      <dd class="text-num">{s.value}</dd>
                    </div>
                  )}
                </For>
                <div class="overview-orgs-stat" classList={{ "overview-orgs-stat-needs": needs() > 0 }}>
                  <dt>
                    <Show when={needs() > 0}>
                      <i class="chip-dot" />
                    </Show>
                    Needs you
                  </dt>
                  <dd class="text-num">{needs()}</dd>
                </div>
              </dl>
              <ul class="overview-orgs-list" aria-label="Most recently active organizations">
                <For each={g().rows}>
                  {(o) => {
                    const waiting = () => needsYouCount(o.needsYou);
                    return (
                      <li>
                        <a class="overview-orgs-row" href={orgHref(o.id)}>
                          <span class="overview-orgs-name">{o.name}</span>
                          <span class="overview-orgs-meta">
                            <span class="overview-orgs-counts">{orgCountsLine(o)}</span>
                            <span class="overview-orgs-when" title={o.lastActivityAt ? stampTime(o.lastActivityAt) : undefined}>
                              {o.lastActivityAt ? `Active ${relativeTime(o.lastActivityAt, props.now)}` : ""}
                            </span>
                          </span>
                          <span class="overview-orgs-chip">
                            <Show when={waiting()}>
                              <Chip tone="warn" title={needsYouLabel(o.needsYou)}>
                                Needs you · <span class="text-num">{waiting()}</span>
                              </Chip>
                            </Show>
                          </span>
                        </a>
                      </li>
                    );
                  }}
                </For>
              </ul>
              <Show when={g().more > 0}>
                <a class="overview-orgs-all" href={ORGS_HREF}>
                  View all {g().totals.orgs}
                </a>
              </Show>
            </Show>
          )}
        </Show>
      </div>
    </section>
  );
}
