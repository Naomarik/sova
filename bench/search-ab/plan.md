# bench/search-ab: the Overseer's conversation search, incumbent against ranked

**The plan for an offline A/B of the Overseer's search inside conversations, written before any
candidate code, so the result cannot shape the protocol.** Tooling only: nothing here changes what
Sova does. No runtime file imports this folder, nothing here edits `server/overseer-tools.ts`, the
Overseer's prompt or any path a running server takes, and it adds no dependency.

Precedents it mirrors: the board's retrieval bench (a private plan and `bench.mjs` in another
repository of the user's), and this repo's `pi-config/extensions/spec/tests/search/` with
`pi-config/extensions/spec/core/topic.mjs` (field-weighted BM25, k1 1.2, b 0.75, title weight 4, a
light stemmer, PATHISH tokens).

## The question

> Given the words the Overseer types into `sova_search_sessions` when it hunts for a past
> conversation, which ranking puts the session it was after in the first three it shows?

**Not the question:** typo tolerance, embeddings, a live trial. A live trial happens only if the
ranked search wins this table, and not in this task.

## The two systems

| Id | What | Constants |
| --- | --- | --- |
| `incumbent` | `searchSessions` from `server/overseer-roundup.ts`, **imported, never copied**: every word in one user or assistant message (case-insensitive substring), sessions newest first, 20 sessions × 3 snippets (the newest matching messages), a 10 s limit, at most 8 words | as shipped |
| `bm25f` | Per-session BM25F over fields title (the shown title plus `originalTitle`), summary (`outlineGist`, `outlineNow`, when the session has one), user text and assistant text, read through the same pi reader text path the incumbent uses (`lineEntry` + `joinedText`: no tool output, no thinking). Partial matches rank: a session holding every query term (anywhere in its fields) ranks above one holding only some; within a tier, by score. A session whose share of matched query terms is below `minCoverage` is not shown. Snippets: its 3 top-scoring messages. 20 sessions shown | k1 1.2, b 0.75, weights title 4 · summary 2 · user 1 · assistant 1, minCoverage 0.5 |

The tokenizer and stemmer are topic.mjs's own (`termsOf`, `wordsOf`), imported, not rewritten; the
one addition is a **joined variant** for a hyphen or underscore compound (`fix-widget-sort-flake`
also yields the single term `fix-widget-sort-flake`), because topic.mjs splits words at hyphens and
branch names are how sessions are often hunted. Paths stay whole (PATHISH).

Both systems see the same scope: the sessions `host.sessions()` lists, minus `skippedFromOverview`
(the Overseer's own, project overseers', organization, baton and worker sessions), last active in the
window (14 days by default, or the call's own `since`), filtered by the call's `project`.

## The dataset

A frozen private copy of every Sova conversation: the pi sessions directory (no `live/`), the project
and organization chats under Sova's state folder, and four id-keyed lists (archived ids, titles,
Overseer state, web-session ids). Copied once with `cp -a --reflink=always` (mtimes kept: a session's
last activity is its file's mtime), never linked. Standalone Claude Code history, the rest of the
state folder and credentials are not copied. The manifest (file list, sizes, mtimes, sha256 each,
copy time) and the **dataset hash** (sha256 over the sorted `path size sha256` lines) live in the
private folder; the results header names the hash, because a result that does not name its data
names nothing.

**As of a time.** A mined query is replayed against the corpus as it stood when it was asked: a
session created later is absent, a session's later lines are cut off (each line's own timestamp
decides), and its last activity is its last kept line. Titles are today's (a later rename leaks); a
summary counts only when it was written before the query.

**The listing.** Scope flags are computed offline from the copy, by Sova's own `listSessions` run
against it, plus what it cannot see from there: a worker named by an absolute path in its owner's
file (the path points at the real folder) is mapped by file name, project and organization chats are
skipped by where they live, and the Overseer's own folder by name. Organization builds (which only a
running org host knows) cannot be flagged offline; the instrument check measures how much that
matters.

## Ground truth

Frozen in the private folder before the first candidate run. Four sets, each with its bias stated
here and printed in every results file:

