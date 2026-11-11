# #16 — Stage 8: code review server (`16-stage-8-code-review`)

**Status:** built, not yet merged. It also carries a small docs cleanup (Stage 7 marked as merged).

## What it does

Stages 1–7 built the server and its plumbing. Stage 8 gives it a job: helping a model **review code**. The server does not review anything. The client's model does. The server only supplies what the model needs, using all three primitives together:

| Primitive | Name | Who triggers it | Job |
|---|---|---|---|
| Prompt | `review_code(focus?, base?, head?, root?)` | The user picks it | All four arguments are optional, because some clients (Cursor) send none from a slash command. Defaults: `focus` = `all`, `head` = `HEAD`, `base` = the repo's default branch (`origin/HEAD`, else the first of `develop`, `main`, `master` that exists). A ready-made request: call `get_diff`, then `read_file`, then `run_checks`, and report findings with file, line and a fix. It also tells the model to pass the project path as `root`. |
| Tool | `get_diff(base, head, root?)` | The model | The git changes on `head` since it diverged from `base` (`git diff base...head`). |
| Tool | `read_file(path, root?)` | The model | One file's text, for context the diff doesn't show. |
| Tool | `run_checks(checks, root?)` | The model | Runs `build`, `test` and/or `typecheck` in order with `pnpm run <name>`. Reports progress after each check; a client cancel kills the running check (stateful mode only). |
| Resource | `repo://file/{+path}` | The user or app attaches it | The same files as `read_file`, as context, with a file list and path completion. It has no `root` argument. |

All of it lives in [`review.ts`](../../packages/server/src/review.ts), registered from `createServer()` with one line, like `catalog.ts`.

## Which repo it reviews

The server needs to know which project to look at. It decides in this order:

1. **`REVIEW_ROOT`:** an operator setting that pins one repo. A `root` argument may only name that same repo.
2. **The `root` argument** of the tool call. The `review_code` prompt asks the model to pass its open workspace folder here. This works with any client that has a model.
3. **The client's roots:** the MCP way for a client to declare its open folders. The server asks with `listRoots()`. Only clients that declare the `roots` capability answer; Cursor did not in our run.
4. **The start folder:** the git root of the folder the server was started in. stdio keeps this fallback. When an admin allows the tools over HTTP, the HTTP server turns it off (`REVIEW_REQUIRE_ROOT=1`), because a shared server has no meaningful start folder. A call that names no project then fails with "Pass `root` with the absolute path of the project". `REVIEW_REQUIRE_ROOT=0` brings the fallback back.

A bad `root` (relative, missing, outside the allow-list, or different from a pinned `REVIEW_ROOT`) is an **error**. It never falls back to a different repo. Every result ends with a `[repo: /path]` line, so a wrong repo is visible.

| Setting | Meaning |
|---|---|
| `REVIEW_ROOT` | Pin one repo. Wins over everything. |
| `REVIEW_ALLOWED_ROOTS` | Colon-separated folders. A `root` or client root outside them is refused. Off by default. |
| `REVIEW_ALLOW_HTTP` | `1`: an admin lets the review tools run over HTTP. Off by default; without it they refuse. |
| `REVIEW_REQUIRE_ROOT` | Only matters when allowed over HTTP. `1` (default there): fail when no project is named. `0`: use the start folder. |
| `REVIEW_CHECK_TIMEOUT_MS` | Timeout for each check. Default 120000. |

## What it refuses

This is the first code that touches the filesystem and starts processes for a caller, and authentication is still two stages away. So every input is checked:

- **Paths:** `../`, absolute paths in file arguments, and symlinks that point outside the repo.
- **Blocked files:** `.env*`, `.pem`/`.key` files and `.git/` cannot be read, listed or shown in a diff.
- **Git refs:** a ref cannot start with `-`, contain `..` or contain shell characters, and git runs without a shell.
- **`run_checks`:** the caller picks a name from a fixed list and never supplies a command. There is a timeout and an output cap.
- **Sizes:** files over 200,000 bytes and diffs over 100,000 characters are refused or truncated.

## Where it works, and where it does not

**The review tools work over stdio only.** They read the disk of the machine the server runs on. Over stdio that is the user's own machine, because the client starts the server there. Over HTTP the server is usually somewhere else, so it would look at the wrong disk.

| Setup | Result |
|---|---|
| **stdio**, started by the client on the user's machine | **Works.** It runs as the user and sees their real project. |
| **HTTP** (any machine) | **Refused by default.** The tools return an error, and so do the prompt and the resource. |
| **HTTP, admin opted in** (`REVIEW_ALLOW_HTTP=1`) | Works when the server and the project share a disk, with `root` and `REVIEW_ALLOWED_ROOTS`. Meant for a local setup. |

What a client sees over HTTP (a tool result with `isError`, and the same text as the error for the prompt and the resource):

> Code review tools are not available over HTTP: they read the disk of the machine the server runs on, not your project. Use the stdio server on your own machine (docs/connecting-clients.md, section 9). If you want them to run on this server, ask the server admin to set REVIEW_ALLOW_HTTP=1 and REVIEW_ALLOWED_ROOTS and restart it.

