import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type CliIO = {
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
};

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type Manifest = {
  version?: number;
  tools?: ToolDefinition[];
  actions?: ActionDefinition[];
  verify?: VerifyDefinition[];
  scenarios?: ScenarioDefinition[];
};

type ActionDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  source: string;
  sideEffects: string[];
  command: string;
  cwd?: string;
  timeoutMs?: number;
  tags?: string[];
  capabilities?: string[];
  probe?: string;
};

type VerifyDefinition = {
  name: string;
  description?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

type ToolDefinition = {
  name: string;
  description?: string;
  command: string;
  probe?: string;
  cwd?: string;
  timeoutMs?: number;
  tags?: string[];
  capabilities?: string[];
};

type ScenarioDefinition = {
  name: string;
  description?: string;
  steps: ScenarioStepDefinition[];
  cleanup?: ScenarioStepDefinition[];
};

type ScenarioStepDefinition = {
  name?: string;
  action: string;
  input?: JsonValue;
  expect?: AssertionDefinition[];
};

type AssertionDefinition = {
  path: string;
  exists?: boolean;
  equals?: JsonValue;
  contains?: string;
  min?: number;
  max?: number;
  length?: number;
  lengthMin?: number;
  matches?: string;
};

type JsonSchema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean;
  enum?: JsonValue[];
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

type TraceRecord = JsonObject & {
  traceId: string;
  type: "action" | "verify";
  taskId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
};

const DEVRT_DIR = ".devrt";
const TASKS_DIR = "tasks";
const TRACES_DIR = "traces";
const DEFAULT_TIMEOUT_MS = 120_000;
const AGENT_BLOCK_START = "<!-- devrt:agent-instructions:start -->";
const AGENT_BLOCK_END = "<!-- devrt:agent-instructions:end -->";

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const ctx = {
    cwd: io.cwd ?? process.cwd(),
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env
  };

  try {
    const parsed = parseArgs(args);
    const [command, subcommand, ...rest] = parsed.positionals;

    if (!command || command === "help" || parsed.flags.has("help")) {
      writeJson(ctx.stdout, helpResult());
      return 0;
    }

    if (command === "init") {
      writeJson(ctx.stdout, await initWorkspace(ctx.cwd, parsed));
      return 0;
    }

    if (command === "agent") {
      if (subcommand === "install") {
        writeJson(ctx.stdout, await installAgentFiles(ctx.cwd));
        return 0;
      }
      if (subcommand === "instructions") {
        writeJson(ctx.stdout, {
          ok: true,
          format: "markdown",
          content: defaultInstructions()
        });
        return 0;
      }
      throw usageError("Expected `devrt agent install` or `devrt agent instructions`.");
    }

    if (command === "task") {
      if (subcommand === "create") {
        writeJson(ctx.stdout, await createTask(ctx.cwd, parsed, ctx.stdin));
        return 0;
      }
      if (subcommand === "show") {
        writeJson(ctx.stdout, await showTask(ctx.cwd, rest[0]));
        return 0;
      }
      throw usageError("Expected `devrt task create` or `devrt task show <taskId>`.");
    }

    if (command === "actions") {
      if (subcommand === "list") {
        writeJson(ctx.stdout, await listActions(ctx.cwd));
        return 0;
      }
      if (subcommand === "validate") {
        const result = await validateActions(ctx.cwd);
        writeJson(ctx.stdout, result);
        return result.ok ? 0 : 1;
      }
      throw usageError("Expected `devrt actions list` or `devrt actions validate`.");
    }

    if (command === "scenarios") {
      if (subcommand === "list") {
        writeJson(ctx.stdout, await listScenarios(ctx.cwd));
        return 0;
      }
      throw usageError("Expected `devrt scenarios list`.");
    }

    if (command === "doctor") {
      const result = await doctorWorkspace(ctx.cwd, parsed, ctx.env);
      writeJson(ctx.stdout, result);
      return result.ok ? 0 : 1;
    }

    if (command === "run") {
      writeJson(ctx.stdout, await runAction(ctx.cwd, parsed, ctx.env));
      return 0;
    }

    if (command === "verify") {
      if (subcommand === "scenario") {
        const scenarioName = rest[0];
        if (!scenarioName) {
          throw usageError("Missing scenario name: devrt verify scenario <name> --task <taskId>");
        }
        const result = await verifyScenarioByName(ctx.cwd, scenarioName, parsed, ctx.env);
        writeJson(ctx.stdout, result);
        return result.ok ? 0 : 1;
      }
      const result = await verifyTask(ctx.cwd, parsed, ctx.env);
      writeJson(ctx.stdout, result);
      return result.ok ? 0 : 1;
    }

    if (command === "status") {
      writeJson(ctx.stdout, await getTaskStatus(ctx.cwd, parsed));
      return 0;
    }

    if (command === "replay") {
      if (subcommand !== "last") {
        throw usageError("Expected `devrt replay last`.");
      }
      const result = await replayLast(ctx.cwd, parsed, ctx.env);
      writeJson(ctx.stdout, result);
      return result.ok ? 0 : 1;
    }

    throw usageError(`Unknown command: ${command}`);
  } catch (error) {
    writeJson(ctx.stderr, errorResult(error));
    return 1;
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const equalIndex = raw.indexOf("=");
      if (equalIndex >= 0) {
        flags.set(raw.slice(0, equalIndex), raw.slice(equalIndex + 1));
        continue;
      }

      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        flags.set(raw, next);
        index += 1;
      } else {
        flags.set(raw, true);
      }
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags };
}

async function initWorkspace(cwd: string, parsed: ParsedArgs = { positionals: [], flags: new Map() }): Promise<JsonObject> {
  const devrtPath = path.join(cwd, DEVRT_DIR);
  const created: string[] = [];
  const preserved: string[] = [];

  for (const relativePath of [
    "",
    TASKS_DIR,
    TRACES_DIR,
    "actions",
    "policies",
    "adapters"
  ]) {
    const absolutePath = path.join(devrtPath, relativePath);
    if (existsSync(absolutePath)) {
      preserved.push(displayPath(cwd, absolutePath));
    } else {
      await mkdir(absolutePath, { recursive: true });
      created.push(displayPath(cwd, absolutePath));
    }
  }

  await writeIfMissing(
    path.join(devrtPath, "devrt.json"),
    JSON.stringify({ version: 1, runtime: "devrt", createdBy: "devrt init" }, null, 2) + "\n",
    cwd,
    created,
    preserved
  );

  await writeIfMissing(
    path.join(devrtPath, "manifest.json"),
    JSON.stringify({ version: 1, tools: [], actions: [], scenarios: [], verify: [] }, null, 2) + "\n",
    cwd,
    created,
    preserved
  );

  await writeIfMissing(path.join(devrtPath, "instructions.md"), defaultInstructions(), cwd, created, preserved);

  const agentInstall = parsed.flags.has("agent") ? await installAgentFiles(cwd) : undefined;

  return {
    ok: true,
    workspace: displayPath(cwd, devrtPath),
    created,
    preserved,
    agentInstall: agentInstall ?? null,
    nextSuggestedCommands: parsed.flags.has("agent")
      ? ["devrt task create --from <file>", "devrt doctor", "devrt verify --task <taskId>"]
      : ["devrt task create --from <file>", "devrt actions validate", "devrt agent install"]
  };
}

