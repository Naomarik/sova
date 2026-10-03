# §app/project-costs — Project costs at API prices
> Part of the Sova design spec · [overview](../design/overview.md)

Each project of an organization (§app/organizations) shows a **running cost**: what every session
tied to the project would have cost at each provider's published API prices, split by the kind of
session, the model, the kind of token (input, output, cache read, cache write) and who started it.
It is a measure, not a bill: most of these sessions run on subscriptions that bill differently, and
the page says so. There is no limit on it (the project overseer's limits are counts,
§app.project-overseer/limits). Only the operator sees it: on the project page's **Cost** card and in
the org page's Projects tab. The owner page and the project overseer never do.

## §app.project-costs/scope — What a project's cost counts

- **Every session tied to the project, whoever started it**, each under one kind:
  - **Overseer conversations**: the project overseer's current conversation and every cleared one
    (`sessions/` files carrying this project's marker, §app.project-overseer/identity).
  - **Gathering and offers**: every baton session of the project (`projectId`), the overseer's and
    the operator's.
  - **Settling**: baton sessions that settle a conflict.
  - **Wrap-ups**: each baton's wrap-up turn (the entries after its wrap-up start marker), counted
    apart from the conversation it wraps up.
  - **Coding sessions**: every coding session of the project, kind `coding` or `operator-coding`
    (§app.project-overseer/coding-worktrees).
  - **Their workers**: every worker and team member a coding session started, at any depth, pi or
    Claude Code (found through the session's worker manifests; a worker's own workers through its
    file's).
  - **Reconciler**: every decide call the reconciler made for the project, from its usage log
    (§app.project-costs/recording).
- **Who started it**, one of three: *the overseer* (a baton or coding session the overseer, or its
  project's charts on their own, started: §app.project-overseer/drive; its own conversations), *you* (the operator: a baton you started,
  Start Coding Session, New Coding Session, Reconcile Now) or *Sova on its own* (the reconciler's automatic runs). A
  wrap-up follows its baton, and a worker follows the coding session that started it.
- **Counted once.** Per file, a message is counted once (pi by entry id, Claude Code by
  `message.id`), with the fork boundary on for every file, so a fork never counts its parent's
  messages again; across sources, a transcript reached twice (a team member listed by two
  manifests) counts once.
- **Priced per message**, at the price in force at that message's own time
  (§app.project-costs/pricing): assistant replies, pi's `usage` entries (cache warming), and
  compaction and branch summaries that record usage.
- **Not counted**, and said on the card so the total isn't read as complete: topic summaries and
  image descriptions made inside coding sessions, Sova's own side calls (attention signals, session
  tags, the decide probe), and reconciler attempts that failed or timed out (they report no usage).

## §app.project-costs/pricing — How a message is priced

- A message's tokens split into **input, output, cache read, cache write 5 minutes and cache write
  1 hour**; reasoning is part of output, never priced apart. Each kind is priced at its own rate per
  million tokens, and a message's cost is the sum.
- **Which model.** The model the provider says answered (pi's `responseModel`, a Claude Code
  transcript's `message.model`) wins; else the message's recorded model, resolved through the alias
  table (§app.project-costs/price-table). An alias may be dated: `claude-code-cli/opus[1m]` is
  priced as Claude Opus 5 before its switch date and as Claude Opus 5.5 from it.
- **Long context.** Where models.dev lists a context tier for a model, a message whose request
  input (input + cache read + both cache writes) is over the tier's size is priced wholly at the tier's
  rates.
- **Estimates.** Claude Code messages recorded before the bridge split its cache writes
  (§app.project-costs/recording) carry one merged cache-write figure: it is priced at the 1-hour
  rate and marked an **estimate**. When any such part costs something, the project's total is
  written `≈$4.10` and a note says why; table cells and the org page's totals carry no mark.
- **Unpriced.** A model with no price (no alias, no models.dev row, or a row without rates) is
  **unpriced**: its tokens are counted and listed with the reason, and it adds nothing to the total.
  It is never priced like a sibling model.
- A local model (`ollama/…`, your own hardware) costs $0 and is shown as local, not unpriced; a
  Claude Code `<synthetic>` message costs $0.

## §app.project-costs/price-table — Where prices come from

- **Source: models.dev only** (`https://models.dev/api.json`): its single listed price per model, no
  time-of-day (peak or off-peak) pricing. models.dev lists one cache-write rate, the 5-minute one;
  the 1-hour rate is a hand-kept rule per provider in the alias table (Anthropic: 2× input).
- **Checked in, under `shared/model-prices/`**: a seed table (`seed.json`, the prices as last
  regenerated, used when nothing newer is on the host) and the hand-kept **alias table**
  (`aliases.json`), mapping Sova's model refs
  (`claude-code-cli/opus[1m]`, `openai-codex/gpt-6-sol`, `ollama-cloud/deepseek-v4-pro:0813`, …) to
  models.dev's `provider/model`, optionally dated, plus the models known to have no price and why.
  `pnpm run prices:update` regenerates the seed from models.dev.
- **Refreshed on its own, every 3 days.** At server start, and on a timer every 6 hours, the
  host's price data is fetched in the background when it is missing or older than 3 days (so a
  host that slept or restarted still refreshes on time). Startup never waits for it. The result is
  written atomically to the host-local cache `<stateRoot>/model-prices.json`, never to a tracked
  file. A failed fetch keeps the last good data and logs one line. A cache older than the seed gets
  the seed's prices folded on top, keeping its own history.
- **Dated periods.** When a refresh finds a model's rates changed, the old rates' period is closed
  and a new one opened at the refresh's time, so a message keeps the price in force when it was
  sent. The
  first period has no start, so messages from before the first fetch use the first price seen.
- **Switch.** `SOVA_PRICES_FETCH=off` (or `0`, `false`) turns fetching off (hermetic runs): the
  server prices with the cache if present, else the seed; `on` (`1`, `true`) allows it. Unset, a
  test process (`node --test`, `tsx --test`) never fetches and a server does, so tests never touch
  the network.

## §app.project-costs/recording — Usage that must be recorded to be priced

- **The reconciler's usage log.** Every decide answer the reconciler gets for a project (pairs,
  areas, a decision's outcome) appends one row to the workspace repo's
  `projects/<projectId>/usage.jsonl`: `{at, kind: "reconcile", by, provider, model, input, output,
  cacheRead, cacheWrite, cacheWrite1h?}`, `by` being who asked (`operator`, `overseer`, `sova`).
  An answer that reports no tokens writes nothing, and a failed or timed-out attempt reports none.
  One reconcile runs at a time per project, so an answer is recorded once. Append only.
- **The Claude Code bridge** (`pi-config/extensions/claude-code`) records, on each assistant
  message, the model that answered (`responseModel`, from the stream's `message_start`) and the
  1-hour cache writes apart (`usage.cacheWrite1h`, from `cache_creation.ephemeral_1h_input_tokens`;
  `cacheWrite` stays the total). Both are pi-ai's own fields; the message's `cost` stays 0.
- **Per-message counts** come from the worker-transcript readers' own dedup (pi and Claude Code),
  which hand each counted message's time, model and token split to the pricing, so a file is never
  counted two ways.

## §app.project-costs/ledger — What survives a missing file

- The workspace repo keeps `projects/<projectId>/costs.json`: per session (and per worker source),
  its title, kind, who started it, when it was last counted, and its token counts by model and by
  when they were spent (so each is priced at its own period), per token kind. The host that has
  the file writes it when the counts changed, at most once a minute per project. It holds no path,
  host name, link token or secret.
- A session whose file is on this host is recounted; one whose file isn't (a coding session run on
  another host, a Claude Code transcript deleted by its own cleanup) uses its last counted buckets,
  and the card says "as last counted". Dollars are always recomputed from the buckets with the
  current price table, so a corrected price corrects history.
- A running cost never shrinks because a project retired an old session from its list of 200: the
  ledger has no row cap.

## §app.project-costs/card — The Cost card on the project page

- A **Cost** card, the project page's Cost tab (§app.organizations/project-page).
- **Head:** the total (`$12.48`, mono) and "at API prices", then one line: "What these sessions would
  cost at each provider's API prices. Your subscriptions bill differently."
- **By who started it:** one line, only the starters with a cost ("Started by the overseer $8.10 ·
  by you $4.02 · by Sova on its own $0.36").
- **Breakdown**, after the top sessions, a disclosure closed by default ("Breakdown by kind and model") holding the two
  tables below.
- **By kind:** a table, `Kind` · `Cost`, one row per kind with a cost, in the order of
  §app.project-costs/scope.
- **By model:** a table, `Model` · `Input` · `Output` · `Cache read` · `Cache write` · `Cost`; each
  token cell is the dollars for that kind with the token count under it, muted (`$0.56` /
  `2.8M`); the last row, `All models`, sums each column, and is left out when there is only one model. Unpriced models are rows with their counts
  and `unpriced` in the cost cells. Under 560px of page width each row stacks, every figure under
  its column's name.
- **Top sessions:** up to 20, most expensive first: title (a link when the session is on this
  host), kind · who started it, cost.
- **Notes**, one line each, only when true: unpriced tokens, estimates, sessions not on this host,
  what isn't counted, and the date of the prices. Copy: §design.copy-deck/project-costs.
- Read on open, with Refresh Project, and every 60 seconds while the tab shows (paused while
  hidden). `GET /api/projects/:pid/costs`; the cost is never part of `GET …/overseer`.

## §app.project-costs/org-rollup — Totals on the org page

- The Projects tab says the org's total above the project list ("All projects: $40.12 at API
  prices."), and each project row shows its own total, mono, before the chevron. Read with the org page's Projects tab; `GET /api/orgs/:id/costs` answers each project's total
  and the org's.
- Nowhere else: not on the org list's cards, not in the sidebar.

## §app.project-costs/privacy — Who never sees costs

- **The owner page never** shows a cost, a token count or a price (§app.owner-page/never): no answer
  of `/api/i/*` and no part of the page shell reads the cost engine, the ledger or the usage log. A
  test fails if the owner page's code names them.
- **The project overseer never** sees a cost: not in `sova_project`, not in its prompt, not in any
  tool result. It has no limit to act on, and its owner updates could carry a figure to the owner
  page.