How it is done: `http.ts` sets `REVIEW_TRANSPORT=http` at startup, and every review path (the three tools, the prompt, the resource and its list) calls `assertReviewAllowed()` first. The tools stay listed, so a client sees them and gets an explanation, instead of a missing tool. The weather tools, resources and prompts are not affected.

**Why an admin has to opt in:** a deployed server cannot see a client's files, and `run_checks` would execute project scripts on the server host. Without authentication (Stages 9 and 10) that is a risk, so it is off unless the person who runs the server turns it on. A remote design would need the server to clone a repo into a sandbox, or the client to send the diff text as an argument. Neither is built.

## How to connect and try it

See [connecting-clients.md](../connecting-clients.md) section 9. In short, use **stdio**:

```bash
pnpm install
pnpm build
```

Put this in the `.cursor/mcp.json` of the project you want reviewed:
```json
{
  "mcpServers": {
    "mcp-demo-review": {
      "command": "node",
      "args": ["/absolute/path/to/MCP-Explorer/packages/server/build/index.js"],
      "env": { "REVIEW_ROOT": "/absolute/path/to/this/project" }
    }
  }
}
```
Turn the server on in Cursor, then run `/<server>/review_code` on its own (Cursor sends no arguments, so the defaults apply: `focus` all, current branch against the repo's default branch). To change the focus or base, ask the model in plain words instead. Check the `[repo: …]` line at the end of each result.

**Do not use** the `mcp-demo-http` entry for review: it returns the error above.

**Local HTTP, only if you want it** (an admin decision):
```bash
REVIEW_ALLOW_HTTP=1 REVIEW_ALLOWED_ROOTS=/Users/you/projects pnpm start:http
```

## Verified

- **Tests:** the suite is **145 tests** (up from 62) and passed 3 runs in a row.
  - [`review.test.ts`](../../packages/server/test/review.test.ts): 38 tests against a throwaway git repo.
  - [`roots.test.ts`](../../packages/server/test/roots.test.ts): 33 tests for client roots, the `root` argument, the allow-list, a pinned `REVIEW_ROOT` and `REVIEW_REQUIRE_ROOT`.
  - [`http.test.ts`](../../packages/server/test/http.test.ts): by default the HTTP server refuses all three tools, the prompt and the resource with the message above (and the weather tools still work). With `REVIEW_ALLOW_HTTP=1`, `run_checks` cancel through the real server (stops the check in stateful mode, not in stateless), and a call that names no project is refused.
  - The schema snapshot ([`contract.test.ts`](../../packages/server/test/contract.test.ts)) grew by the new tools, resource template, prompt and the `root` field. Two older in-memory tests that asserted exact lists now check that the weather items are present.
- **Breaking the code on purpose was caught:** the symlink check, the `../` check, the dash-ref rule, the diff secret excludes, the `.env` block, the cancel signal, client roots, `REVIEW_ROOT` precedence, the allow-list, the pin check, the `root` argument and `REVIEW_REQUIRE_ROOT` each made at least one test fail, and so did removing the HTTP gate from the tools or from the prompt, the server no longer marking itself as HTTP, and ignoring the admin opt-in. Every file was restored afterwards.
- **stdio smoke test:** the built `index.js` was started from `/tmp` with `REVIEW_ROOT` set. It listed all 9 tools and read a file from the named project.

## Not verified, and known limits

- **Cursor:** I did not see the `root` argument or the prompt work end to end in Cursor. In our first run Cursor's server ran the MCP server's own tests, which is why the `root` argument, the roots lookup and `REVIEW_REQUIRE_ROOT` exist. I don't know whether Cursor declares roots, whether its model passes the right `root`, or whether it replaces `${workspaceFolder}` in config values.
- **`run_checks` is tied to this repo's setup:** it runs `pnpm run build|test|typecheck`. A project that uses npm, yarn or bun, or lacks those scripts, gets failing checks. `typecheck` is a script this repo added. Not built: detecting the package manager from the lockfile, skipping scripts that don't exist, and saying which command ran.
- **Cancel and child processes:** cancel aborts `spawn('pnpm', …, { signal })`, which kills `pnpm` but not necessarily the process it started. The two cancel tests failed once when run through Cursor, but pass here (145 of 145, several runs). Cause not found. Killing the whole process group would be the fix.
- **Security if an admin opts in over HTTP:** `root` is chosen by the client, and there is no authentication yet. Anyone who can reach the port can name any allowed folder and run its scripts through `run_checks`. Set `REVIEW_ALLOWED_ROOTS` and keep the server on localhost until Stages 9 and 10.
- **The resource** `repo://file/…` has no `root` argument, so when allowed over HTTP with no pin and no client roots it lists nothing.
- **Not done:** an npm package for the stdio server (it would remove the clone and build step on each machine), a header such as `X-Review-Root`, MCP sampling, and a remote-friendly design.