async function installAgentFiles(cwd: string): Promise<JsonObject> {
  if (!existsSync(path.join(cwd, DEVRT_DIR))) {
    await initWorkspace(cwd);
  }

  const installed: string[] = [];
  const updated: string[] = [];
  const devrtInstructions = path.join(cwd, DEVRT_DIR, "instructions.md");
  await writeFile(devrtInstructions, defaultInstructions(), "utf8");
  updated.push(displayPath(cwd, devrtInstructions));

  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(cwd, fileName);
    const action = await upsertManagedBlock(filePath, projectAgentBlock(fileName));
    if (action === "created") {
      installed.push(displayPath(cwd, filePath));
    } else {
      updated.push(displayPath(cwd, filePath));
    }
  }

  return {
    ok: true,
    installed,
    updated,
    entrypoints: [
      ".devrt/instructions.md",
      "AGENTS.md",
      "CLAUDE.md"
    ],
    nextSuggestedCommands: ["devrt doctor", "devrt task create --from <file>", "devrt verify --task <taskId>"]
  };
}

async function upsertManagedBlock(filePath: string, blockContent: string): Promise<"created" | "updated"> {
  const block = `${AGENT_BLOCK_START}\n${blockContent.trim()}\n${AGENT_BLOCK_END}\n`;
  if (!existsSync(filePath)) {
    await writeFile(filePath, `${block}\n`, "utf8");
    return "created";
  }

  const existing = await readFile(filePath, "utf8");
  const start = existing.indexOf(AGENT_BLOCK_START);
  const end = existing.indexOf(AGENT_BLOCK_END);
  if (start >= 0 && end >= start) {
    const afterEnd = end + AGENT_BLOCK_END.length;
    const next = `${existing.slice(0, start)}${block}${existing.slice(afterEnd).replace(/^\n?/, "")}`;
    await writeFile(filePath, next, "utf8");
    return "updated";
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(filePath, `${existing}${separator}${block}\n`, "utf8");
  return "updated";
}

async function writeIfMissing(
  filePath: string,
  content: string,
  cwd: string,
  created: string[],
  preserved: string[]
): Promise<void> {
  if (existsSync(filePath)) {
    preserved.push(displayPath(cwd, filePath));
    return;
  }

  await writeFile(filePath, content, "utf8");
  created.push(displayPath(cwd, filePath));
}

async function createTask(cwd: string, parsed: ParsedArgs, stdin: Readable): Promise<JsonObject> {
  await ensureWorkspace(cwd);
  const source = getStringFlag(parsed, "from");
  if (!source) {
    throw usageError("Missing required flag: --from <file|->");
  }

  const rawTask = source === "-" ? await readAll(stdin) : await readFile(path.resolve(cwd, source), "utf8");
  if (rawTask.trim().length === 0) {
    throw usageError("Task content is empty.");
  }

  const providedId = getStringFlag(parsed, "id");
  const taskId = providedId ? validateId(providedId) : createTaskId(rawTask);
  const taskDir = path.join(cwd, DEVRT_DIR, TASKS_DIR, taskId);
  if (existsSync(taskDir)) {
    throw usageError(`Task already exists: ${taskId}`);
  }

  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.md"), rawTask, "utf8");
  await writeFile(
    path.join(taskDir, "acceptance.json"),
    JSON.stringify(
      {
        version: 1,
        taskId,
        derived: true,
        source: "task.md",
        criteria: [],
        notes: [
          "devrt v1 preserves the user's original task verbatim in task.md.",
          "Coding agents may add derived acceptance criteria here, but must not edit task.md."
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return {
    ok: true,
    taskId,
    taskFile: displayPath(cwd, path.join(taskDir, "task.md")),
    acceptanceFile: displayPath(cwd, path.join(taskDir, "acceptance.json")),
    sha256: hash(rawTask),
    nextSuggestedCommands: [`devrt status --task ${taskId}`, "devrt actions list"]
  };
}

async function showTask(cwd: string, taskId: string | undefined): Promise<JsonObject> {
  const id = requireTaskId(taskId);
  const taskDir = getTaskDir(cwd, id);
  await assertDirectory(taskDir, `Task not found: ${id}`);
  const task = await readFile(path.join(taskDir, "task.md"), "utf8");
  const acceptance = await readJsonFile<JsonObject>(path.join(taskDir, "acceptance.json"));

  return {
    ok: true,
    taskId: id,
    task,
    acceptance
  };
}

async function listActions(cwd: string): Promise<JsonObject> {
  const manifest = await loadManifest(cwd);
  const actions = (manifest.actions ?? []).map((action) => ({
    name: action.name,
    description: action.description ?? "",
    source: action.source,
    sideEffects: action.sideEffects,
    tags: action.tags ?? [],
    capabilities: action.capabilities ?? [],
    hasProbe: typeof action.probe === "string"
  }));

  return {
    ok: true,
    count: actions.length,
    actions
  };
}

async function listScenarios(cwd: string): Promise<JsonObject> {
  const manifest = await loadManifest(cwd);
  const scenarios = (manifest.scenarios ?? []).map((scenario) => ({
    name: scenario.name,
    description: scenario.description ?? "",
    steps: Array.isArray(scenario.steps) ? scenario.steps.length : 0,
    cleanup: Array.isArray(scenario.cleanup) ? scenario.cleanup.length : 0
  }));

  return {
    ok: true,
    count: scenarios.length,
    scenarios
  };
}

async function validateActions(cwd: string): Promise<JsonObject & { ok: boolean }> {
  const { errors, warnings } = await validateManifest(cwd);

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

async function doctorWorkspace(cwd: string, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<JsonObject & { ok: boolean }> {
  await ensureWorkspace(cwd);
  const manifest = await loadManifest(cwd);
  const validation = await validateManifest(cwd);
  const duplicates = findManifestDuplicates(manifest);
  const runProbes = !parsed.flags.has("no-probes");
  const toolChecks = await checkTools(cwd, manifest, env, runProbes);
  const actionChecks = checkActionCommands(cwd, manifest);
  const scenarioChecks = checkScenarios(manifest);
  const issues: JsonObject[] = [];

  for (const error of validation.errors) {
    issues.push({ severity: "error", type: "manifest", message: error });
  }
  for (const duplicate of duplicates) {
    issues.push({ severity: "warning", type: "duplicate", ...duplicate });
  }
  for (const tool of toolChecks) {
    if (tool.ok === false) {
      issues.push({ severity: "warning", type: "tool_unusable", message: `${tool.name} probe failed`, tool: tool.name });
    }
  }
  for (const action of actionChecks) {
    if (action.ok === false) {
      issues.push({ severity: "warning", type: "action_command_unusable", message: `${action.name} command target is not available`, action: action.name });
    }
  }
  for (const scenario of scenarioChecks) {
    if (scenario.ok === false) {
      issues.push({ severity: "error", type: "scenario", message: `${scenario.name}: ${scenario.message}`, scenario: scenario.name });
    }
  }

  const actionCount = manifest.actions?.length ?? 0;
  const scenarioCount = manifest.scenarios?.length ?? 0;
  const toolCount = manifest.tools?.length ?? 0;
  const nextSuggestedWork: string[] = [];
  if (toolCount === 0 && actionCount === 0) {
    nextSuggestedWork.push("Find the project's existing CLI/API workflow first; register it as tools/actions instead of writing one-off scripts.");
  }
  if (actionCount > 0 && scenarioCount === 0) {
    nextSuggestedWork.push("Add at least one scenario that walks the real workflow needed to prove a task is fixed.");
  }
  if (actionChecks.some((action) => action.hasSchema === false)) {
    nextSuggestedWork.push("Add inputSchema to actions that agents will call with JSON payloads.");
  }
  if (duplicates.length > 0) {
    nextSuggestedWork.push("Consolidate duplicated actions or commands before adding new wrappers.");
  }

  const hasErrors = issues.some((issue) => issue.severity === "error");
  const hasFailedProbe = toolChecks.some((tool) => tool.ok === false);

  return {
    ok: !hasErrors && !hasFailedProbe,
    status: hasErrors ? "needs_fix" : actionCount === 0 && toolCount === 0 ? "needs_capabilities" : "ready",
    summary: {
      tools: toolCount,
      actions: actionCount,
      scenarios: scenarioCount,
      verifyCommands: manifest.verify?.length ?? 0
    },
    validation,
    duplicates,
    toolChecks,
    actionChecks,
    scenarioChecks,
    issues,
    nextSuggestedWork,
    runProbes
  };
}

async function runAction(cwd: string, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<JsonObject & { ok: boolean }> {
  await ensureWorkspace(cwd);
  const actionName = parsed.positionals[1];
  if (!actionName) {
    throw usageError("Missing action name: devrt run <action> --json '{...}'");
  }

  const taskId = getStringFlag(parsed, "task");
  if (taskId) {
    await assertDirectory(getTaskDir(cwd, taskId), `Task not found: ${taskId}`);
  }

  const manifest = await loadManifest(cwd);
  const input = parseJsonPayload(getStringFlag(parsed, "json") ?? "{}");
  return executeAction(cwd, manifest, actionName, input, taskId, env);
}

async function executeAction(
  cwd: string,
  manifest: Manifest,
  actionName: string,
  input: JsonValue,
  taskId: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<JsonObject & { ok: boolean }> {
  const action = (manifest.actions ?? []).find((candidate) => candidate.name === actionName);
  if (!action) {
    throw usageError(`Action is not registered in .devrt/manifest.json: ${actionName}`);
  }

  const validation = validateActionDefinition(cwd, action);
  if (validation.errors.length > 0) {
    throw usageError(`Action manifest entry is invalid: ${validation.errors.join("; ")}`);
  }

  const schemaErrors = validateJsonSchema(input, action.inputSchema, "input");
  if (schemaErrors.length > 0) {
    throw usageError(`Input failed schema validation: ${schemaErrors.join("; ")}`);
  }

  const startedAt = new Date();
  const commandResult = await runShellCommand(cwd, action.command, {
    cwd: action.cwd,
    timeoutMs: action.timeoutMs,
    env: createRuntimeEnv(env, {
      DEVRT_ACTION: action.name,
      DEVRT_ACTION_INPUT: JSON.stringify(input),
      DEVRT_TASK_ID: taskId,
      DEVRT_TASK_FILE: taskId ? path.join(cwd, DEVRT_DIR, TASKS_DIR, taskId, "task.md") : undefined
    }),
    stdin: JSON.stringify(input)
  });
  const finishedAt = new Date();
  const structured = parseCommandJson(commandResult.stdout);
  const ok = commandResult.exitCode === 0 && !commandResult.timedOut && structured.ok !== false;
  const result = buildActionResult(action.name, input, commandResult, structured, ok);
  const tracePayload: TraceRecord = {
    ...result,
    traceId: createTraceId(),
    type: "action",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: commandResult.durationMs,
    ok,
    input,
    command: action.command
  };
  if (taskId) {
    tracePayload.taskId = taskId;
  }
  const trace = await writeTrace(cwd, tracePayload);

  return {
    ...result,
    traceId: trace.traceId,
    traceFile: trace.traceFile
  };
}

async function verifyTask(cwd: string, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<JsonObject & { ok: boolean }> {
  await ensureWorkspace(cwd);
  const taskId = requireTaskFlag(parsed);
  await assertDirectory(getTaskDir(cwd, taskId), `Task not found: ${taskId}`);

  const manifest = await loadManifest(cwd);
  const scenarioName = getStringFlag(parsed, "scenario");
  if (scenarioName) {
    return verifyScenario(cwd, manifest, scenarioName, taskId, env);
  }
  if ((manifest.scenarios ?? []).length > 0) {
    return verifyAllScenarios(cwd, manifest, taskId, env);
  }

  const checks = manifest.verify ?? [];
  const startedAt = new Date();

  if (checks.length === 0) {
    const trace = await writeTrace(cwd, {
      traceId: createTraceId(),
      type: "verify",
      taskId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      ok: false,
      status: "blocked",
      error: {
        type: "NoVerificationConfigured",
        message: "No verify checks are configured in .devrt/manifest.json."
      },
      nextSuggestedChecks: ["Add a verify entry to .devrt/manifest.json"]
    });

    return {
      ok: false,
      status: "blocked",
      error: {
        type: "NoVerificationConfigured",
        message: "No verify checks are configured in .devrt/manifest.json."
      },
      traceId: trace.traceId,
      traceFile: trace.traceFile
    };
  }

  const results: JsonObject[] = [];
  for (const check of checks) {
    const checkValidation = validateVerifyDefinition(check);
    if (checkValidation.length > 0) {
      results.push({
        name: check.name ?? "unknown",
        ok: false,
        error: {
          type: "InvalidVerifyDefinition",
          message: checkValidation.join("; ")
        }
      });
      continue;
    }

    const result = await runShellCommand(cwd, check.command, {
      cwd: check.cwd,
      timeoutMs: check.timeoutMs,
      env: createRuntimeEnv(env, {
        DEVRT_VERIFY: check.name,
        DEVRT_TASK_ID: taskId,
        DEVRT_TASK_FILE: path.join(cwd, DEVRT_DIR, TASKS_DIR, taskId, "task.md")
      })
    });

    results.push({
      name: check.name,
      description: check.description ?? "",
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    });
  }

  const finishedAt = new Date();
  const ok = results.every((result) => result.ok === true);
  const status = ok ? "verified" : "needs_fix";
  const trace = await writeTrace(cwd, {
    traceId: createTraceId(),
    type: "verify",
    taskId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok,
    status,
    checks: results,
    nextSuggestedChecks: ok ? [] : ["Inspect failed verify checks and rerun devrt verify --task <taskId>"]
  });

  return {
    ok,
    status,
    taskId,
    checks: results,
    traceId: trace.traceId,
    traceFile: trace.traceFile,
    nextSuggestedChecks: ok ? [] : [`devrt status --task ${taskId}`]
  };
}

async function verifyScenarioByName(
  cwd: string,
  scenarioName: string,
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv
): Promise<JsonObject & { ok: boolean }> {
  await ensureWorkspace(cwd);
  const taskId = requireTaskFlag(parsed);
  await assertDirectory(getTaskDir(cwd, taskId), `Task not found: ${taskId}`);
  const manifest = await loadManifest(cwd);
  return verifyScenario(cwd, manifest, scenarioName, taskId, env);
}

async function verifyAllScenarios(
  cwd: string,
  manifest: Manifest,
  taskId: string,
  env: NodeJS.ProcessEnv
): Promise<JsonObject & { ok: boolean }> {
  const startedAt = new Date();
  const scenarioResults: JsonObject[] = [];
  for (const scenario of manifest.scenarios ?? []) {
    scenarioResults.push(await runScenario(cwd, manifest, scenario, taskId, env));
  }

  const finishedAt = new Date();
  const ok = scenarioResults.every((result) => result.ok === true);
  const trace = await writeTrace(cwd, {
    traceId: createTraceId(),
    type: "verify",
    taskId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok,
    status: ok ? "verified" : "needs_fix",
    scenarios: scenarioResults,
    nextSuggestedChecks: ok ? [] : ["Inspect failed scenario steps and rerun devrt verify --task <taskId>"]
  });

  return {
    ok,
    status: ok ? "verified" : "needs_fix",
    taskId,
    scenarios: scenarioResults,
    traceId: trace.traceId,
    traceFile: trace.traceFile,
    nextSuggestedChecks: ok ? [] : [`devrt status --task ${taskId}`]
  };
}

async function verifyScenario(
  cwd: string,
  manifest: Manifest,
  scenarioName: string,
  taskId: string,
  env: NodeJS.ProcessEnv
): Promise<JsonObject & { ok: boolean }> {
  const scenario = (manifest.scenarios ?? []).find((candidate) => candidate.name === scenarioName);
  if (!scenario) {
    throw usageError(`Scenario is not registered in .devrt/manifest.json: ${scenarioName}`);
  }

  const startedAt = new Date();
  const result = await runScenario(cwd, manifest, scenario, taskId, env);
  const finishedAt = new Date();
  const ok = result.ok === true;
  const trace = await writeTrace(cwd, {
    traceId: createTraceId(),
    type: "verify",
    taskId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok,
    status: ok ? "verified" : "needs_fix",
    scenario: result,
    nextSuggestedChecks: ok ? [] : [`devrt verify scenario ${scenarioName} --task ${taskId}`]
  });

  return {
    ok,
    status: ok ? "verified" : "needs_fix",
    taskId,
    scenario: result,
    traceId: trace.traceId,
    traceFile: trace.traceFile,
    nextSuggestedChecks: ok ? [] : [`devrt status --task ${taskId}`]
  };
}

async function runScenario(
  cwd: string,
  manifest: Manifest,
  scenario: ScenarioDefinition,
  taskId: string,
  env: NodeJS.ProcessEnv
): Promise<JsonObject & { ok: boolean }> {
  const validation = validateScenarioDefinition(scenario, manifest);
  if (validation.length > 0) {
    return {
      ok: false,
      name: scenario.name ?? "unknown",
      error: {
        type: "InvalidScenarioDefinition",
        message: validation.join("; ")
      },
      steps: []
    };
  }

  const context: JsonObject = {};
  const steps: JsonObject[] = [];
  let ok = true;
  let failure: JsonObject | undefined;

  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index] as ScenarioStepDefinition;
    const stepName = step.name ?? `step${index + 1}`;
    const input = resolveTemplateValue(step.input ?? {}, context);

    try {
      const actionResult = await executeAction(cwd, manifest, step.action, input, taskId, env);
      const assertions = evaluateAssertions(actionResult, step.expect ?? []);
      const stepOk = actionResult.ok === true && assertions.every((assertion) => assertion.ok === true);
      const record: JsonObject = {
        name: stepName,
        action: step.action,
        ok: stepOk,
        input,
        result: actionResult,
        assertions
      };
      steps.push(record);
      context[stepName] = actionResult;

      if (!stepOk) {
        ok = false;
        failure = {
          type: actionResult.ok === true ? "ScenarioAssertionFailed" : "ScenarioActionFailed",
          message: `Scenario step failed: ${stepName}`,
          step: stepName,
          action: step.action
        };
        break;
      }
    } catch (error) {
      ok = false;
      failure = {
        type: "ScenarioStepError",
        message: errorToMessage(error),
        step: stepName,
        action: step.action
      };
      steps.push({
        name: stepName,
        action: step.action,
        ok: false,
        input,
        error: failure
      });
      break;
    }
  }

  const cleanup = await runCleanupSteps(cwd, manifest, scenario.cleanup ?? [], taskId, env, context);
  const result: JsonObject & { ok: boolean } = {
    ok,
    name: scenario.name,
    description: scenario.description ?? "",
    steps,
    cleanup
  };
  if (failure) {
    result.error = failure;
  }
  return result;
}

async function runCleanupSteps(
  cwd: string,
  manifest: Manifest,
  cleanupSteps: ScenarioStepDefinition[],
  taskId: string,
  env: NodeJS.ProcessEnv,
  context: JsonObject
): Promise<JsonObject[]> {
  const cleanup: JsonObject[] = [];
  for (let index = 0; index < cleanupSteps.length; index += 1) {
    const step = cleanupSteps[index] as ScenarioStepDefinition;
    const stepName = step.name ?? `cleanup${index + 1}`;
    const input = resolveTemplateValue(step.input ?? {}, context);
    try {
      const actionResult = await executeAction(cwd, manifest, step.action, input, taskId, env);
      cleanup.push({
        name: stepName,
        action: step.action,
        ok: actionResult.ok,
        input,
        result: actionResult
      });
      context[stepName] = actionResult;
    } catch (error) {
      cleanup.push({
        name: stepName,
        action: step.action,
        ok: false,
        input,
        error: {
          type: "CleanupStepError",
          message: errorToMessage(error)
        }
      });
    }
  }
  return cleanup;
}

async function getTaskStatus(cwd: string, parsed: ParsedArgs): Promise<JsonObject> {
  await ensureWorkspace(cwd);
  const taskId = requireTaskFlag(parsed);
  await assertDirectory(getTaskDir(cwd, taskId), `Task not found: ${taskId}`);
  const traces = await readTraces(cwd, taskId);

  if (traces.length === 0) {
    return {
      ok: true,
      taskId,
      status: "needs_action",
      message: "No devrt runs or verify checks have been recorded for this task.",
      nextSuggestedCommands: [`devrt run <action> --task ${taskId} --json '{...}'`, `devrt verify --task ${taskId}`]
    };
  }

  const latest = traces[traces.length - 1] as TraceRecord;
  const latestVerify = [...traces].reverse().find((trace) => trace.type === "verify");

  if (latestVerify) {
    return {
      ok: true,
      taskId,
      status: typeof latestVerify.status === "string" ? latestVerify.status : latestVerify.ok ? "verified" : "needs_fix",
      latestTraceId: latest.traceId,
      latestVerifyTraceId: latestVerify.traceId,
      message: statusMessage(latestVerify),
      nextSuggestedCommands: latestVerify.ok ? [] : [`devrt verify --task ${taskId}`]
    };
  }

  return {
    ok: true,
    taskId,
    status: latest?.ok ? "needs_action" : "needs_fix",
    latestTraceId: latest.traceId,
    message: latest.ok
      ? "Actions have run, but no verification trace exists yet."
      : "The latest action failed and should be fixed before verification.",
    nextSuggestedCommands: latest.ok ? [`devrt verify --task ${taskId}`] : [`devrt replay last --task ${taskId}`]
  };
}

async function replayLast(cwd: string, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<JsonObject & { ok: boolean }> {
  await ensureWorkspace(cwd);
  const taskId = getStringFlag(parsed, "task");
  const traces = await readTraces(cwd, taskId);
  const last = traces.at(-1);
  if (!last) {
    throw usageError(taskId ? `No traces found for task: ${taskId}` : "No traces found.");
  }

  if (last.type === "verify") {
    const replayArgs = ["verify"];
    if (last.taskId) {
      replayArgs.push("--task", String(last.taskId));
    }
    const result = await verifyTask(cwd, parseArgs(replayArgs), env);
    return {
      ...result,
      replayOf: last.traceId
    };
  }

  if (last.type === "action") {
    const replayArgs = ["run", String(last.action)];
    if (last.taskId) {
      replayArgs.push("--task", String(last.taskId));
    }
    replayArgs.push("--json", JSON.stringify(last.input ?? {}));
    const result = await runAction(cwd, parseArgs(replayArgs), env);
    return {
      ...result,
      replayOf: last.traceId
    };
  }

  throw usageError(`Unsupported trace type: ${String(last.type)}`);
}

async function loadManifest(cwd: string): Promise<Manifest> {
  await ensureWorkspace(cwd);
  return readJsonFile<Manifest>(path.join(cwd, DEVRT_DIR, "manifest.json"));
}

async function validateManifest(cwd: string): Promise<{ errors: string[]; warnings: string[] }> {
  let manifest: Manifest;
  try {
    manifest = await loadManifest(cwd);
  } catch (error) {
    return { errors: [errorToMessage(error)], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  if (manifest.version !== 1) {
    warnings.push("manifest.version should be 1 for devrt v1.");
  }

  if (manifest.tools !== undefined) {
    if (!Array.isArray(manifest.tools)) {
      errors.push("manifest.tools must be an array when present.");
    } else {
      const names = new Set<string>();
      for (const tool of manifest.tools) {
        for (const message of validateToolDefinition(tool)) {
          errors.push(`tool ${String(tool.name ?? "unknown")}: ${message}`);
        }
        if (typeof tool.name === "string") {
          if (names.has(tool.name)) {
            errors.push(`Duplicate tool name: ${tool.name}`);
          }
          names.add(tool.name);
        }
      }
    }
  }

  if (!Array.isArray(manifest.actions)) {
    errors.push("manifest.actions must be an array.");
  } else {
    const names = new Set<string>();
    for (const action of manifest.actions) {
      const validation = validateActionDefinition(cwd, action);
      errors.push(...validation.errors.map((message) => `action ${String(action.name ?? "unknown")}: ${message}`));
      warnings.push(...validation.warnings.map((message) => `action ${String(action.name ?? "unknown")}: ${message}`));
      if (typeof action.name === "string") {
        if (names.has(action.name)) {
          errors.push(`Duplicate action name: ${action.name}`);
        }
        names.add(action.name);
      }
    }
  }

  if (manifest.verify !== undefined) {
    if (!Array.isArray(manifest.verify)) {
      errors.push("manifest.verify must be an array when present.");
    } else {
      const names = new Set<string>();
      for (const check of manifest.verify) {
        for (const message of validateVerifyDefinition(check)) {
          errors.push(`verify ${String(check.name ?? "unknown")}: ${message}`);
        }
        if (typeof check.name === "string") {
          if (names.has(check.name)) {
            errors.push(`Duplicate verify check name: ${check.name}`);
          }
          names.add(check.name);
        }
      }
    }
  }

  if (manifest.scenarios !== undefined) {
    if (!Array.isArray(manifest.scenarios)) {
      errors.push("manifest.scenarios must be an array when present.");
    } else {
      const names = new Set<string>();
      for (const scenario of manifest.scenarios) {
        for (const message of validateScenarioDefinition(scenario, manifest)) {
          errors.push(`scenario ${String(scenario.name ?? "unknown")}: ${message}`);
        }
        if (typeof scenario.name === "string") {
          if (names.has(scenario.name)) {
            errors.push(`Duplicate scenario name: ${scenario.name}`);
          }
          names.add(scenario.name);
        }
      }
    }
  }

  return { errors, warnings };
}

function validateActionDefinition(cwd: string, action: Partial<ActionDefinition>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!action || typeof action !== "object") {
    return { errors: ["entry must be an object."], warnings };
  }

  if (!action.name || typeof action.name !== "string") {
    errors.push("name is required.");
  }
  if (!action.source || typeof action.source !== "string") {
    errors.push("source is required.");
  } else {
    const sourcePath = action.source.split("#")[0];
    if (looksLikeLocalPath(sourcePath) && !existsSync(path.resolve(cwd, sourcePath))) {
      warnings.push(`source path does not exist: ${sourcePath}`);
    }
  }
  if (!Array.isArray(action.sideEffects)) {
    errors.push("sideEffects must be an array.");
  }
  if (!action.command || typeof action.command !== "string") {
    errors.push("command is required.");
  }
  if (action.tags !== undefined && !isStringArray(action.tags)) {
    errors.push("tags must be an array of strings when present.");
  }
  if (action.capabilities !== undefined && !isStringArray(action.capabilities)) {
    errors.push("capabilities must be an array of strings when present.");
  }
  if (action.probe !== undefined && typeof action.probe !== "string") {
    errors.push("probe must be a string when present.");
  }
  if (action.inputSchema !== undefined && !isPlainObject(action.inputSchema)) {
    errors.push("inputSchema must be an object when present.");
  }
  if (action.outputSchema !== undefined && !isPlainObject(action.outputSchema)) {
    errors.push("outputSchema must be an object when present.");
  }

  return { errors, warnings };
}

function validateToolDefinition(tool: Partial<ToolDefinition>): string[] {
  const errors: string[] = [];
  if (!tool || typeof tool !== "object") {
    return ["entry must be an object."];
  }
  if (!tool.name || typeof tool.name !== "string") {
    errors.push("name is required.");
  }
  if (!tool.command || typeof tool.command !== "string") {
    errors.push("command is required.");
  }
  if (tool.probe !== undefined && typeof tool.probe !== "string") {
    errors.push("probe must be a string when present.");
  }
  if (tool.tags !== undefined && !isStringArray(tool.tags)) {
    errors.push("tags must be an array of strings when present.");
  }
  if (tool.capabilities !== undefined && !isStringArray(tool.capabilities)) {
    errors.push("capabilities must be an array of strings when present.");
  }
  return errors;
}

function validateVerifyDefinition(check: Partial<VerifyDefinition>): string[] {
  const errors: string[] = [];
  if (!check || typeof check !== "object") {
    return ["entry must be an object."];
  }
  if (!check.name || typeof check.name !== "string") {
    errors.push("name is required.");
  }
  if (!check.command || typeof check.command !== "string") {
    errors.push("command is required.");
  }
  return errors;
}

function validateScenarioDefinition(scenario: Partial<ScenarioDefinition>, manifest: Manifest): string[] {
  const errors: string[] = [];
  if (!scenario || typeof scenario !== "object") {
    return ["entry must be an object."];
  }
  if (!scenario.name || typeof scenario.name !== "string") {
    errors.push("name is required.");
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    errors.push("steps must be a non-empty array.");
    return errors;
  }

  const actionNames = new Set((manifest.actions ?? []).map((action) => action.name));
  for (const [index, step] of scenario.steps.entries()) {
    errors.push(...validateScenarioStep(step, actionNames, `steps[${index}]`));
  }
  for (const [index, step] of (scenario.cleanup ?? []).entries()) {
    errors.push(...validateScenarioStep(step, actionNames, `cleanup[${index}]`));
  }
  return errors;
}

function validateScenarioStep(step: Partial<ScenarioStepDefinition>, actionNames: Set<string>, label: string): string[] {
  const errors: string[] = [];
  if (!step || typeof step !== "object") {
    return [`${label} must be an object.`];
  }
  if (!step.action || typeof step.action !== "string") {
    errors.push(`${label}.action is required.`);
  } else if (!actionNames.has(step.action)) {
    errors.push(`${label}.action is not registered: ${step.action}`);
  }
  if (step.expect !== undefined) {
    if (!Array.isArray(step.expect)) {
      errors.push(`${label}.expect must be an array when present.`);
    } else {
      step.expect.forEach((assertion, index) => {
        if (!assertion || typeof assertion !== "object" || typeof assertion.path !== "string") {
          errors.push(`${label}.expect[${index}] must include a string path.`);
        }
      });
    }
  }
  return errors;
}

function findManifestDuplicates(manifest: Manifest): JsonObject[] {
  const duplicates: JsonObject[] = [];
  duplicates.push(...findDuplicateValues("action_name", (manifest.actions ?? []).map((action) => action.name).filter(Boolean)));
  duplicates.push(...findDuplicateValues("action_command", (manifest.actions ?? []).map((action) => action.command).filter(Boolean)));
  duplicates.push(...findDuplicateValues("action_source", (manifest.actions ?? []).map((action) => action.source).filter(Boolean)));
  duplicates.push(...findDuplicateValues("tool_name", (manifest.tools ?? []).map((tool) => tool.name).filter(Boolean)));
  duplicates.push(...findDuplicateValues("scenario_name", (manifest.scenarios ?? []).map((scenario) => scenario.name).filter(Boolean)));
  return duplicates;
}

function findDuplicateValues(type: string, values: string[]): JsonObject[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ type, value, count }));
}

async function checkTools(
  cwd: string,
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
  runProbes: boolean
): Promise<JsonObject[]> {
  const checks: JsonObject[] = [];
  for (const tool of manifest.tools ?? []) {
    const staticCheck = checkCommandTarget(cwd, tool.command);
    if (!runProbes || !tool.probe) {
      checks.push({
        name: tool.name,
        command: tool.command,
        ok: staticCheck.ok,
        check: "static",
        message: staticCheck.message,
        hasProbe: Boolean(tool.probe)
      });
      continue;
    }

    const result = await runShellCommand(cwd, tool.probe, {
      cwd: tool.cwd,
      timeoutMs: tool.timeoutMs ?? 15_000,
      env
    });
    checks.push({
      name: tool.name,
      command: tool.command,
      probe: tool.probe,
      ok: result.exitCode === 0 && !result.timedOut,
      check: "probe",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut: result.timedOut
    });
  }
  return checks;
}

function checkActionCommands(cwd: string, manifest: Manifest): JsonObject[] {
  return (manifest.actions ?? []).map((action) => {
    const commandCheck = checkCommandTarget(cwd, action.command);
    return {
      name: action.name,
      command: action.command,
      ok: commandCheck.ok,
      message: commandCheck.message,
      hasSchema: isPlainObject(action.inputSchema),
      hasProbe: typeof action.probe === "string",
      tags: action.tags ?? [],
      capabilities: action.capabilities ?? []
    };
  });
}

function checkScenarios(manifest: Manifest): JsonObject[] {
  return (manifest.scenarios ?? []).map((scenario) => {
    const errors = validateScenarioDefinition(scenario, manifest);
    return {
      name: scenario.name,
      ok: errors.length === 0,
      message: errors.join("; "),
      steps: Array.isArray(scenario.steps) ? scenario.steps.length : 0,
      cleanup: Array.isArray(scenario.cleanup) ? scenario.cleanup.length : 0
    };
  });
}

function checkCommandTarget(cwd: string, command: string): { ok: boolean | null; message: string } {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) {
    return { ok: false, message: "command is empty" };
  }

  const first = stripQuotes(tokens[0]);
  const second = tokens[1] ? stripQuotes(tokens[1]) : undefined;
  const candidate = first === "node" || first === "tsx" || first === "bun" || first === "deno" ? second : first;
  if (!candidate) {
    return { ok: null, message: "command target cannot be inferred statically" };
  }
  if (!looksLikeLocalPath(candidate)) {
    return { ok: null, message: "external command; static availability not checked" };
  }

  const absolutePath = path.resolve(cwd, candidate);
  return existsSync(absolutePath)
    ? { ok: true, message: "local command target exists" }
    : { ok: false, message: `local command target is missing: ${candidate}` };
}

function evaluateAssertions(value: JsonObject, assertions: AssertionDefinition[]): JsonObject[] {
  return assertions.map((assertion) => evaluateAssertion(value, assertion));
}

function evaluateAssertion(value: JsonObject, assertion: AssertionDefinition): JsonObject {
  const actual = getPathValue(value, assertion.path);
  const actualExists = actual !== undefined;
  const failures: string[] = [];

  if (assertion.exists !== undefined && assertion.exists !== actualExists) {
    failures.push(`expected exists=${assertion.exists}`);
  }
  if ("equals" in assertion && JSON.stringify(actual) !== JSON.stringify(assertion.equals)) {
    failures.push(`expected ${assertion.path} to equal ${JSON.stringify(assertion.equals)}`);
  }
  if (assertion.contains !== undefined && !String(actual ?? "").includes(assertion.contains)) {
    failures.push(`expected ${assertion.path} to contain ${assertion.contains}`);
  }
  if (assertion.min !== undefined && !(typeof actual === "number" && actual >= assertion.min)) {
    failures.push(`expected ${assertion.path} >= ${assertion.min}`);
  }
  if (assertion.max !== undefined && !(typeof actual === "number" && actual <= assertion.max)) {
    failures.push(`expected ${assertion.path} <= ${assertion.max}`);
  }
  if (assertion.length !== undefined && getLength(actual) !== assertion.length) {
    failures.push(`expected ${assertion.path}.length === ${assertion.length}`);
  }
  if (assertion.lengthMin !== undefined && !(getLength(actual) >= assertion.lengthMin)) {
    failures.push(`expected ${assertion.path}.length >= ${assertion.lengthMin}`);
  }
  if (assertion.matches !== undefined && !new RegExp(assertion.matches).test(String(actual ?? ""))) {
    failures.push(`expected ${assertion.path} to match ${assertion.matches}`);
  }

  return {
    ok: failures.length === 0,
    path: assertion.path,
    actual: actual === undefined ? null : actual,
    failures
  };
}

function resolveTemplateValue(value: JsonValue, context: JsonObject): JsonValue {
  if (typeof value === "string") {
    const exactMatch = /^\$\{([^}]+)\}$/.exec(value);
    if (exactMatch) {
      const resolved = getPathValue(context, exactMatch[1] as string);
      return resolved === undefined ? value : resolved;
    }
    return value.replace(/\$\{([^}]+)\}/g, (_match, pathExpression: string) => {
      const resolved = getPathValue(context, pathExpression);
      return resolved === undefined ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context));
  }
  if (isPlainObject(value)) {
    const next: JsonObject = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      next[key] = resolveTemplateValue(nestedValue, context);
    }
    return next;
  }
  return value;
}

function getPathValue(value: JsonValue | undefined, pathExpression: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of pathExpression.split(".")) {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (isPlainObject(current)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function getLength(value: JsonValue | undefined): number {
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length;
  }
  return -1;
}

function validateJsonSchema(value: JsonValue, schema: JsonSchema | undefined, pathName: string): string[] {
  if (!schema) {
    return [];
  }

  const errors: string[] = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.includes(jsonType(value))) {
    errors.push(`${pathName} expected ${allowedTypes.join("|")}, received ${jsonType(value)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    errors.push(`${pathName} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }

  if (schema.type === "object" && isPlainObject(value)) {
    const objectValue = value as JsonObject;
    for (const key of schema.required ?? []) {
      if (!(key in objectValue)) {
        errors.push(`${pathName}.${key} is required`);
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) {
        errors.push(...validateJsonSchema(objectValue[key], propertySchema, `${pathName}.${key}`));
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(objectValue)) {
        if (!allowed.has(key)) {
          errors.push(`${pathName}.${key} is not allowed`);
        }
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items, `${pathName}[${index}]`));
    });
  }

  return errors;
}

function buildActionResult(
  action: string,
  input: JsonValue,
  commandResult: CommandResult,
  structured: JsonObject,
  ok: boolean
): JsonObject & { ok: boolean } {
  const outputLogs = collectLogs(commandResult, structured);
  const base: JsonObject & { ok: boolean } = {
    ok,
    action,
    durationMs: commandResult.durationMs,
    result: structured.result ?? structured,
    stateChanges: Array.isArray(structured.stateChanges) ? structured.stateChanges : [],
    logs: outputLogs,
    nextSuggestedChecks: Array.isArray(structured.nextSuggestedChecks) ? structured.nextSuggestedChecks : []
  };

  if (!ok) {
    base.error = structured.error ?? {
      type: commandResult.timedOut ? "ActionTimeout" : "ActionCommandFailed",
      message: commandResult.timedOut
        ? "Action command timed out."
        : `Action command exited with code ${commandResult.exitCode}.`,
      stderr: commandResult.stderr
    };
  }

  if (!("input" in base)) {
    base.input = input;
  }

  return base;
}

async function runShellCommand(
  rootCwd: string,
  command: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  }
): Promise<CommandResult> {
  const startedAt = Date.now();
  const child = spawn(command, {
    cwd: options.cwd ? path.resolve(rootCwd, options.cwd) : rootCwd,
    env: options.env,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
  }
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
  clearTimeout(timeout);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    timedOut
  };
}

async function writeTrace(cwd: string, trace: TraceRecord): Promise<TraceRecord & { traceFile: string }> {
  const tracePath = path.join(cwd, DEVRT_DIR, TRACES_DIR, `${trace.traceId}.json`);
  await mkdir(path.dirname(tracePath), { recursive: true });
  await writeFile(tracePath, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return {
    ...trace,
    traceFile: displayPath(cwd, tracePath)
  };
}

async function readTraces(cwd: string, taskId?: string): Promise<TraceRecord[]> {
  const tracesPath = path.join(cwd, DEVRT_DIR, TRACES_DIR);
  if (!existsSync(tracesPath)) {
    return [];
  }

  const entries = await readdir(tracesPath);
  const traces: TraceRecord[] = [];
  for (const entry of entries.filter((file) => file.endsWith(".json")).sort()) {
    const trace = await readJsonFile<TraceRecord>(path.join(tracesPath, entry));
    if (!taskId || trace.taskId === taskId) {
      traces.push(trace);
    }
  }
  return traces;
}

function parseJsonPayload(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw usageError(`Invalid JSON payload: ${errorToMessage(error)}`);
  }
}

function parseCommandJson(stdout: string): JsonObject {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return isPlainObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { stdout };
  }
}

