<div align="center">

# devrt

**给你的项目装一层 agent-native 运行时。**

让 Claude Code、Codex、Cursor 能执行真实业务流程、拿到结构化结果、并**证明**改动真的能用 —— 而不是读读代码、猜猜 UI 就说"修好了"。

[![CI](https://github.com/EdwinjJ1/devrt/actions/workflows/ci.yml/badge.svg)](https://github.com/EdwinjJ1/devrt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[English](./README.md) | 简体中文

</div>

---

## 为什么需要 devrt？

AI coding agent 很会**写代码**，但很不会**证明代码能用**：

- 改完代码跑一下 `tsc` 就宣布胜利，实际功能是坏的。
- 用 Playwright 模拟人类点按钮，慢、flaky，而且完全不符合 LLM 的思维方式。
- 每个 session 都重新发明一堆一次性验证脚本，用完就烂掉。
- 用户最初的需求被 agent 反复转述、变形，最后悄悄丢失。

Agent 真正擅长的是**调用工具、读 schema、对结构化 JSON 做推理**。那就给它这个：

```text
Claude Code / Codex / Cursor
        │  shell 命令
        ▼
   devrt CLI / runtime          ← 本项目
        │  执行真实的项目业务动作
        ▼
你的代码 / API / DB / 日志
        │  结构化 JSON 结果
        ▼
Claude Code / Codex / Cursor    ← 知道刚才发生了什么、状态怎么变了、下一步跑什么
```

`devrt` 是一个住在你仓库里的、零依赖的轻量执行层：

- 📌 **Task** —— 用户的原始需求原文保存（带 sha256），agent 不能偷偷改写目标。
- ⚡ **Action** —— 真实业务动作（建用户、触发任务……）在 manifest 里注册一次，之后用带 schema 校验的 JSON 调用。
- 🎬 **Scenario** —— 多步工作流 + 断言：创建资源 → 把 id 传给下一步 → 断言结果 → 清理。
- ✅ **Verify** —— 一条命令回答唯一重要的问题：*这个任务到底做完没有？*（`verified` / `needs_fix` / `blocked`）
- 🔁 **Trace & Replay** —— 每次执行都记录成 JSON，可以回放复现问题。

它**不是**又一个 coding agent，不是测试框架，不是 Playwright 替代品，也不是 MCP server。它是 agent 和你项目之间缺失的那一层：**项目说明书 + 可执行遥控器 + 回执系统**。

## 安装

**一行命令**（需要 Node.js ≥ 20）：

```bash
curl -fsSL https://raw.githubusercontent.com/EdwinjJ1/devrt/main/install.sh | bash
```

**或者直接用 npm：**

```bash
npm install -g github:EdwinjJ1/devrt
```

**或者免安装试用：**

```bash
npx github:EdwinjJ1/devrt help
```

## 60 秒上手

**1. 一条命令让项目变成 agent-ready：**

```bash
cd your-project
devrt init --agent
```

这会创建 `.devrt/` 工作区，并安装 agent 入口文件（`AGENTS.md`、`CLAUDE.md`、`.devrt/instructions.md`）。已有文件会被保留 —— devrt 只维护自己标记的区块，你的项目规则不受影响。从此任何 coding agent 打开你的仓库都知道怎么干活。

**2. 保存任务** —— 用户的原话，一字不改：

```bash
echo "Fix: creating a todo via the API should return its id" > task.md
devrt task create --from task.md
```

```json
{
  "ok": true,
  "taskId": "2026-07-02-fix-creating-a-todo-via-the-api-7780b7a6",
  "taskFile": ".devrt/tasks/2026-07-02-fix-creating-a-todo-via-the-api-7780b7a6/task.md",
  "sha256": "7780b7a6…"
}
```

**3. 在 `.devrt/manifest.json` 里注册真实业务动作**（包装你已有的 service/CLI，不要重复业务逻辑）：

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

**4. 执行并验证** —— 靠结构化结果说话，不靠感觉：

```bash
devrt run todo.create --task <taskId> --json '{"title":"Ship devrt"}'
devrt verify --task <taskId>
```

```json
{
  "ok": true,
  "status": "verified",
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

失败时，agent 会拿到*哪一步*、*哪条断言*、*期望值 vs 实际值*，外加完整 trace —— 足够它自己继续修，不需要人盯着。

## 命令一览

所有命令都输出 JSON，agent（和脚本）可以直接消费。

| 命令 | 作用 |
|---|---|
| `devrt init` | 创建 `.devrt/` 工作区（manifest、tasks、traces） |
| `devrt init --agent` | 同上，并安装 agent 入口：`AGENTS.md`、`CLAUDE.md`、`.devrt/instructions.md` |
| `devrt agent install` | （重新）安装 / 刷新 agent 入口文件 |
| `devrt agent instructions` | 打印 agent 操作指南（markdown） |
| `devrt task create --from <file\|->` | 原文保存用户任务，生成稳定的 task id |
| `devrt task show <taskId>` | 查看任务和验收标准 |
| `devrt doctor [--no-probes]` | 体检：manifest 合法性、重复 action、工具探针、下一步该补什么 |
| `devrt actions list` / `validate` | 列出 / 校验已注册的 action |
| `devrt scenarios list` | 列出工作流场景 |
| `devrt run <action> --task <id> --json '{…}'` | 用 schema 校验过的输入执行 action，记录 trace |
| `devrt verify --task <id>` | 跑所有场景（或 verify 检查），判定任务状态 |
| `devrt verify scenario <name> --task <id>` | 只验证某一个场景 |
| `devrt status --task <id>` | 当前任务状态：`needs_action` / `needs_fix` / `blocked` / `verified` |
| `devrt replay last [--task <id>]` | 根据 trace 重放最近一次执行 / 验证 |

## Agent 是怎么用它的

`devrt init --agent` 之后，装好的指令会让任何 coding agent：

1. **先保存任务** —— 动代码之前先 `devrt task create --from -`。
2. **先摸清现状** —— `devrt doctor` 看已有哪些 tool/action/scenario、哪些能用。
3. **复用而不是重造** —— 调用已注册的 action，而不是写一次性脚本；工作流变了就同步注册新 action。
4. **拿出证据** —— `devrt verify --task <id>` 通过之前，不允许说"做完了"。

`devrt doctor` 还会告诉 agent 缺什么 —— 比如"有 action 但没有任何 scenario 能证明真实工作流" —— 验证层随项目一起长大。

## 设计原则

- **真实工作流 > 泛型检查。** `tsc` 通过不算证明。强信号是把真实产品流程跑一遍：创建资源、传递 id、断言结果、清理现场。
- **同一套业务逻辑。** Action 包装你已有的 service 层 / CLI / API。如果 UI 走一条代码路径、agent 走另一条，验证就是自欺欺人。
- **确定性 > 生成式。** Agent 可以*帮忙写* manifest，但 runtime 用确定性方式校验一切：schema、命令目标、重名、场景引用。只能调用已注册 action，不能瞎猜命令。
- **凡执行必留回执。** 每次运行、每次验证都写 JSON trace，`replay last` 一键复现。
- **零依赖。** 纯 Node.js ≥ 20，除了这个仓库没有任何需要审计的东西。

## 对比

| | devrt | Playwright / Cypress | 一次性脚本 | 固定 MCP tools |
|---|---|---|---|---|
| 为 LLM tool-calling 而生 | ✅ JSON 进出 + schema | ❌ selector、等待 | ⚠️ 随手写 | ✅ |
| 验证真实业务流程 | ✅ | ⚠️ 走 UI，flaky | ⚠️ 无人 review | ⚠️ |
| 跟随代码演进 | ✅ manifest 进 git diff | ⚠️ | ❌ 立刻腐烂 | ❌ 工具面固定 |
| 回放 / 审计记录 | ✅ traces | ⚠️ | ❌ | ❌ |
| 保护原始需求不变形 | ✅ 原文 + sha256 | ❌ | ❌ | ❌ |

它们是互补而不是竞争：devrt 负责业务/状态/流程验证，真实 UI 的问题（布局、弹窗、hover）留给一层薄薄的 Playwright smoke test。

## Roadmap

- [ ] `devrt scan` —— 从 Next.js 路由、Zod schema、TS 类型自动生成 manifest 草稿
- [ ] MCP adapter（`devrt mcp start`），给偏好 MCP 的 agent
- [ ] `devrt logs tail` —— 给 agent 的结构化日志访问
- [ ] 发布 npm 包（`npm i -g devrt`）
- [ ] 更多 adapter：Express、Prisma 状态检查

欢迎 Issue 和 PR —— 见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 参与开发

```bash
git clone https://github.com/EdwinjJ1/devrt.git
cd devrt
npm install
npm test        # build + node --test
```

整个 runtime 就两个文件（`src/index.ts`、`src/cli.ts`），零运行时依赖。规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[MIT](./LICENSE) © 2026 [Edwin](https://github.com/EdwinjJ1)

---

<div align="center">

*未来每个软件项目都不只需要 human UI 和 API，还需要一层 agent interface。devrt 就是那一层。*

**如果 devrt 帮你（或你的 agent）省下了一次 debug，点个 ⭐ 吧**

</div>
