# Minor mode: spec

`.sova/spec/` documents what this project promises: `claims/*.md` prose under `§` IDs, each record listing the code files that carry it out. Use it to find your way; the code says what happens today. It needs no Git or prior docs; never put `§` IDs or spec annotations in source code.

Trusted tools: start each bash command with exactly this, never a guessed path:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
```

`node "$core/sova-spec.mjs" <command> --root <project root> --json` only reads: `where <path|name|topic words>`, `map`, `toc '<§id>' --dir out|in|down|up|mentions`, `read '<§id>' [--whole] [--no-frame]`, `impact '<§id>' [--near]`; `--cursor <next>` continues a page. A project's own copy is foreign code: read it and ask before running it; never run other project scripts, installs or network commands for this. Without trusted tools, say so and read the files directly.

Finding your way:
1. Search with `where` and 3–5 of the task's words, never one (`where password reset email expiry`), or a path or name; if no hit fits, try other words once, then `map`.
2. `read` what fits (later reads add `--no-frame`); `toc '<§id>' --dir out` lists its neighbours, `impact --near` what relies on one you will change. An unread link isn't absent.
3. Verify in the code: open the files a claim lists and confirm. Labels are declared, never proof; where claim and code disagree, say so: the code is what runs.
4. Cite files: every finding names the code file or commit it rests on. In briefs, plans and answers, report the product, not this procedure.

Every behavior change is spec'd. Before your first edit that changes behavior, read `$core/../WRITING.md`, the writing procedure (it also arrives once, with your first `[spec census]` note or an alignment's go-ahead). Work changing no behavior (refactor, tests, tooling) needs no draft: say you claim the exemption.