1. **Mined, search** (`sova_search_sessions` calls in the Overseer's logs). Label: the sessions it
   opened next (`sova_session`, `sova_read_session`) or linked in its reply (`sova://s/<id>`), before
   the next search or user message. **Bias:** the Overseer mostly opened what the incumbent showed
   it, so these favor the incumbent; a call that found nothing leaves no label and is dropped.
2. **Mined, list** (`sova_list_sessions` calls with a `query`, which matches title, folder or
   summary). Same labels. **Bias:** the words were chosen for a title match, so they favor a system
   that weighs titles (the candidate), and the label was seen through the list, not the search.
3. **Known item, synthetic.** For sampled in-scope sessions, 2 to 3 of the most distinctive words of
   its title (title query) or of its first prompt past the title (prompt query); the target is that
   session. **Bias:** title words are in the first user message, so the incumbent's "every word in one
   message" finds the target whenever it is among the 20 newest matches; the candidate's title weight
   favors it too. Easier than a real hunt.
4. **No answer.** Word combinations every word of which occurs in the corpus but that no single
   session holds together, checked over the whole copy. Any session shown is a false answer.
   **Bias:** a session holding some of the words may still be a reasonable near miss to a person;
   it is counted false anyway.

**Split:** by sha256 of the target session id (the first label for mined queries; the query text for
no-answer ones), even → dev, odd → held-out. Constants are tuned on dev only.

**Human grades (held-out only).** The user grades the pooled top 5 of both systems for ~40 held-out
queries, shown blind (no system named) and shuffled, 0 (not what I was after) / 1 (related) / 2 (the
one). A model never grades, and the harness author does not either. The held-out scoring waits for
those grades and runs once.

## What is compared

| Axis | Measure |
| --- | --- |
| Ranking quality | **Recall@3** (a label among the first 3), **MRR** (first label's reciprocal rank, 0 past 20), per set and pooled |
| False answers | Share of no-answer queries that show any session |
| Latency | per query: p50, p95; the incumbent twice: no time limit, and the real 10 s limit with `stoppedShort` counted |
| Cost | the candidate's index build time and RSS; lines of code; constants; dependencies (must be zero) |
| All time | an extra candidate line with no window: what a ranked search finds when nothing is cut off |

## The harness

`bench/search-ab/`, run with Bun from the worktree:

1. `freeze.ts`: the manifest, the offline listing, the stripped project list (private folder).
2. `mine.ts`: the four query sets, the split, `judgments.json` (private folder).
3. `bench.ts`:
   - **Instrument check first.** Replay every mined search call through the imported incumbent, as
     of its own time, with its own `since` and `project`, and compare with what its log says it got
     (the result's `details`: `total`, `searched`, `hits` in order). If the replay does not reproduce
     the logs, the bench stops there and reports it; no comparison runs on an instrument that cannot
     reproduce the known answer.
   - Dev runs of both systems, the sweep, and the results files.
   - `--label`: the grading tool (pooled, blind, shuffled, resumable, saved to the private folder).
   - `--heldout`: the held-out scoring, refused until the grades exist.
4. Per-query ranks and snippets go to the private folder. The repo's `results/` holds totals only:
   aggregate numbers and the dataset hash, never a query, session id, title, path or snippet.

## The protocol

1. Freeze the copy and the listing; write the manifest.
2. Freeze the labels.
3. Instrument check.
4. Both systems at the starting constants above, on dev. Exploratory, labelled as such.
5. Sweep on dev only, one constant at a time, every row logged even when it finds nothing.
6. The user grades the held-out pool.
7. Held-out scoring, once. A held-out set queried twice is a dev set.

**Decision rule. Every line must hold on held-out, or the incumbent stays:**

- Recall@3 not below the incumbent's, on the mined sets and on the graded pool (grade 2 counts as a
  hit);
- MRR strictly above the incumbent's on the same;
- the false-answer rate on no-answer queries at most 10 points above the incumbent's (the candidate
  shows partial matches by design, so some cost is expected; more than that and its answers stop
  being read);
- p95 latency within the 10 s limit, index build included when the index is per call;
- zero dependencies.

Ties go to the incumbent, and a tie is recorded so nobody re-runs it. A win here earns a live trial
plan, not a change to the Overseer.

## Amendments

Written after the first instrument check ran and before any candidate code existed; each names
what prompted it.

1. **Instrument check tolerance** (prompted by the first check: 45 of 47 calls exact). A call also
   passes when its logged and replayed hit lists are equal once every session active within 10
   minutes of the query time is set aside from both (a prefix, when a side reached the 20-session
   cap). Such a session may have had its last lines unwritten, or its mtime a moment off, when the
   Overseer searched, and the copy cannot tell. The strict count is printed beside it. Organization
   builds are inferred from Sova's worktree naming (`<root's parent>/.worktrees/<root's name>-…` of
   a project in an organization), the offline stand-in for the engine's running builds; that
   inference was added after the first check too, and it took the check from 42 to 45 exact.
