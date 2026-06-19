# Agentic Dev Runtime 项目说明

日期：2026-06-15

这份文档只记录一个方向：**给 AI coding agent 使用的 CLI / runtime 工具**。

它不是 CI failure repair，也不是普通测试框架。核心是：

> 让 Claude Code、Codex、Cursor 这类 AI coding agent 不再只靠读代码和猜 UI，而是通过项目内的一套语义 CLI/runtime，执行真实业务动作、读取结构化结果、查看日志、复现问题、继续改代码。

## 1. 要解决的问题

AI coding agent 现在已经很会写代码，但验证能力弱：

- 容易胡编乱造。
- 修改后很难稳定判断功能是否真的可用。
- 在前端 UI 里模拟人类点击很难。
- Playwright/Cypress 能做，但对 AI 来说仍然容易 flaky。
- AI 更擅长工具调用、结构化输入输出、逻辑推理，而不是看网页、找按钮、点击、等待、观察。

传统路径：

```text
打开页面 -> 找按钮 -> 点击 -> 等待 -> 查 DOM -> 判断
```

目标路径：

```bash
devrt run private.entry.create --json '{"title":"方向判断","kind":"plan"}'
devrt run private.schedule.add --json '{"date":"2026-06-20","title":"找合伙人"}'
devrt state.inspect
devrt logs tail
devrt replay last
```

AI 不需要猜按钮在哪。它只需要理解 action、参数、结果、状态变化和日志。

## 2. 核心定义

更准确的定位：

> **Agentic Dev Runtime：一个项目内的 agent-native 执行层。它根据项目架构生成和维护 action manifest，并提供 CLI/runtime，让 AI coding agent 能执行真实业务流程、读取结构化结果、查看日志、复现问题。**

它不是新的 Claude Code。Claude Code / Codex / Cursor 负责思考和改代码；这个 runtime 负责执行、验证、回传结果。

架构：

```text
Claude Code / Codex / Cursor
        |
        | shell command / MCP tool
        v
devrt CLI/runtime
        |
        | execute real project actions
        v
Project code / APIs / DB / logs / tests
        |
        | structured result
        v
Claude Code / Codex / Cursor
```

可以理解成：

> 项目说明书 + 可执行遥控器 + 回执系统。

## 3. 不能怎么讲

不能讲成：

- “我发明了一种 AI 测试方式”
- “又一个 AI coding CLI”
- “又一个 Claude Code”
- “又一个 CI 自动修复工具”
- “又一个 MCP server”
- “Playwright 替代品”

这些方向已经很挤。这个项目的不同点是：

> 不是围绕 UI/browser automation，也不是固定 MCP tools，而是让 app 自己主动暴露业务动作，并让 agent 通过 runtime 执行和验证真实流程。

## 4. 关键优势

### 更适合 AI 调用

LLM 擅长读 schema、调用 tool、看 JSON 输出、根据错误继续推理。它不擅长稳定地看 UI、滚动、等待、点击。

### 比 UI 自动化更少 flaky

语义命令不依赖 selector、布局、动画、modal 出现时机、等待时间。它直接验证业务动作和状态变化。

### 不只是 test，也是调试接口

开发者和 AI 都可以用它快速创建状态、复现 bug、检查数据、查看日志、跑业务流程。

### 能形成 replay

AI 做过什么命令、输入是什么、输出是什么、改了哪些状态、哪里失败，都可以记录下来并复现。

### 让 app 变成 agent-readable

未来软件不只需要 human UI 和 API，也需要 agent interface：

- actions
- schemas
- state inspection
- logs
- replay
- policies
- side effects

## 5. 主要冷水

### 维护成本高

每个功能都可能需要 action schema、权限、参数校验、返回值、side effects、日志、replay。团队会问：我已经有 API、tests、Playwright，为什么还要多维护一层？

### 容易重复业务逻辑

如果 UI 调一套逻辑，CLI 又写一套逻辑，这个项目会失败。

正确方式：

> UI、CLI、测试、AI tool 全部调用同一套 domain action。

### 通用产品难做

每个 app 的业务动作都不同。很难“装上就自动有用”。必须靠 scanner、schema/type 约束、LLM 辅助生成、人类 review 和 runtime smoke check 降低接入成本。

### 不能替代真实 UI 测试

它验证不了按钮遮挡、mobile layout、modal、hover、scroll、真实用户体验。正确关系是：

> Semantic runtime 负责 60-80% 业务/状态/流程验证，Playwright/Cypress 负责真实 UI smoke test。

### 商业化不天然容易

Devtool 常见问题是开发者喜欢但不付钱。必须证明它能明显减少 AI coding 返工，或进入团队 workflow。

## 6. 为什么不是 skill 或固定 MCP

Skill 太软，本质是提示词。它只能告诉模型“你应该怎么做”，但不能强制执行、验证、回传真实结果。

MCP 也不是核心。MCP 可以作为 adapter，但这个项目里的工具会随代码变化：

- 新增功能后要新增 action。
- 修改后端流程后要同步 action manifest。
- 删除功能后要删除对应 action。

核心不是 MCP，而是：

> Action Discovery + Action Manifest + CLI Runtime + Structured Result + Replay。

## 7. 调用后返回什么

成功示例：

```json
{
  "ok": true,
  "action": "schedule.add",
  "durationMs": 184,
  "result": {
    "scheduleId": "sch_123",
    "date": "2026-06-20"
  },
  "stateChanges": [
    { "type": "insert", "target": "schedule", "id": "sch_123" }
  ],
  "logs": ["validated input", "created schedule item"],
  "nextSuggestedChecks": ["schedule.list", "state.inspect schedule sch_123"]
}
```

