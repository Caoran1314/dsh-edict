# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] — 2026-10-14

### 修复（严重）

- **15 个工具全部注册失败、看板路由全部未注册**（表现：独立看板返回裸 401、`edict_*` 工具不存在）。
  两个独立原因，都源于与宿主服务时序的假设错误：
  1. 工具**缺少必需的 `output { schema, render }`** —— 宿主 `tools.register()` 会抛出
     `tool "x" must declare output { schema, render, presentationMeta? }`，
     而该异常被**静默吞掉**，完全没有报错。现已统一由 `withOutput()` 补齐。
  2. `apply()` 执行时 `tools` / `webServer` 服务**尚未就绪**，旧代码取不到就永久放弃。
     现改为监听 `internal/service` 事件 + 1.5 秒定时重试双保险。
- `edict_role` 之前用错误的 store 实例（模块变量未在 apply 中赋值），导致角色文件写不到配置的数据目录。

### 新增

- `~/.dsh/edict/last-load.json`：记录每次加载的 `tools` / `routes` 数量，便于区分
  "插件没加载" 与 "加载了但没注册"。
- 冒烟测试新增 3 条回归守卫：每个工具必须有 `output { schema, render }` 与 `execute`；
  4 条看板路由必须注册；**服务晚到时必须能补注册**。
- 冒烟测试的 mock 宿主改为符合真实契约（`ctx.get('tools')` + `ctx.effect` + `internal/service` 事件）。

## [0.1.2] — 2026-10-13

### 修复（致命）

- **`package.json` 的 `exports` 缺少 `"./client"`**，而 `dsh.client` 已声明。
  DSH 启动时 `ClientModuleRegistry` 会抛：

  ```
  dsh-edict declares dsh.client but exports no "./client" bundle
  ```

  这会导致 **整个 app 启动失败**，并触发 DSH 的自愈逻辑把 profile 里**所有插件层清空**。
  0.1.0 与 0.1.1 都带此缺陷，**请勿使用，直接用 0.1.2 及以上**。

### 新增

- `test/smoke.mjs` 增加**回归守卫**：校验 `dsh.client` 与 `exports["./client"]` 配套、
  目标文件存在、且 client bundle 的 `ModuleLoader` 注册 id 等于包名。

## [0.1.1] — 2026-10-13

### 变更

- 版本号从 0.1.0 提升（npm 首次发布被转成 staged publish，`latest` 标签一度被占位版本占用）。

> ⚠️ 0.1.1 与 0.1.0 一样带有 `exports` 缺少 `"./client"` 的致命缺陷，**不要使用**。

## [0.1.0] — 2026-10-13

首个版本：把 [edict](https://github.com/cft0808/edict)（OpenClaw 三省六部制多智能体编排）的**审核流程逻辑**移植为 DeepSeek Harness 插件。

### 新增

- **12 状态状态机**，转换表与上游 `task.py` 的 `STATE_TRANSITIONS` 逐条对齐；终态 `{Done, Cancelled}` 无出边
- **门下省封驳**：`Menxia → Zhongshu` 打回重做；`confirm reject` 退回 `Review` 复审
- **高风险操作确认**：`Review→Done`(menxia)、`Doing→Cancelled`(shangshu)、`Menxia→Cancelled`(zhongshu) 先落 `PendingConfirm`
- **越权矩阵**：11 个衙门角色的命令白名单（六部不能改状态、门下省不能 create 等）
- **`done` 前置硬校验**：状态须为 `Doing/Next` 且 todos 全部完成
- **单一 in-progress 约束**：同一任务同时最多 1 个进行中 todo
- **委派防死锁**：深度上限 3、路径成环拒绝、权限链（`agents.json` 的 `allowAgents`）
- **审计留痕**：`ts/task/agent/action/from/to/reason`，上限 5000 条，拒绝也记录
- **15 个工具**：`edict_create/move/flow/progress/todo/done/block/confirm/delegate/delegate_result/memory/task_memo/shared_memo/status/role`
- **3 个命令**：`edict`（看板）、`edict-audit`（审计）、`edict-reset-role`
- **军机处看板 UI**：设置页「三省六部」面板 + 独立看板页 `/edict`（3 秒自动刷新、任务详情可展开）
- **零依赖**：只用 Node 内置模块；数据存 `~/.dsh/edict/`，原子写 + 跨进程锁

### 相比上游的行为增强

| 项 | 上游 | 本版 | 原因 |
|---|---|---|---|
| `progress` 替换 todos 后 | 不重算 `ready_to_close` | 重算，保持标记与 todos 一致 | 上游内部不一致 |
| todos 清单解析 | `item[:-1]` 截断 | 按码位删除 | emoji 是代理对，JS 里 `slice(0,-1)` 会留半个字符 |

### 测试

- 28 项单元测试（`node test/edict.test.mjs`），含从上游 `test_state_machine_consistency.py` 移植的状态机守卫
- 冒烟测试（`node test/smoke.mjs`）：mock ctx 加载插件，跑通完整旨意（封驳 → 拒绝未完成收口 → 高风险确认 → 越权拦截）

### 已知限制

- 身份推断依赖工具参数 / `EDICT_AGENT_ID` / `~/.dsh/edict/current_role`；DSH 子代理没有独立环境变量，需先调 `edict_role`
- 看板 UI 需要 profile 提供 `webServer`（桌面端若走 `file:// + IPC` 则只有工具、没有看板）
- 尚未实现：奏折归档为 Markdown、旨库模板、官员 Token 排行
