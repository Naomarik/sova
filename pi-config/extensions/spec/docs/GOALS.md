# Sova's spec: goals and constraints

## What the spec is

The spec says in plain English what a system promises to do. It includes the exact names, addresses and messages other parts rely on, and the shapes of data stored and sent. Each promise has a permanent name (a `§` id), names the promises it depends on, and lists the code files that carry it out. It lives in `.sova/spec/`, beside the code, never inside it.

## Why we write it: spec first

We decide what to build before we build it, and we write that decision in the spec.

When someone talks about what the system must do, that conversation is spec work. The agent works out the behaviour with them and writes it into the spec before any code exists. Building is a separate step that starts from the spec.

This pays for all the upkeep. Because settled behaviour is already written in plain English, the tools can hand a builder everything already true around new work, so nobody has to work it out from source code. The person deciding sees the same thing while they decide.

## The workflow

1. **Talk.** Someone says what the system must do. The agent looks up what is already true nearby, works out the behaviour with them, and writes it as promises in a draft.
2. **Agree.** The person agrees to the wording. The promises go into the main spec, marked *agreed, not built*, with who agreed and when.
3. **Build.** A builder starts from the agreed promises, perhaps in another worktree on another day.
4. **Reconcile.** The code is read against the promises. Each gap is fixed on the side that is wrong: a defect in the code, or a hole in the spec. The promise is then marked *built and checked*, with what it was checked against.

Agreed but unbuilt promises are the normal state between steps 2 and 4. Text written down from existing code, but not yet reviewed, has its own mark.

**When writing the spec finds a gap,** the agent sorts it one of three ways:
- a clash with something already decided goes back to the person;
- a detail nobody decided becomes a flagged assumption plus an open question;
- a pure wording choice, the agent just makes.

Once a decision is made, later readers build on it. They don't argue it again.

### What the tools give at each step

- **Talk:** a map of every area, and a way to find the promises around a topic or a file, so clashes show while deciding.
- **Agree:** promotion into the main spec, and the *agreed, not built* mark.
- **Build:** first a contents view of the promises around the work: what each one is, why it is linked and how big it is, in the direction the task needs. Then a slice: the passages the builder chose, word for word, plus a small set that always arrives: the promises to build, the rules that always apply, and anything drawn inside them. The contents also point to the shapes of data involved, and to what is not owned here or still undecided. The slice names what it did not load, so the builder knows where to stop.
- **Reconcile:** the promises this change touched and the code each maps to; later, a note when text or code moved since the check.

## Spec mode and align mode

Sova has two separate minor modes. Each works alone, and both can be on.

- **Spec mode alone carries spec first.** With spec on and align off, behaviour is still written into the spec and agreed before any code.
- **Align mode** has the agent investigate and put design questions to the user before building, then record the answers.
- **With both on,** agreeing in align and changing the spec are one act. Each decision is written once, as a promise, not kept in two records.

## Goals

### 1. Decide what we build before we build it

We know it's working when:
- every behaviour change has its promises agreed before its first code edit;
- a requirements chat with no code ends with agreed promises in the main spec, each saying who decided;
- the later build updates those same promises instead of writing new ones;
- a settled decision is rarely asked about again.

### 2. Builders get everything already true around new work

We know it's working when:
- on a fixed set of real tasks, the share of needed facts found in the slice goes up and never down, while the slice stays small;
- every needed fact that isn't in the slice is at least named there, one step away;
- a feature can be built from its slice alone, with no reading of source outside it, in parallel with other features;
- from any source file, you can list the promises that cover it;
- the tools say when text or code moved since a check, rarely and precisely enough that someone acts. A warning everyone ignores is a failure.

### 3. Anyone learns the system fast, without source

We know it's working when:
- one map shows every area, with a line on what it owns and doesn't own;
- a fresh agent answers "what does this area do?" for sample areas from the spec alone, and the answers match the code.