2. **Which constants go to held-out** (fixed before the sweep runs). The starting constants, unless
   one single-constant row of the dev sweep beats them on pooled dev MRR by at least 0.02 with a
   dev false-answer rate no higher: then that row. Exactly one candidate configuration is scored on
   held-out.
3. **What the grader shows** (fixed before the pool is drawn). A pooled session is shown the same
   way whichever system found it: its title, folder name, last activity, summary line when it has
   one, its opening ask, and the one message holding the most query words (newest on a tie), so
   neither system's snippets reveal which one found it. A mined query is shown with the user's
   request that preceded the Overseer's call, the only statement of what it was after. The pool is
   40 held-out queries: the mined ones first (seeded order), then known-item ones to fill.
4. **Zero false answers selects the held-out constants** (2026-10-28, the user's call, decided after
   seeing the dev results; it overrides amendment 2's rule of switching only for an MRR gain). The
   held-out configuration is the dev row with no false answer on the dev no-answer queries that
   keeps the most pooled dev Recall@3, then MRR; a tie goes to fewer changes from the starting
   constants. Amendment 2 applies only when no row reaches zero. Prompted by the dev sweep:
   minCoverage 1 still answered 3 of 37 dev negatives. Each of the 3 was a stemmer merge: in every
   session shown, at least one query word was present only as another form of its stem. The
   candidate gained four options for this sweep (defaults off, so the starting constants are
   unchanged): `coverageOn: surface` (a query word counts toward coverage only as written, a whole
   word), `window: k` (coverage is the best share of query words any k adjacent messages hold
   together), and the score floors `floorRel` (a share of the best hit's score) and `floorAbs`. The
   sweep logs every single change from the starting constants, then each on top of minCoverage 1,
   then combinations, which were written only after the single rows were logged. All on dev only.
5. **Three model judges grade the held-out pool** (2026-10-29, the user's call, made before the pool
   was drawn with amendment 4's constants; it overrides "a model never grades" under Human grades).
   Three independent judges, each Claude Opus 5.5 (`claude-opus-5-5`) at medium effort, grade every
   pooled pair 0/1/2 on the same rubric; the grade used is the per-pair median, and `grades.json`
   names its grader. The judges see more than amendment 3's view: per pooled session its title,
   folder, last activity, summary when it had one by then, its first prompt, up to 5 of the user and
   assistant messages holding the most query words (each cut to about 400 characters), and the path
   of the copied file cut at the query time, all as of the query time; still blind (no system named,
   the pool's shuffled order). A mined query keeps the user's request before the call. Pairwise exact
   agreement, Fleiss' kappa and the pairs the judges spread from 0 to 2 are written beside the
   grades (`judge-agreement.json`, private) and reported with the held-out results.

## Risks, stated before the runs

- **Implicit labels follow the incumbent.** The Overseer opened what it was shown. Set 1 cannot show
  the candidate finding what the incumbent hid; the graded pool is the only tier that can.
- **The corpus moves.** Results name the dataset hash; a re-run on a new copy is a new dataset.
- **As-of replay is approximate.** Last activity from line timestamps, not the mtime at the time;
  today's titles. The instrument check measures the gap.
- **The candidate's index is a bench artifact**: time-aware postings over the whole copy, so one index
  serves every query time. Its build cost is not what a live index would cost; it is reported, not
  hidden.
