# Red baseline at branch base e889413 (recorded 2026-09-21T21:00Z)

Inherited from master: another team's in-flight FileIndex / file-mention work is uncommitted in the main checkout. Nobody on this branch touches these files (additive-only edits to shared/protocol.ts and src/lib/api.ts are allowed for P3). Gate = no failures beyond this set.

## npm run typecheck
```
src/components/ChatView.tsx(796,14): error TS2532: Object is possibly 'undefined'.
src/components/FileMenu.tsx(73,33): error TS2339: Property 'error' does not exist on type 'FileMenuStatus'.
src/lib/api.ts(74,11): error TS2304: Cannot find name 'FileIndex'.
src/lib/files.ts(7,15): error TS2305: Module '"../../shared/protocol"' has no exported member 'FileIndex'.
src/lib/files.ts(39,38): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/lib/files.ts(84,11): error TS2339: Property 'dirPrefix' does not exist on type '{ dir: string; segment: string; }'.
```

## npm test (failing tests)
```
src/lib/files.test.ts — 11 failing (all "Cannot read properties of null (reading 'query')" from src/lib/files.ts:109):
- mentionTokenAt finds the @ token at the start and after whitespace
- mentionTokenAt ends the token at the next whitespace and tracks the caret's side
- mentionTokenAt keeps a quoted path (spaces) one token
- mentionEntries lists one level: directories first, then names
- mentionEntries filters by the segment, case-insensitively
- mentionEntries shows hidden entries once the segment starts with a dot
- mentionEntries takes the path through to the picked name
- insertMention completes a file and closes the token with a space
- insertMention drills into a directory: slash, no space, token continues
- insertMention quotes only paths with spaces, closing the quote on a file
- insertMention quotes the whole path when only the directory had spaces
Totals at base: 579 tests, 568 pass, 11 fail.

Extension tests (node pi-config/extensions/claude-code/tests/run.mjs): GREEN, 139/139.
```