### 4. Code and spec agree after building

We know it's working when:
- each built promise has been read against its code;
- the map shows how many promises are agreed but unbuilt, and how old they are;
- reviews against the spec keep finding real defects and real holes, and both get fixed.

### 5. Complete enough to rebuild an area from

This is the test of the goals above.

We know it's working when:
- an agent rebuilds one area from the spec, and the area's existing tests pass (tests written against the running system, not from the spec);
- each time it had to read old code becomes a fix to the spec.

### 6. The builder chooses what it reads

Goal 2 says what the builder must be able to find. This goal says how it gets there without reading everything nearby. Handing over a promise with its whole chain of dependencies decides for the builder, and most of the chain has nothing to do with the task. Instead:
- the builder sees a contents view first: one line per neighbouring promise, saying what it is, why it is linked and how big it is;
- it picks the direction the task needs: what this depends on, what depends on it, what is inside it, or what mentions it;
- it can read any single promise alone, at its own size, without pulling its chain;
- a small set always arrives unasked: the promise itself, the rules that always apply, and anything drawn inside it;
- what its own change touched decides what it must read before finishing.

We know it's working when:
- on the same fixed tasks, the bytes a builder reads go down while the needed facts it finds never drop;
- every line of a contents view says what the promise is and why it is linked, or says plainly that no reason is written;
- reading one promise costs about its own size, not the size of what it depends on;
- every link the builder did not open is still named in what it was given, so "didn't open" never reads as "nothing there";
- before finishing, the builder has read every promise its own change landed in.

## Constraints

Every design must meet all five. They are not traded against the goals.

1. **It works in any project, through the spec mode, not just Sova.** Rules out anything that assumes Sova's names, server or branches; project specifics are data in that project's spec.
2. **It grows piece by piece, from any source.** It can start empty and grow one promise at a time, from a coding task, a review, or a chat where a user or stakeholder talks through requirements (a handoff session is one example). Rules out anything that must be written in full before it is useful.
3. **Every change slots cleanly into the main spec.** The main spec is frozen; promotion is the only way in, from a worktree, a chat or anywhere else. Many agents work at once in separate worktrees, then promote and merge. Rules out shared lists every change edits, committed generated output, and conflicts except where two changes edit the same promise.
4. **Source code carries no `§` ids and no spec notes.** Rules out markers in code and any tool that needs them. Links from code to promises live in the spec, or come from names the code already uses: routes, file names, type names.
5. **It stays light.** Upkeep stays small next to the work, at about 160 commits and 25 merges a day. Rules out steps repeated on every commit, notes with nothing new to say, a second set of documents to keep in step, and tables in prose that need their own parser. Today upkeep takes about 7% of a change's tool calls and 17–32% of a merge's; the target budget is (open).

## The rules that hold it up

Drafts, marks, checks and closing lines exist only to serve the goals and constraints above. A rule or tool that serves none of them should go. A few rules hold up the rest:

- **Names are permanent.** A `§` is never reused or quietly given a new meaning, so a change from anywhere still points at what it meant.
- **Each fact is said once.** The second copy is the one that goes stale.
- **Tools say what they checked.** "Didn't look" is never reported as "found nothing".
- **Code locations sit beside the text,** in each promise's list of code files, never in the source.

How much of "how" the spec holds is (open). The shapes of stored and sent data are in.

## Not what it's for

- Proving the code is correct.
- Replacing tests.
- Stopping work or releases. The tools report and people decide. The one gate is that only promotion writes the main spec.
- Keeping records for their own sake.
- Describing every file. Tests, fixtures and plumbing need no promises, and work that changes no behaviour needs no new ones.

## How to judge a change to the spec system

Every change, including adding or removing a rule or tool, names the goal it serves. It then shows, by measuring against the current tools on the same inputs, that it moved that goal's measure and broke no other goal or constraint. Now and then, check the "We know it's working when" lines against real sessions, not impressions.
