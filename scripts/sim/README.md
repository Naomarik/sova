# The chat-powers simulation

An end-to-end scenario on a hermetic Sova server: a made-up organization, **Mamluk Arabia** (a
traditional archery club; modelled on a real client, but nothing was copied from any real workspace),
whose founder **Alperen** is played by Claude Code on `claude-haiku-5-5` and answers a gathering chat
about the club's new website. Then it checks what the chat left behind, and drives the owner's Project
Assistant.

```sh
node scripts/sim/run.mjs                 # everything
node scripts/sim/run.mjs --only gather   # the gathering and its checks (C1–C5)
node scripts/sim/run.mjs --only s2       # the Project Assistant scenario
```

Options: `--port 4836 --share-port 4837` (never 4800), `--turns 20` (Alperen's message cap),
`--gather-model zai/glm-5.3` (the gathering chat's model), `--cheap-model zai/glm-5.3` (the project
overseer, coding sessions, throwaways), `--keep` (leave the server up).

Run it as one foreground command: a sandboxed shell stops what it started when the command returns.
A gathering takes about 3 minutes, the whole run about 10. Exit 0 only when nothing FAILs.

## What it does

1. Copies `fixtures/mamluk-arabia/project` into a scratch root in the temp dir: `site/` (a static
   site) and `seed-spec/` as `.sova/spec/` (a few accepted claims and one candidate, with a quote and
   roster names in their prose), then `git init` + one commit on `master`.
2. Builds a fresh agent dir at `<worktree>/.cache/sim/agent` (`scripts/hermetic-agent-dir.mjs` with
   `HERMETIC_AGENT_DIR`), copies `~/.pi/agent/auth.json` in, and starts the server with `SOVA_SHARE_HOST`
   / `SOVA_SHARE_PORT` so links work, without this shell's `SOVA_*` / `PI_*` variables.
3. Creates the org, its roster (`fixtures/mamluk-arabia/org.json`), Alperen as owner, the project; the
   project overseer and its coding sessions on the cheap model, holds of 1 minute.
4. Starts a gathering to Alperen (`POST /api/baton`) and answers it through his share link, one haiku
   reply per turn (`fixtures/mamluk-arabia/alperen.md` is his private brief), until the chat is done.
5. Runs the checks (below), archives its throwaway sessions, stops the server and its chats.

## Checks

| id | passes when |
| --- | --- |
| G | the gathering reaches `done` |
| C1 | `.sova/spec/claims/**` + `manifest.json` are byte-identical on disk and in git `master` |
| C2 | the conversation's draft (`<root>/.sova/spec/drafts/conv-<sid>/spec`) adds text holding every required group in `requirements.json`; its record lists the items |
| C2b | the draft record's state is `confirmed` |
| C2c | `requirements_confirm` follows a `requirements_summary` and a message of Alperen's after it |
| C3 | every `spec_lookup` result is wrapped and has none of `sentinels.specLookup` (people, quotes, § ids, paths, labels); `code_read` none of `sentinels.codeRead`; replies none of `sentinels.replies`. INCONCLUSIVE when `spec_lookup` never ran |
| C3b | a look-up that reaches the candidate record carries "Proposed, not settled yet" |
| C4a | `GET /api/draft-specs?project=` lists his conversation with the required groups |
| C4b | the project overseer, asked "What are the draft specs?", calls `sova_draft_specs` and names the required groups |
| C5 | `POST /api/projects/:pid/draft-specs/:sid/build` starts a coding session whose first prompt names the draft and holds the groups, and which can say what the draft asks for |
| S2 Off | with `codingStart` Off in the assistant column, an owner's bug + feature message raises an `owner-request` in Needs you and starts no coding session |
| S2 On | with it On, a `held-act` appears, then a coding session starts after the hold |

A step whose contract hasn't landed is PENDING (`contracts.mjs`), never a pass. The contracts are
`.chat-powers-brief/ARCH.md` §3, §4.1–4.5.

## Output

`<worktree>/.cache/sim/runs/<run id>/`: `report.json` (every result), `gathering-chat.txt` (the
conversation as his phone shows it), `gathering-session.jsonl`, `gathering-tools.json`, `c3-scan.json`,
`draft-*`, `c4*`, `c5*`, `server.log`, and `master-spec/` (the seed as committed).
