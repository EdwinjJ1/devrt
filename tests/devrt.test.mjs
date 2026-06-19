import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { runCli } from "../dist/index.js";

class MemoryWritable extends Writable {
  chunks = [];

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    callback();
  }

  text() {
    return this.chunks.join("");
  }

  json() {
    return JSON.parse(this.text());
  }
}

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), "devrt-test-"));
}

async function invoke(cwd, args, stdin = "") {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const exitCode = await runCli(args, {
    cwd,
    stdout,
    stderr,
    stdin: Readable.from([stdin])
  });

  return { exitCode, stdout, stderr };
}

test("init creates a devrt workspace without overwriting existing files", async () => {
  const cwd = await tempProject();
  const first = await invoke(cwd, ["init"]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.stdout.json().ok, true);

  const second = await invoke(cwd, ["init"]);
  assert.equal(second.exitCode, 0);
  assert.equal(second.stdout.json().ok, true);
  assert.ok(second.stdout.json().preserved.includes(".devrt/manifest.json"));
});

test("task create preserves original user wording verbatim", async () => {
  const cwd = await tempProject();
  await invoke(cwd, ["init"]);

  const taskText = "增加一个线上会议功能。\n必须保留用户语义，不要编需求。\n";
  const result = await invoke(cwd, ["task", "create", "--from", "-"], taskText);
  assert.equal(result.exitCode, 0);

  const { taskId } = result.stdout.json();
  const taskFile = await readFile(path.join(cwd, ".devrt", "tasks", taskId, "task.md"), "utf8");
  const acceptance = JSON.parse(
    await readFile(path.join(cwd, ".devrt", "tasks", taskId, "acceptance.json"), "utf8")
  );

  assert.equal(taskFile, taskText);
  assert.equal(acceptance.derived, true);
});

test("actions validate rejects incomplete manifest entries", async () => {
  const cwd = await tempProject();
  await invoke(cwd, ["init"]);
  await writeFile(
    path.join(cwd, ".devrt", "manifest.json"),
    JSON.stringify({ version: 1, actions: [{ name: "bad.action" }] }, null, 2)
  );

  const result = await invoke(cwd, ["actions", "validate"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.json().ok, false);
  assert.ok(result.stdout.json().errors.some((message) => message.includes("source is required")));
});

test("run executes registered action, writes trace, and replay reruns it", async () => {
  const cwd = await tempProject();
  await invoke(cwd, ["init"]);
  const task = await invoke(cwd, ["task", "create", "--from", "-"], "Create a user");
  const taskId = task.stdout.json().taskId;

  await mkdir(path.join(cwd, "scripts"));
  await writeFile(
    path.join(cwd, "scripts", "echo-action.mjs"),
    [
      "const input = JSON.parse(process.env.DEVRT_ACTION_INPUT);",
      "console.log(JSON.stringify({ ok: true, result: { email: input.email }, stateChanges: [{ type: 'insert', target: 'user' }], logs: ['created'] }));"
    ].join("\n")
  );
  await writeFile(
    path.join(cwd, ".devrt", "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        actions: [
          {
            name: "user.create",
            description: "Create user",
            source: "scripts/echo-action.mjs",
            sideEffects: ["insert:user"],
            inputSchema: {
              type: "object",
              required: ["email"],
              properties: {
                email: { type: "string" }
              },
              additionalProperties: false
            },
            command: "node scripts/echo-action.mjs"
          }
        ],
        verify: []
      },
      null,
      2
    )
  );

  const result = await invoke(cwd, [
    "run",
    "user.create",
    "--task",
    taskId,
    "--json",
    JSON.stringify({ email: "a@test.com" })
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.json().ok, true);
  assert.equal(result.stdout.json().result.email, "a@test.com");
  assert.ok(result.stdout.json().traceId);

  const replay = await invoke(cwd, ["replay", "last", "--task", taskId]);
  assert.equal(replay.exitCode, 0);
  assert.equal(replay.stdout.json().ok, true);
  assert.equal(replay.stdout.json().replayOf, result.stdout.json().traceId);
});

test("verify reports blocked without checks and verified when configured checks pass", async () => {
  const cwd = await tempProject();
  await invoke(cwd, ["init"]);
  const task = await invoke(cwd, ["task", "create", "--from", "-"], "Verify the project");
  const taskId = task.stdout.json().taskId;

  const blocked = await invoke(cwd, ["verify", "--task", taskId]);
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.stdout.json().status, "blocked");

  await writeFile(
    path.join(cwd, ".devrt", "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        actions: [],
        verify: [{ name: "smoke", command: "node -e \"process.exit(0)\"" }]
      },
      null,
      2
    )
  );

  const verified = await invoke(cwd, ["verify", "--task", taskId]);
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.stdout.json().status, "verified");

  const status = await invoke(cwd, ["status", "--task", taskId]);
  assert.equal(status.exitCode, 0);
  assert.equal(status.stdout.json().status, "verified");
});

