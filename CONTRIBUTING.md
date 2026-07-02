# Contributing to devrt

Thanks for your interest! devrt is intentionally small — the whole runtime is two files with zero runtime dependencies — and we'd like to keep it that way.

## Getting started

```bash
git clone https://github.com/EdwinjJ1/devrt.git
cd devrt
npm install
npm test          # builds and runs the node --test suite
```

Requirements: Node.js >= 20.

## Project layout

```
src/index.ts        # the entire runtime: commands, manifest, scenarios, traces
src/cli.ts          # thin bin entrypoint
tests/*.test.mjs    # black-box tests that drive the CLI end-to-end
```

## Ground rules

- **Zero runtime dependencies.** New features must work with Node.js built-ins only. devDependencies (TypeScript, types) are fine.
- **Every command speaks JSON.** Output must be machine-consumable; agents are the primary users.
- **Deterministic over generative.** Validation, schema checks, and manifest rules must be deterministic. No "the LLM will figure it out".
- **Tests are end-to-end.** Add a test in `tests/` that drives the real CLI against a temp workspace, like the existing ones.
- **Immutability of tasks.** Nothing may rewrite `task.md` after `task create`. This is a core guarantee.

## Making changes

1. Fork and create a feature branch.
2. Write or update tests first, then implement.
3. `npm test` must pass.
4. Keep PRs focused; one logical change per PR.

## Commit messages

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Proposing bigger features

Open an issue first for anything on (or off) the roadmap — `devrt scan`, MCP adapter, new manifest fields — so we can agree on the shape before you invest time.

## Reporting bugs

Please include:

- your OS and Node.js version
- the exact command you ran
- the JSON output (devrt errors are structured — paste them whole)
- if relevant, your `.devrt/manifest.json`
