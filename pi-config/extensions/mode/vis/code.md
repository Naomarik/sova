<!-- owner: code member. kinds/code: View.tsx (hljs via lib/markdown, sticky numbered gutter, badges), lines.ts. Emphasis target: line number or range, as displayed. -->
# vis code
A snippet with lines to point at: the bug, the line that matters, what each part does. Use a plain code fence when nothing is marked. Settings and `mark` lines, a line with just `---`, then the code verbatim (at most 60 lines: show the part that matters).
```vis code
title: The off-by-one
lang: ts
start: 12
mark 13 error "<= reads one past the end"
mark 14 "adds undefined, so total is NaN"
---
for (let i = 0;
  i <= items.length;
  i++) total += items[i];
```
- `lang:` a fence word (ts, py, sql, …). `start:` the first line's number, as in the file.
- Marks go before `---`; all after it is code, shown verbatim: no fence lines and no `mark` lines there.
- `mark` targets: a line or a range `20-23` as displayed.
