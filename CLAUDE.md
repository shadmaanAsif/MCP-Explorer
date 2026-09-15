# CLAUDE.md

This file is auto-loaded into every session working in this repo. Keep it short — anything that isn't needed on *every* task lives in `constitution/` instead, read only when the current task actually touches that area, to keep token usage down.

## What this project is

`mcp-explorer` — a learning project for building both halves of the Model Context Protocol (a server, then a client), one understood branch at a time. Full context lives in [README.md](README.md) and the published roadmap artifact linked from it — read those for the actual project narrative, not this file.

## Always follow these (cheap to keep loaded, expensive to get wrong)

- **Branch numbering.** Every new branch — a numbered stage or a side exploration — gets the next global sequence-number prefix: `NN-description`. One counter for everything, not one counter per stage. Check the README's Roadmap section for the next number before creating a branch.
- **PRs only. Never merge. Never delete a branch.** When the user says "merge," that means: commit, push, open a PR, and stop. Actually merging (and any branch cleanup) is the user's call, done by them — so branches stay around for reference afterward. Do not run `gh pr merge` (or anything that merges/deletes) unless the user's instruction is unambiguously "merge this," not just "create a PR." If unsure which they mean, ask.
- **Docs stay in sync.** The README and the published artifact mirror each other. A change to one (Roadmap, branch names, project structure, new sections) generally needs the matching change in the other.

## Load on demand (`constitution/`)

Read the relevant file below only when the current task actually needs it — don't preload all of these just because a session started.

| File | Read it when... |
|---|---|
| [constitution/git-workflow.md](constitution/git-workflow.md) | doing anything beyond a single commit — branching, PRs, merge questions, cleanup |
| [constitution/mcp-architecture.md](constitution/mcp-architecture.md) | writing or explaining server/client/transport code |
| [constitution/testing.md](constitution/testing.md) | verifying a change actually works, not just claiming it does |
