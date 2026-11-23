---
title: Dry runs
description: A branch that changes a project's pipeline settings gets a dry run first. It runs the merge checks the branch adds or changes on its exact commit, so they're proven before they judge every branch after it.
group: Features
order: 10.52
---

A **dry run** runs the merge checks a branch adds or changes on its exact commit, in the project's
merge copy. Nothing lands from it and nothing is saved.

## Why not just run the tests?

A landing is checked with the main branch's checks, never the branch's own, so a branch can't weaken
the checks that judge it. That means a new or changed check never runs while its own branch lands.
The dry run proves it works before it judges every branch after it. Running the tests checks the
code; a dry run checks the checks.

## Which branches need one

Only branches that change the project's pipeline settings: its merge checks, release checks or
playbook, deploy targets, or a service a merge check needs. Each new commit needs a new one. Every
other branch lands as before.

## What it costs

Only the new or changed checks and the setup steps run, so it's usually short. Every other check
shows as **Not run (unchanged)**: it runs again in the landing, on the branch merged with the newest
main branch, so nothing goes unchecked. It uses the one merge copy, so landings wait while it runs.

## What you see

The branch's row always says that it needs one and why, read from what the branch changes:

- **Needs a dry run**: "Needs a dry run: adds the merge check Playbook tests".
- **Approved · dry run first**: you pressed Land; its dry run waits its turn in line. Your Land
  stands: it lands by itself once its dry run passes.
- **Dry run waiting**: you pressed Run Dry Run while the merge copy was busy. It starts after what
  holds the copy ("starts after the landing of feat/x").
- **Dry run running**: "Dry run running · check 2 of 3: …".
- **Dry run passed**: "Dry run passed at {commit}". The branch then lands like any other.
- **Dry run failed**: which check failed, its failing tests, the commit, and whose failure it is.
- **Dry run stopped**: by you, by its chat or by a Sova restart. Run it again: nothing failed.
- **Dry run couldn't run**: the machine, not the branch. Run it again.

Each of these sits beside one plain sentence and a **What's a dry run?** link that opens this
explanation in the app. A dry run of an older commit is never shown as the branch's current one: a
new commit reads afresh.

You see a dry run wherever the branch and the queue show:

- the branch's row on the Merge Queue tab's **Ready to land**, in the chat's worktrees control and in
  the session pane's Worktrees section;
- **Checking now** on the Merge Queue tab, in a landing's place, with who started it, the check it's
  on, **View Checks** and **Stop Dry Run**; **Waiting** says its entries start once it ends;
- the **Dry runs** tab, with the project's newest 20 dry runs, each with its commit, who started it,
  its result, when it ran and how long it took;
- the sidebar's landing bar, which reads "Dry run · {branch}";
- its run page, which says "Nothing lands from a dry run." and lists every check it ran and left out.

## Land runs it first

Press **Land** on a branch that needs a dry run and it joins the line as **Approved · dry run
first**. At its turn the dry run runs, and once it passes the landing follows by itself, with no
second press. Land's confirmation says so.

You can also start one yourself with **Run Dry Run** (or **Run Dry Run Again**) on the branch's
row, and stop a running or waiting one with **Stop Dry Run**. Stopping frees the merge copy at once;
the branch then needs a new dry run. A Sova restart stops any dry run that was running; one your
Land waits on starts again by itself.

## When a check fails

A failed check is run once more, then compared with the main branch the way a landing compares it:

- **This branch's change breaks it**: under your Land it goes back to its chat to fix, and your Land
  stands.
- **Fails on main too: not this branch's**: the dry run stops and asks you. Its chat is never told
  to fix it. You get **Fix**, **Fix in New Chat** and **Run Dry Run Again**, with **Land Anyway** in
  the menu (the landing still runs the main branch's checks).
- **Can't tell whose failure**: it waits for you, with **Land Anyway** and **Try Again**.

## Fix and Fix in New Chat

When a failure holds a branch up, its Land button becomes **Fix**, and the menu beside it offers
**Fix in New Chat**:

- **Fix** sends the failure's whole context to the branch's own chat: the check, its failing tests
  and errors, the commit, where the logs are, whose failure it is and what it holds up. The chat
  explains what's wrong and proposes how to fix it, then waits for you before it changes anything.
  Fix waits while that chat is working, and can't send to a chat open in a terminal.
- **Fix in New Chat** starts a fresh chat with that same context as its first message. For a
  failure the main branch shares, it works on a new branch from the main branch; for the branch's
  own failure, on that branch.

Once a new commit fixes it, the row reads afresh and Land (or Run Dry Run Again) comes back.
Neither button lands or approves anything.
