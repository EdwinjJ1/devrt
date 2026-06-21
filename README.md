# devrt

`devrt` is an agent-native runtime for project CLIs and real workflow verification.

It is not meant to replace a product's own CLI. A serious project can expose its own stable commands, API wrappers, or workflow shortcuts; `devrt` gives Claude Code, Codex, and other coding agents a structured layer for:

- preserving the user's original task
- listing and validating registered actions
- checking whether the existing project CLI/tool surface is usable
- running real workflow scenarios instead of one-off scripts
- recording traces and replaying recent runs
- deciding whether a task is still `needs_action`, `needs_fix`, `blocked`, or `verified`

## Core Commands

```bash
devrt init
devrt init --agent
devrt agent install
devrt agent instructions
devrt task create --from <file|->
devrt task show <taskId>
devrt doctor
devrt actions list
devrt actions validate
devrt scenarios list
devrt run <action> --task <taskId> --json '{...}'
devrt verify --task <taskId>
devrt verify scenario <name> --task <taskId>
devrt status --task <taskId>
devrt replay last --task <taskId>
```

## Agent Entry

For the lowest-friction setup in another project, run:

```bash
devrt init --agent
```

This creates the normal `.devrt/` workspace and installs project-level agent entrypoints:

- `.devrt/instructions.md`
- `AGENTS.md`
- `CLAUDE.md`

Existing `AGENTS.md` and `CLAUDE.md` content is preserved. devrt only inserts or updates its own managed block, so project-specific rules can live alongside it.

If `.devrt/` already exists, refresh the agent entrypoints with:

```bash
devrt agent install
```

Agents should then treat `.devrt/instructions.md` as the local operating guide: preserve the user's original task, run `devrt doctor`, reuse existing project CLI/API/script capabilities, maintain actions/scenarios for changed workflows, and verify with `devrt verify --task <taskId>` before stopping.

## Manifest Shape

`.devrt/manifest.json` stays intentionally flexible. Avoid hard-coded categories when the project has its own language; use free-form `tags` and `capabilities` only when they help the agent understand the command.

```json
{
  "version": 1,
  "tools": [
    {
      "name": "project-cli",
      "command": "node cli/dist/index.js",
      "probe": "node cli/dist/index.js --help",
      "capabilities": ["json-output", "job-wait"]
    }
  ],
  "actions": [
    {
      "name": "workspace.create",
      "source": "cli/src/workspace.ts#create",
      "sideEffects": ["insert:workspace"],
      "command": "node .devrt/scripts/workspace-create.mjs",
      "inputSchema": {
        "type": "object",
        "required": ["title"],
        "properties": {
          "title": { "type": "string" }
        },
        "additionalProperties": false
      }
    }
  ],
  "scenarios": [
    {
      "name": "workspace-flow",
      "steps": [
        {
          "name": "create",
          "action": "workspace.create",
          "input": { "title": "Demo" },
          "expect": [{ "path": "result.id", "exists": true }]
        }
      ]
    }
  ],
  "verify": []
}
```

## Verification Principle

Generic checks like typecheck can still live in `verify`, but they are not the main proof.

For agentic development, the stronger signal is a scenario that exercises the real product workflow: create the resource, pass ids forward, trigger the job, wait for completion, read the result, assert the outcome, and clean up if needed.
