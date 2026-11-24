# The report

Shown in the chat only, as one reply. Never saved to a file, in the project or outside it. Short enough to read in one go: the user asks the report writer for more.

## Order

1. **One line**: the answer ("3 contradictions, 1 of them high; the design skill is heavy; 8 broken links").
2. **Counts by severity**: a small table, issues found per kind (contradictions high · medium · low, references, orphans, repeats, heavy skills).
3. **Contradictions**, numbered, worst first. Each in one or two sentences: what conflicts, where both sides are (`file:line` and `file:line`), which an agent follows today, the proposed fix, how sure.
4. **Broken and out-of-date references**: one sentence each, or one per group when a single cause breaks several ("8 playwright pages link `../README.md`, which doesn't exist").
5. **Skills**: one short note per heavy or worth-a-look skill on its proposed layout (pages, what moves, ≈ tokens before → after); "deliberate" and "generated" said when they apply.
6. **Orphans and repeats**: one sentence each, grouped where one cause covers several.
7. **The numbers** (`references/metrics.md`): one compact table.
8. **Left out**: what the scope or the switches left out, and the user's own files' findings, report only.

## Style

- At least one sentence per issue, never only a path.
- Group when one cause covers several; never list the same finding twice.
- No preamble, no method, no file to open later. Quote a rule in a few words, never a paragraph.
- Use ≈ for every token figure.
