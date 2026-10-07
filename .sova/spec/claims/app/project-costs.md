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
  - **Wrap-ups**: each baton's wrap-up turn (the calls its wrap-up turn made, recorded as such), counted
    apart from the conversation it wraps up.
  - **Coding sessions**: every coding session of the project, kind `coding` or `operator-coding`
    (§app.project-overseer/coding-worktrees).
  - **Their workers**: every worker and team member a coding session started, at any depth, pi or
    Claude Code (found through the usage ledger: every recorded call whose parent chain reaches
    the coding session).
  - **Reconciler**: every decide call the reconciler made for the project, recorded in the usage
    ledger with the project's id (§app.project-costs/recording).
- **Who started it**, one of three: *the overseer* (a baton or coding session the overseer, or its
  project's charts on their own, started: §app.project-overseer/drive; its own conversations), *you* (the operator: a baton you started,
  Start Coding Session, New Coding Session, Reconcile Now) or *Sova on its own* (the reconciler's automatic runs). A
  wrap-up follows its baton, and a worker follows the coding session that started it.
- **Counted from the usage ledger** (§app.insights/usage-ledger): every call those sessions made
  on this device, once, at the call's end: replies on every branch, retries, compaction, branch
  summaries and cache warming. A fork counts only its own calls, never its parent's again.
- **Priced per call**, at the price in force at that call's own time
  (§app.project-costs/pricing), by the one pricing function every spend figure uses.
- **Not counted**, and said on the card so the total isn't read as complete: Sova's own side
  calls that name no session of the project (attention signals, session tags, the decide probe),
  and reconciler attempts that failed or timed out (they report no usage).

## §app.project-costs/pricing — How a message is priced

- A message's tokens split into **input, output, cache read, cache write 5 minutes and cache write
  1 hour**; reasoning is part of output, never priced apart. Each kind is priced at its own rate per
  million tokens, and a message's cost is the sum.
- **Which model.** The model the provider says answered (pi's `responseModel`, a Claude Code
  transcript's `message.model`) wins; else the message's recorded model, resolved through the alias
  table (§app.project-costs/price-table). A Claude model, answered or asked for, is priced by its
  catalog entry's price key (§app.claude-code-provider/catalog); an answer the price table doesn't
  list is unpriced, never priced through the model asked for. An alias may be dated:
  `claude-code-cli/opus[1m]` is priced as Claude Opus 5 before its switch date and as Claude Opus
  5.5 from it.
- **Long context.** Where models.dev lists a context tier for a model, a message whose request
  input (input + cache read + both cache writes) is over the tier's size is priced wholly at the tier's
  rates.
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
- **Pulled every 6 hours, and on demand.** The usage helper (§app.insights/usage-ledger) pulls
  models.dev at its start when the last pull is 6 hours old or more, then every 6 hours, and when
  the Costs tab's **Refresh prices** asks (§app.insights/cost-history). Startup never waits for
  it. The host's dated price history is data, `<stateRoot>/model-prices.json`, written
  atomically, never a tracked file; the checked-in seed is copied there only when the file is
  missing. A failed pull keeps the last good data and logs one line.
- **Dated periods.** When a pull finds a model's rates changed, the current period is closed
  and a new one opened at the pull's time, so a call keeps the price in force when it was made.
  A pull only adds periods: an older period, or a date entered by hand, is never dropped or
  rewritten, and a model models.dev stopped listing keeps its history. The
  first period has no start, so messages from before the first fetch use the first price seen.
- **Switch.** `SOVA_PRICES_FETCH=off` (or `0`, `false`) turns fetching off (hermetic runs): the
  server prices with the cache if present, else the seed; `on` (`1`, `true`) allows it. Unset, a
  test process (`node --test`, `tsx --test`) never fetches and a server does, so tests never touch
  the network.

## §app.project-costs/recording — Usage that must be recorded to be priced

- **The reconciler's calls.** Every decide call the reconciler makes for a project writes a usage
  record (§app.insights/usage-ledger) carrying the project's id and purpose `reconcile`; that is
  what the cost counts. A call that reports no tokens writes nothing, and a failed or timed-out
  attempt reports none. The workspace repo's `projects/<projectId>/usage.jsonl` may still be
  appended as an audit log, but no cost reads it.
- **The Claude Code bridge** (`pi-config/extensions/claude-code`) records, on each assistant
  message, the model that answered (`responseModel`, from the stream's `message_start`) and the
  1-hour cache writes apart (`usage.cacheWrite1h`, from `cache_creation.ephemeral_1h_input_tokens`;
  `cacheWrite` stays the total). Both are pi-ai's own fields; the message's `cost` stays 0.
- **Per-call counts** come from the usage ledger only: no transcript is read to count a cost.

## §app.project-costs/ledger — What survives a missing file

- The workspace repo keeps `projects/<projectId>/costs.json`: per session (and per worker source,
  and per host's reconciler calls), its title, kind, who started it, when it was last counted, and
  its token counts by model and by when they were spent (so each is priced at its own period), per
  token kind, taken from the usage ledger. A host writes the rows of what its own ledger holds when
  they changed, at most once a minute per project. It holds no path, host name, link token or
  secret.
- What this device's ledger holds is counted from the ledger; a row only another host recorded (a
  coding session run there, that host's reconciler calls) uses its last counted buckets, and the
  card says "as last counted". Dollars are always recomputed from the buckets with the current
  price table, so a corrected price corrects history.
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
- **Notes**, one line each, only when true: unpriced tokens, sessions not on this host,
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
