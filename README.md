<div align="center">

# devrt

**The agent-native runtime for your project.**

Give Claude Code, Codex, and Cursor a way to run real workflows and *prove* their changes work — instead of guessing from code and poking at UIs.

[![CI](https://github.com/EdwinjJ1/devrt/actions/workflows/ci.yml/badge.svg)](https://github.com/EdwinjJ1/devrt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

English | [简体中文](./README.zh-CN.md)

</div>

---

## Why devrt?

AI coding agents are great at *writing* code and terrible at *proving it works*:

- They finish a change, run `tsc`, and declare victory — while the actual feature is broken.
- Simulating human clicks through Playwright is slow, flaky, and alien to how LLMs think.
- Every session, the agent re-invents throwaway verification scripts that rot immediately.
- The original task gets paraphrased, mutated, and quietly lost along the way.

Agents are good at **calling tools, reading schemas, and reasoning over structured JSON**. So give them exactly that:

```text
Claude Code / Codex / Cursor
        │  shell command
        ▼
   devrt CLI / runtime          ← this project
        │  executes real project actions
        ▼
your code / APIs / DB / logs
        │  structured JSON result
        ▼
Claude Code / Codex / Cursor    ← knows what happened, what changed, what to run next
```

`devrt` is a small, dependency-free execution layer that lives inside your repo:

- 📌 **Tasks** — the user's original request is preserved verbatim; agents can't rewrite the goal.
- ⚡ **Actions** — real project workflows (create a user, trigger a job, …) registered once in a manifest, callable with validated JSON input.
- 🎬 **Scenarios** — multi-step workflows with assertions: create → pass ids forward → assert the outcome → clean up.
- ✅ **Verify** — one command that answers the only question that matters: *is this task actually done?* (`verified` / `needs_fix` / `blocked`)
- 🔁 **Traces & replay** — every run is recorded as JSON and can be replayed to reproduce an issue.

It is **not** another coding agent, not a test framework, not a Playwright replacement, and not an MCP server. It's the missing layer between the agent and your project: a *project manual + executable remote control + receipt system*.

## Install

**One-liner** (requires Node.js ≥ 20):

```bash
curl -fsSL https://raw.githubusercontent.com/EdwinjJ1/devrt/main/install.sh | bash
```

**Or with npm directly:**

```bash
npm install -g github:EdwinjJ1/devrt
```

**Or try without installing:**

```bash
npx github:EdwinjJ1/devrt help
```

## Quick start (60 seconds)

**1. Set up your project for agents** — one command:

```bash
cd your-project
devrt init --agent
```

This creates the `.devrt/` workspace and installs agent entrypoints (`AGENTS.md`, `CLAUDE.md`, `.devrt/instructions.md`). Existing files are preserved — devrt only manages its own marked block, so your project rules stay intact. From now on, any coding agent that opens your repo knows how to operate.

**2. Capture the task** — the user's words, verbatim, immutable:

```bash
echo "Fix: creating a todo via the API should return its id" > task.md
devrt task create --from task.md
```

```json
{
  "ok": true,
  "taskId": "2026-07-02-fix-creating-a-todo-via-the-api-7780b7a6",
  "taskFile": ".devrt/tasks/2026-07-02-fix-creating-a-todo-via-the-api-7780b7a6/task.md",
  "sha256": "7780b7a6…",
  "nextSuggestedCommands": ["devrt status --task …", "devrt actions list"]
}
```

**3. Register a real action** in `.devrt/manifest.json` (wrap your existing service/CLI — don't duplicate logic):

```json
{
  "version": 1,
  "actions": [
    {
      "name": "todo.create",
      "source": "src/server/todo.ts#create",
      "sideEffects": ["insert:todo"],
      "command": "node scripts/todo-create.mjs",
      "inputSchema": {
        "type": "object",
        "required": ["title"],
        "properties": { "title": { "type": "string" } },
        "additionalProperties": false
      }
    }
  ],
  "scenarios": [
    {
      "name": "todo-flow",
      "steps": [
        {
          "name": "create",
          "action": "todo.create",
          "input": { "title": "Ship devrt" },
          "expect": [
            { "path": "result.id", "exists": true },
            { "path": "result.done", "equals": false }
          ]
        }
      ]
    }
  ]
}
```

**4. Run and verify** — structured results, not vibes:

```bash
devrt run todo.create --task <taskId> --json '{"title":"Ship devrt"}'
devrt verify --task <taskId>
```

```json
{
  "ok": true,
  "status": "verified",
  "taskId": "2026-07-02-fix-creating-a-todo-via-the-api-7780b7a6",
  "scenarios": [
    {
      "ok": true,
      "name": "todo-flow",
      "steps": [
        {
          "name": "create",
          "ok": true,
          "assertions": [
            { "ok": true, "path": "result.id", "actual": "todo_ii0523" },
            { "ok": true, "path": "result.done", "actual": false }
          ]
        }
      ]
    }
  ],
  "traceFile": ".devrt/traces/2026-07-02T03-47-51-245Z-89a422bf.json"
}
```

When it fails, the agent gets back *which step*, *which assertion*, *actual vs expected*, plus the full trace — enough to keep fixing without a human in the loop.

## Commands

Every command prints JSON, so agents (and scripts) can consume the output directly.

| Command | What it does |
|---|---|
| `devrt init` | Create the `.devrt/` workspace (manifest, tasks, traces) |
| `devrt init --agent` | Same, plus agent entrypoints: `AGENTS.md`, `CLAUDE.md`, `.devrt/instructions.md` |
| `devrt agent install` | (Re)install / refresh the agent entrypoints |
| `devrt agent instructions` | Print the agent operating guide as markdown |
| `devrt task create --from <file\|->` | Store the user's task verbatim, get a stable task id |
| `devrt task show <taskId>` | Show a task and its acceptance criteria |
| `devrt doctor [--no-probes]` | Health check: manifest validity, duplicate actions, tool probes, what to build next |
| `devrt actions list` / `validate` | List / validate registered actions |
| `devrt scenarios list` | List registered workflow scenarios |
| `devrt run <action> --task <id> --json '{…}'` | Execute an action with schema-validated input; record a trace |
| `devrt verify --task <id>` | Run all scenarios (or verify checks) and settle the task status |
| `devrt verify scenario <name> --task <id>` | Verify one scenario |
| `devrt status --task <id>` | Current task state: `needs_action` / `needs_fix` / `blocked` / `verified` |
| `devrt replay last [--task <id>]` | Re-run the most recent action/verification from its trace |

## How agents use it

After `devrt init --agent`, the installed instructions tell any coding agent to:

1. **Preserve the task** — `devrt task create --from -` before touching code.
2. **Check the ground** — `devrt doctor` to see which tools/actions/scenarios exist and are usable.
3. **Reuse, don't reinvent** — call registered actions instead of writing one-off scripts; register new actions when workflows change.
4. **Prove it** — `devrt verify --task <id>` must pass before the agent is allowed to say "done".

`devrt doctor` also tells the agent what's *missing* — e.g. "actions exist but no scenario proves the real workflow" — so the verification layer grows with the project.

## Design principles

- **Real workflows over generic checks.** `tsc` passing is not proof. The strong signal is a scenario that exercises the actual product flow: create the resource, pass ids forward, assert the outcome, clean up.
- **One source of truth.** Actions wrap your existing service layer / CLI / API. If the UI calls one code path and the agent calls another, verification is a lie.
- **Deterministic over generative.** Agents may *help write* the manifest, but the runtime validates everything deterministically: schemas, command targets, duplicate names, scenario references. Registered actions only — no guessed commands.
- **Everything is a receipt.** Every run and every verification writes a JSON trace. `replay last` reproduces it.
- **Zero dependencies.** Pure Node.js ≥ 20. Nothing to audit but this repo.

## Comparison

| | devrt | Playwright / Cypress | One-off scripts | Fixed MCP tools |
|---|---|---|---|---|
| Built for LLM tool-calling | ✅ JSON in/out, schemas | ❌ selectors, waits | ⚠️ ad-hoc | ✅ |
| Verifies real business flow | ✅ | ⚠️ via UI, flaky | ⚠️ unreviewed | ⚠️ |
| Evolves with your code | ✅ manifest in git diff | ⚠️ | ❌ rot instantly | ❌ fixed surface |
| Replay / audit trail | ✅ traces | ⚠️ | ❌ | ❌ |
| Keeps original task intact | ✅ verbatim + sha256 | ❌ | ❌ | ❌ |

They're complements, not rivals: devrt covers business/state/flow verification; keep a thin Playwright smoke layer for real-UI concerns (layout, modals, hover).

## Roadmap

- [ ] `devrt scan` — generate manifest drafts from Next.js routes, Zod schemas, TS types
- [ ] MCP adapter (`devrt mcp start`) for agents that prefer MCP over shell
- [ ] `devrt logs tail` — structured log access for agents
- [ ] npm package (`npm i -g devrt`)
- [ ] Adapters: Express, Prisma state inspection

Issues and PRs are very welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Contributing

```bash
git clone https://github.com/EdwinjJ1/devrt.git
cd devrt
npm install
npm test        # build + node --test
```

The whole runtime is two files (`src/index.ts`, `src/cli.ts`) with zero runtime dependencies. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions.

## License

[MIT](./LICENSE) © 2026 [Edwin](https://github.com/EdwinjJ1)

---

<div align="center">

*Every project will eventually need more than a human UI and an API — it will need an agent interface. devrt is that layer.*

**If devrt saved your agent (or you) a debugging session, consider giving it a ⭐**

</div>