test("doctor reports duplicates and checks declared CLI probes without running actions", async () => {
  const cwd = await tempProject();
  await invoke(cwd, ["init"]);
  await mkdir(path.join(cwd, "scripts"));
  await writeFile(path.join(cwd, "scripts", "cli-probe.mjs"), "console.log(JSON.stringify({ ok: true }))\n");
  await writeFile(path.join(cwd, "scripts", "action.mjs"), "console.log(JSON.stringify({ ok: true }))\n");
  await writeFile(
    path.join(cwd, ".devrt", "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        tools: [
          {
            name: "project-cli",
            command: "node scripts/cli-probe.mjs",
            probe: "node scripts/cli-probe.mjs",
            capabilities: ["json-output"]
          }
        ],
        actions: [
          {
            name: "thing.create",
            source: "scripts/action.mjs",
            sideEffects: ["insert:thing"],
            command: "node scripts/action.mjs",
            inputSchema: { type: "object", additionalProperties: false }
          },
          {
            name: "thing.make",
            source: "scripts/action.mjs",
            sideEffects: ["insert:thing"],
            command: "node scripts/action.mjs",
            inputSchema: { type: "object", additionalProperties: false }
          }
        ],
        scenarios: []
      },
      null,
      2
    )
  );

  const result = await invoke(cwd, ["doctor"]);
  assert.equal(result.exitCode, 0);
  const body = result.stdout.json();
  assert.equal(body.ok, true);
  assert.equal(body.toolChecks[0].ok, true);
  assert.ok(body.duplicates.some((duplicate) => duplicate.type === "action_command"));
  assert.ok(body.nextSuggestedWork.some((entry) => entry.includes("scenario")));
});

test("verify can prove a task by running a real action workflow scenario", async () => {
  const cwd = await tempProject();
  await invoke(cwd, ["init"]);
  const task = await invoke(cwd, ["task", "create", "--from", "-"], "Create a workspace and add material");
  const taskId = task.stdout.json().taskId;

  await mkdir(path.join(cwd, "scripts"));
  await writeFile(
    path.join(cwd, "scripts", "workflow.mjs"),
    [
      "const input = JSON.parse(process.env.DEVRT_ACTION_INPUT || '{}');",
      "const action = process.env.DEVRT_ACTION;",
      "if (action === 'workspace.create') {",
      "  console.log(JSON.stringify({ ok: true, result: { workspaceId: 'ws_' + input.title.toLowerCase() }, stateChanges: [{ type: 'insert', target: 'workspace' }] }));",
      "} else if (action === 'material.add') {",
      "  console.log(JSON.stringify({ ok: true, result: { materialId: 'mat_1', workspaceId: input.workspaceId, content: input.content }, stateChanges: [{ type: 'insert', target: 'material' }] }));",
      "} else {",
      "  console.log(JSON.stringify({ ok: false, error: { type: 'UnknownAction', message: action } }));",
      "}"
    ].join("\n")
  );
  await writeFile(
    path.join(cwd, ".devrt", "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        actions: [
          {
            name: "workspace.create",
            source: "scripts/workflow.mjs#workspace.create",
            sideEffects: ["insert:workspace"],
            command: "node scripts/workflow.mjs",
            inputSchema: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } },
              additionalProperties: false
            }
          },
          {
            name: "material.add",
            source: "scripts/workflow.mjs#material.add",
            sideEffects: ["insert:material"],
            command: "node scripts/workflow.mjs",
            inputSchema: {
              type: "object",
              required: ["workspaceId", "content"],
              properties: {
                workspaceId: { type: "string" },
                content: { type: "string" }
              },
              additionalProperties: false
            }
          }
        ],
        scenarios: [
          {
            name: "workspace-material-flow",
            description: "Create workspace, pass the id forward, and add material.",
            steps: [
              {
                name: "create",
                action: "workspace.create",
                input: { title: "Demo" },
                expect: [{ path: "result.workspaceId", exists: true }]
              },
              {
                name: "add",
                action: "material.add",
                input: { workspaceId: "${create.result.workspaceId}", content: "source text" },
                expect: [
                  { path: "result.materialId", exists: true },
                  { path: "result.content", equals: "source text" }
                ]
              }
            ]
          }
        ],
        verify: []
      },
      null,
      2
    )
  );

  const result = await invoke(cwd, ["verify", "--task", taskId]);
  assert.equal(result.exitCode, 0);
  const body = result.stdout.json();
  assert.equal(body.status, "verified");
  assert.equal(body.scenarios[0].ok, true);
  assert.equal(body.scenarios[0].steps[1].input.workspaceId, "ws_demo");

  const single = await invoke(cwd, ["verify", "scenario", "workspace-material-flow", "--task", taskId]);
  assert.equal(single.exitCode, 0);
  assert.equal(single.stdout.json().scenario.ok, true);
});