失败示例：

```json
{
  "ok": false,
  "action": "schedule.add",
  "error": {
    "type": "ValidationError",
    "message": "date is required",
    "field": "date"
  },
  "relatedFiles": ["src/server/schedule.ts"],
  "logs": ["input validation failed"],
  "suggestedFix": "Pass selectedDate into the schedule creation payload."
}
```

agent 拿到结果后应该知道：刚刚执行了什么、成功还是失败、状态怎么变了、哪个字段错了、该看哪个文件、下一步该跑什么。

## 8. Repo 和 CLI 形态

项目内部：

```text
repo/.devrt/
  manifest.json
  actions/
  traces/
  policies/
  adapters/
```

CLI 命令：

```bash
devrt init
devrt scan
devrt actions list
devrt actions generate
devrt run user.create --json '{"email":"a@test.com"}'
devrt inspect db user_123
devrt logs tail --since 5m
devrt replay last
devrt verify changed
devrt mcp start
```

核心组件：

- **Scanner**：扫描 API routes、server functions、service layer、DB schema、Zod/TS types。
- **Action Manifest**：记录 action 名称、schema、source、side effects、auth、返回值。
- **Runtime**：真正执行 action 并返回结构化结果。
- **Replay**：记录并复现 agent 执行过的动作。
- **Agent Adapter**：MCP、shell、Claude Code hooks、Codex instructions 等。

## 9. 如何避免模型胡编

不能只靠 LLM 生成 CLI。必须有硬约束：

- 从 TypeScript types、Zod schema、OpenAPI、Prisma schema 生成。
- 每个 action 必须定位到 source function。
- 每个 action 必须声明 side effects。
- action manifest 要进 git diff，可以 review。
- agent 只能调用已注册 action，不能乱猜命令。
- 生成后必须执行 `devrt verify changed`。
- manifest 和代码不一致时必须失败。

原则：

> LLM 可以帮助生成 action，但 runtime 必须用确定性方式验证 action 是否真实存在、能执行、能返回结果。

## 10. 产品与商业化

建议形态：

- 开源 CLI
- SDK
- local runtime
- local replay
- MCP adapter
- Claude Code / Codex integration
- 可选团队 dashboard

开源核心：

- SDK
- CLI
- scanner 基础能力
- action manifest
- local replay
- MCP adapter
- Next.js/Node adapter

收费团队层：

- team dashboard
- action graph 可视化
- agent run history
- replay sharing
- 权限控制
- audit logs
- cloud sandbox
- policy enforcement
- PR semantic verification
- private self-hosted

第一批用户：

- 重度使用 Claude Code / Codex / Cursor 的团队
- 有复杂业务流程的 SaaS 团队
- 后端 API 多、状态多、测试不完整的小团队
- internal tool / admin dashboard 团队
- 经常让 AI 改前后端功能但验证很痛的人

销售表达：

> AI 会改代码，但不稳定地理解和验证业务流程。我们给每个项目生成一层 Agent 可调用的语义运行时，让它能执行真实流程、看状态、看日志、复现问题。

更短：

> 给 AI coding agent 的项目执行底座。

## 11. MVP

第一版不要做全场景。建议只支持：

- TypeScript / Node
- Next.js 或 Express，建议先 Next.js
- Zod schema
- local dev
- CLI + manifest + replay
- 可选 MCP adapter

MVP 目标：

```bash
devrt init
devrt scan
devrt actions list
devrt run <action> --json '{...}'
devrt replay last
devrt verify changed
devrt mcp start
```

第一阶段验证：

1. 找一个真实项目。
2. 暴露 3-5 个真实业务 action。
3. 让 Claude Code/Codex 使用 `devrt` 完成一个功能修改。
4. 修改后必须通过 `devrt verify changed`。
5. 失败时 agent 能根据结构化结果继续修。

## 12. 4 周验证计划

### Week 1

- 建 CLI 包。
- 支持 `init`、`scan`、`actions list`。
- 手写 2-3 个 action。
- 支持 `run` 执行 action 并返回 JSON。
- 支持本地 replay。

### Week 2

- 扫描 Next.js route handlers 或 server functions。
- 识别 Zod schema 或 TypeScript input。
- 生成 manifest 草稿。
- manifest 进 git diff，人工 review。

### Week 3

- 写 Claude Code/Codex 使用说明。
- 提供 MCP adapter 或 shell adapter。
- 让 agent 完成一次真实 feature：读 manifest、改代码、调用 action、失败后修复、replay 成功。

### Week 4

- 找 5-10 个重度使用 AI coding 的开发者试用。
- 看他们是否愿意在真实 repo 接入。
- 询问是否愿意付费或团队试用。

停止标准：

- 8 周内没人愿意在真实 repo 接入，停。
- 12 周内没人愿意付费或深度使用，重新定位。

## 13. 给下一个对话的提醒

- 不要把项目讲成 CI debugger。
- 不要把项目讲成普通测试框架。
- 不要做成纯 skill/prompt。
- 不要只做固定 MCP tools。
- 不要做完整 Claude Code 竞品。
- 第一版应该做自己的 CLI/runtime。
- 核心围绕 Action Discovery、Action Manifest、CLI Runtime、Structured Result、Replay、Agent Adapter。

## 14. 一句话终局

> 每个软件项目未来都不只需要 human UI 和 API，还需要一层 agent-native runtime。这个项目要做的，就是让 coding agent 能稳定理解、执行、验证真实业务流程，而不是靠读代码和猜 UI。
