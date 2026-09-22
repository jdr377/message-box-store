---
name: beads
description: Use when working in this repository with bd or Beads for durable task tracking, issue dependencies, blocker management, multi-session handoff, or shared work memory.
---

# Beads

Use Beads as the shared project task system. Local plans and scratch files are useful, but they are not the durable source of truth for project work.

## First Step

Run these commands from the repository root:

```bash
bd prime
```

If that prints nothing, confirm the repository-local workspace:

```bash
bd where
```

The expected tracker is this repository's `.beads` directory. Do not read another repository's Beads skill, task database, agent memory, or planning files.

## Preferred Route

Use the `bd` CLI when shell access is available. It is the most compact and direct Beads interface.

## Core CLI Workflow

1. Find work:

```bash
bd ready
bd list --status=open
bd list --status=in_progress
```

2. Inspect before editing:

```bash
bd show <id>
```

3. Claim work atomically:

```bash
bd update <id> --claim
```

4. Create durable follow-up work when implementation reveals new tasks:

```bash
bd create "Short title" --description="Why this exists and what needs to be done" --type=task --priority=2
```

5. Close completed work:

```bash
bd close <id> --reason="Completed with evidence"
```

## What Belongs In Beads

Use Beads for:

- shared project tasks;
- blockers and dependencies;
- discovered follow-up work;
- work that must survive thread reset, compaction, or handoff;
- status that another person or agent must be able to resume.

Use agent-local planning only for the current turn's execution checklist. Do not treat it as shared project state.

## Repository Independence

- Keep task tracking, evidence, plans, and agent instructions inside this repository.
- Do not access another consumer repository unless the current task explicitly requires a named upstream comparison.
- Do not add runtime, build, or test dependencies on another local repository.
- Use portable upstream links or pinned package contracts for external evidence.

## Rules

- Do not create Markdown TODO files as the source of truth when Beads is available.
- Do not use `bd edit`; it opens an interactive editor. Use `bd update` flags instead.
- Prefer `--json` when parsing `bd` output programmatically.
- Run `bd prime` manually when context is missing or stale.
- Do not close or mutate tasks unless the work is actually complete.
- Do not commit, push, publish, deploy, or synchronize remotes unless the user explicitly authorizes it.
