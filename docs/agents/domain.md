# Domain docs

Use the repository's domain documentation when you explore or change code.

## Read before exploring

- Read root `CONTEXT.md` when it exists.
- Read root `CONTEXT-MAP.md` when it exists, then read each context relevant to the task.
- Read the ADRs in `docs/adr/` that affect the area you change.

If these files do not exist, continue without comment. Create domain documentation only when a task resolves domain terminology or an architectural decision.

## Layout

This repository uses the single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

Use terminology defined in `CONTEXT.md`. If an intended change conflicts with an ADR, state the conflict explicitly.
