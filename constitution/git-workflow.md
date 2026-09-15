# Git workflow

## The cycle

branch → build → understand it → open a PR into `main` → **user merges manually** → branch again for the next thing.

Nothing moves to `main` until it's understood, not just working — merging is a deliberate checkpoint the user makes, not something that happens automatically once a PR exists.

## Branch numbering

Every new branch gets the next global sequence number as a prefix: `NN-description`. One counter across every branch — a numbered roadmap stage or a side exploration — so the branch list alone shows true creation order, not just which stages happen to be numbered.

- `stage-1-basic-server` and `explore-mcp-client` predate this convention (they'd be #1 and #2 in spirit) and were not renamed.
- `03-claude-md-constitution` (this file's own branch) is proof the counter is genuinely global: it claimed #3 even though Stage 2 was "next" in the roadmap, because it was created first.
- Before creating a branch, check the README's Roadmap section (or `git log --all --oneline --decorate`, or GitHub's branch list) for the highest number already used, and take the next one.

## PRs, merging, and branch cleanup — read this before running any of these

- Creating a PR once a branch's work is committed and pushed is expected — no need to ask permission each time.
- **Never run `gh pr merge` (or any equivalent merge action) unless the user explicitly says to merge.** "Let's create a PR" and "let's merge" are different instructions — only the second one means actually merge it.
- **Never pass `--delete-branch`, and never delete a branch after a merge, even if the tool offers to.** The user wants merged branches to stick around for future reference. This rule exists *because* the first merge in this project's history (PR #2, `explore-mcp-client`) deleted the branch — that was a mistake to avoid repeating, not the intended pattern.
- If it's genuinely ambiguous whether "merge" means "open a PR" or "actually merge it," ask rather than guess. A wrong guess here (an unwanted merge, or an unwanted deletion) is expensive to undo.

## Commit and PR attribution

End commit messages and PR descriptions with whatever attribution trailer is currently in effect for the session (this is supplied via a system reminder and can change over time — check the live one rather than assuming). Historically in this project: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` for commits, `🤖 Generated with [Claude Code](https://claude.com/claude-code)` for PR descriptions.
