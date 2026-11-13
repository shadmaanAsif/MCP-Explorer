# #19 — Split `review.ts` into a folder (`19-split-review-module`)

**Status:** built, not yet merged. A refactor between Stage 9 and Stage 10, not a stage. **No behaviour change.**

## Why

`review.ts` had grown to 610 lines with four unrelated jobs mixed together (finding the project, guarding file access, running git, running checks). Stage 10 adds scope checks to these tools, and a change there should touch a small file, not a 600-line one.

## What changed

```
packages/server/src/review/
├── index.ts            registerReview: the 3 tools, the prompt, the resource (231 lines)
└── helpers/
    ├── roots.ts        which project: getRoot, REVIEW_ROOT, client roots, allow-list, HTTP refusal
    ├── files.ts        the path guard: isInside, isBlocked, resolveSafe, readRepoFile, listRepoFiles
    ├── git.ts          gitToplevel, gitDiff, checkRef, defaultBaseBranch
    ├── checks.ts       package manager detection, runCheck (process group, timeout)
    └── errors.ts       ReviewError, truncate
```

- Code was **moved, not rewritten.** The only edits are `export` keywords, imports, and the one import path in `create-server.ts` (`./review/index.js`).
- `execFileAsync` lives in `git.ts` and is shared with `files.ts`.
- The 181 tests and the contract snapshot pass **unchanged**. That is the proof nothing moved semantically.

## Try it end to end

1. Build and run the full suite from the repo root. Expect 181 passing and no change to the contract snapshot.
   ```bash
   pnpm build && pnpm test
   ```
2. Check that no snapshot or test file was edited.
   ```bash
   git diff main --stat -- packages/server/test
   ```
   It should print nothing.
3. Run the review server over stdio against this repo and call a tool (Inspector, or restart `mcp-demo-review` in Cursor):
   ```bash
   REVIEW_ROOT=$PWD node packages/server/build/index.js
   ```
   `read_file` on `package.json` should return the file and end with `[repo: …]`. `read_file` on `.env` must still be refused.
4. Confirm the old file is gone and the new layout exists:
   ```bash
   ls packages/server/src/review packages/server/src/review/helpers
   ```
