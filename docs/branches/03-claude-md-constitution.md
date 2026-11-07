# #3 — Side exploration: `CLAUDE.md` and the constitution (`03-claude-md-constitution`)

**Status:** merged into `main`.

## What it did

Added project instructions for the AI coding assistant that works in this repo. It was meant to be Stage 2, but turned out to be a side exploration. That proved the branch counter is global and does not reserve numbers for stages in advance, which is why Stage 2 became #4.

## What changed

- **[`CLAUDE.md`](../../CLAUDE.md)**: loaded into every session. It is kept short on purpose and holds only what is needed on every task:
  - branch numbering (`NN-description`, one global counter)
  - PRs only: never merge, never delete a branch
  - docs stay in sync: the README and the published artifact mirror each other
- **[`constitution/`](../../constitution/)**: longer guidance, read only when the current task needs it, to keep token use down:

  | File | Read it when |
  |---|---|
  | [`git-workflow.md`](../../constitution/git-workflow.md) | branching, PRs, merge questions, cleanup |
  | [`mcp-architecture.md`](../../constitution/mcp-architecture.md) | writing or explaining server or client code |
  | [`testing.md`](../../constitution/testing.md) | verifying a change actually works |

## How to try it

Nothing to run. Open a session in the repo and the assistant reads `CLAUDE.md` automatically. Open a constitution file when you want the detail behind a rule.

## Notes

- Since #13, `CLAUDE.md` also requires a file in `docs/branches/` and an index line in the README for every numbered branch.
