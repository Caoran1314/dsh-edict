# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.8] — 2026-10-14

### 修复

- **独立看板打开是 403 "拒绝访问"**。根因是**我用错了栅栏**：
  `connection.requestRejection` 内含 **login-token cookie 校验**（见 dsh-schedule 源码注释），
  而浏览器**新标签页的顶层导航不会自动带 cookie** —— 拿它当"拒绝外部访问"的栅栏，
  必然把用户自己堵在 403。
  现在区分对待：
  - **页面路由 `/edict`**：放行顶层导航（无 Origin 头），只拒**跨站 fetch**（有 Origin 且与 Host 不符）
  - **数据路由**（`/edict/board` / `audit` / `task`）：保留 `requestRejection` 栅栏
- 独立看板改为**服务端渲染**：看板数据与最近审计**直接内嵌进 HTML**，页面首次打开即可用，
  不再依赖凭据去 fetch。若能带凭据过栅栏，再自动切换为 3 秒实时刷新（页头会显示"内嵌快照 / 实时"）。

### 状态码速查（写给以后的自己）

| 状态码 | 含义 |
|---|---|
| **401** | 路由**不存在**（被 DSH 通用认证中间件拦，响应体为空） |
| **403** | 路由**存在**，是插件自己的栅栏拒绝了该请求 |

## [0.1.7] — 2026-10-14

### 修复

- **工具调用报 `returned invalid output: value is not lossless JSON`**。
  任务对象的可选字段（如 `active[].org`、`now`、`remark`）常为 `undefined`，
  而宿主对工具返回值做 **lossless JSON** 校验，遇到 `undefined` 直接判为非法（`JSON.stringify` 会静默丢弃，
  所以本地自测发现不了）。
  新增 `toLossless()` 深度清洗：剥掉 `undefined`（字段整体删除）、`function`/`symbol` → `null`、
  `bigint` → 字符串、`Date` → ISO、`Buffer` → utf8、`NaN`/`Infinity` → `null`、检测循环引用。
  在 `execute` 出口与 `render` 两处生效。

> 这个缺陷是**作者自己调用工具时发现的** —— 说明"发布后真用一遍"比任何自测都重要。

## [0.1.6] — 2026-10-14

### 修复

- `/edict/url` 用错了 `connection.authenticatedUrl` 的签名。真实签名（从 `dsh-host-frontend-static` 挖出）是
  传**完整 base URL** 并返回带凭据的 URL 字符串：
  `js
  ctx.connection.authenticatedUrl( + "http://127.0.0.1:" + )
  `
  旧代码按 `(req, path)` 调用，必然拿不到结果。现在改为：取 `webServer.port`/Host 头拼 base URL →
  交给 `authenticatedUrl` → 用 `URL` 解析后把 pathname 换成 `/edict`、**保留其附带的凭据查询串**。

## [0.1.5] — 2026-10-14

### 修复

- **`last-load.json` 会被测试污染**：`writeLoadMarker` 之前总是写 `resolveDataDir()`（默认 `~/.dsh/edict`），
  而测试里 `apply({ dataDir: tmp })` 用的是临时目录 —— 结果**测试跑一次就把真实环境的加载标记覆盖成假的**，
  让人误判"插件已按新版本加载"。现在标记写入 `store.dir`（即 `config.dataDir`）。
- 排查提示：该文件是**加载证据**，怀疑它不实时先确认它是谁写的。

## [0.1.4] — 2026-10-14

### 新增

- 新路由 `GET /edict/url`：由宿主用 `connection.authenticatedUrl` 生成**带浏览器凭据的看板地址**。
  独立看板打不开的最后一环就在这：`window.open('/edict')` 是**新标签页的顶层导航**，
  不会自带 DSH 的浏览器凭据，因此被认证中间件拦成裸 401。
- 设置页面板的「打开独立看板」改为先取 `/edict/url` 再打开；拿不到凭据地址时给出明确提示
  （看板本身已内嵌在面板里，可直接查看）。

> 说明：0.1.3 已修好「路由根本未注册」的问题（`last-load.json` 显示 `routes: 4`）。
> 0.1.4 解决的是"路由注册了、但新标签页打不开"的凭据问题。

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