function collectLogs(commandResult: CommandResult, structured: JsonObject): JsonValue[] {
  if (Array.isArray(structured.logs)) {
    return structured.logs;
  }

  const logs: string[] = [];
  if (commandResult.stderr.trim()) {
    logs.push(...commandResult.stderr.trim().split(/\r?\n/));
  }
  if (commandResult.stdout.trim() && !isLikelyJson(commandResult.stdout)) {
    logs.push(...commandResult.stdout.trim().split(/\r?\n/));
  }
  return logs;
}

function createRuntimeEnv(baseEnv: NodeJS.ProcessEnv, additions: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

function createTaskId(rawTask: string): string {
  const datePart = new Date().toISOString().slice(0, 10);
  const slug = rawTask
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return validateId(`${datePart}-${slug || "task"}-${hash(rawTask).slice(0, 8)}`);
}

function createTraceId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function requireTaskFlag(parsed: ParsedArgs): string {
  const taskId = getStringFlag(parsed, "task");
  if (!taskId) {
    throw usageError("Missing required flag: --task <taskId>");
  }
  return validateId(taskId);
}

function requireTaskId(taskId: string | undefined): string {
  if (!taskId) {
    throw usageError("Missing task id.");
  }
  return validateId(taskId);
}

function validateId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw usageError(`Invalid id: ${id}`);
  }
  return id;
}

function getStringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function ensureWorkspace(cwd: string): Promise<void> {
  await assertDirectory(path.join(cwd, DEVRT_DIR), "No .devrt workspace found. Run `devrt init` first.");
}

async function assertDirectory(directoryPath: string, message: string): Promise<void> {
  try {
    const info = await stat(directoryPath);
    if (!info.isDirectory()) {
      throw new Error(message);
    }
  } catch {
    throw usageError(message);
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    throw usageError(`Failed to read JSON file ${filePath}: ${errorToMessage(error)}`);
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getTaskDir(cwd: string, taskId: string): string {
  return path.join(cwd, DEVRT_DIR, TASKS_DIR, validateId(taskId));
}

function writeJson(stream: Writable, value: JsonValue): void {
  stream.write(JSON.stringify(value, null, 2));
  stream.write("\n");
}

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "UsageError";
  return error;
}

function errorResult(error: unknown): JsonObject {
  return {
    ok: false,
    error: {
      type: error instanceof Error ? error.name : "Error",
      message: errorToMessage(error)
    }
  };
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helpResult(): JsonObject {
  return {
    ok: true,
    name: "devrt",
    commands: [
      "devrt init",
      "devrt init --agent",
      "devrt agent install",
      "devrt agent instructions",
      "devrt task create --from <file|-> [--id <taskId>]",
      "devrt task show <taskId>",
      "devrt actions list",
      "devrt actions validate",
      "devrt scenarios list",
      "devrt doctor [--no-probes]",
      "devrt run <action> --task <taskId> --json '{...}'",
      "devrt verify --task <taskId>",
      "devrt verify scenario <name> --task <taskId>",
      "devrt status --task <taskId>",
      "devrt replay last [--task <taskId>]"
    ]
  };
}

function defaultInstructions(): string {
  return `# devrt Agent Instructions

This project uses devrt as an agent-native development runtime. Use it whenever a task changes or validates a real product workflow.

Core loop:

1. Preserve the user's original request with \`devrt task create --from <file|->\`. Do not rewrite \`.devrt/tasks/<taskId>/task.md\`.
2. Run \`devrt doctor\` before adding wrappers. Reuse existing project CLIs, scripts, API routes, or service entrypoints first.
3. If the existing surface is not enough, update \`.devrt/manifest.json\` with real actions. Actions must point to real commands/source and return stable JSON.
4. Maintain scenarios for changed workflows. A good scenario creates resources, passes ids forward, triggers the business action, waits/reads results, asserts outcomes, and cleans up when practical.
5. Do not treat typecheck/build as sufficient proof. Prefer \`devrt verify --task <taskId>\` backed by workflow scenarios.
6. Continue fixing while \`devrt status --task <taskId>\` is \`needs_action\`, \`needs_fix\`, or \`blocked\`.
7. Stop only when \`devrt status --task <taskId>\` returns \`verified\`.

Useful commands:

\`\`\`bash
devrt doctor
devrt actions list
devrt scenarios list
devrt run <action> --task <taskId> --json '{...}'
devrt verify --task <taskId>
devrt status --task <taskId>
devrt replay last --task <taskId>
\`\`\`
`;
}

function projectAgentBlock(fileName: string): string {
  return `## devrt Agent Runtime

Read \`.devrt/instructions.md\` before implementing or verifying product changes.

When this project has a user-facing workflow change, use devrt as the verification loop:

- Create or inspect a devrt task that preserves the user's original request.
- Run \`devrt doctor\` and reuse existing project CLI/API/script capabilities before adding new wrappers.
- Keep \`.devrt/manifest.json\` actions and scenarios aligned with the workflow you change.
- Verify with \`devrt verify --task <taskId>\`; do not rely only on typecheck/build for completion.
- Continue until \`devrt status --task <taskId>\` returns \`verified\`.

This block is managed by \`devrt agent install\` for ${fileName}.`;
}

function displayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative.startsWith("..") ? absolutePath : relative || ".";
}

function statusMessage(trace: TraceRecord): string {
  const status = typeof trace.status === "string" ? trace.status : trace.ok ? "verified" : "needs_fix";
  if (status === "verified") {
    return "Latest verification passed.";
  }
  if (status === "blocked") {
    return "Verification is blocked.";
  }
  return "Latest verification failed and needs a code or test fix.";
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.includes("/") || value.endsWith(".ts") || value.endsWith(".js");
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function jsonType(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isLikelyJson(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
