# Planning phases and stages

Read this when writing or changing the roadmap, or planning a new stage. The goal is a plan a reader can follow in a minute: what we are building, how to tell it works, and what comes in which order.

## Hierarchy

| Level | What it is | Size |
|---|---|---|
| **Phase** | A goal you can demonstrate | 3–6 stages |
| **Stage** | One git branch with a branch doc | 3–6 steps |
| **Step** | One commit, or one small PR | a sitting or two |

Numbering: stages keep one global number (Stage 9). Steps are `stage.step` (9.1, 9.2). Phases are numbered 1, 2, 3. Branch numbers are a separate global counter (`NN-…`), and a planning branch takes a number too.

## Every phase has the same five parts

1. **Goal** — one sentence.
2. **You can do this when it's done** — something a person can try, not a feature list.
3. **Stages** — a table: stage, branch, what you learn, numbered steps.
4. **Done when** — a check that can be run.
5. **Out of scope** — what is deliberately left for later.

## Every stage plan (`docs/plans/stage-N-<name>.md`) has

Goal · decisions made (and the ones still open) · steps, each with *what changes*, *files touched* and *done when* · behaviour table or other proof · risks · out of scope. Plan only the next stage in detail; later stages stay a row in the phase table until they are next.

## Rules

- Say what is unverified (a spec detail, a library behaviour) in the plan instead of asserting it. Step 1 of a stage may be "read the spec".
- A plan is not a promise. Update it when reality changes, and keep the README and the published artifact in sync.
- When a stage starts, its plan file stays, and the branch doc (`docs/branches/NN-…`) records what actually happened.
