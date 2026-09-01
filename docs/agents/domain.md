# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area about to be changed.

If either location does not exist, proceed silently. The `/domain-modeling` skill creates or updates domain documentation when terms or decisions are resolved.

## File structure

Mnemark uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
├── src/
└── src-tauri/
```

## Use the glossary's vocabulary

When output names a domain concept—such as in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`.

If a required concept is absent, reconsider whether the term belongs to the project or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
