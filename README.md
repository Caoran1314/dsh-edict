# dsh-edict ⚔️

**三省六部制多智能体审核流程，移植为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。**

[![npm version](https://img.shields.io/npm/v/dsh-edict?color=cb3837&label=npm)](https://www.npmjs.com/package/dsh-edict)
[![license](https://img.shields.io/npm/l/dsh-edict?color=3fbf6f)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b8bf5)](https://github.com/deepseek-ai/deepseek-harness)

> 玩法来自 [**cft0808/edict**](https://github.com/cft0808/edict)（MIT，★16k+）：用 1300 年前的三省六部制重新设计多 Agent 协作。
> 本插件是它**审核流程逻辑的忠实移植**——状态机、封驳规则、高风险确认、越权矩阵、委派防死锁、审计留痕，逐条对齐。
>
> ```
> 你(皇上) → 太子(分拣) → 中书省(规划) → 门下省(审议·可封驳) → 尚书省(派发) → 六部(并行执行) → 回奏
> ```

---

## 为什么要有这个移植

| | 原版 edict | **dsh-edict** |
|---|---|---|
| 宿主 | OpenClaw（必装） | **DeepSeek Harness** |
| 语言/依赖 | Python 3.9+ / FastAPI / Postgres 可选 | **纯 Node，零依赖** |
| 安装 | `install.sh` / Docker / 注册 agent 到 `openclaw.json` | **`dsh plugin add dsh-edict`** |
| 数据 | kanban JSON / Postgres | `~/.dsh/edict/`（JSON，原子写） |
| 多 Agent 从哪来 | OpenClaw 的 11 个 agent 进程 | **DSH 子代理 / 你自己扮演衙门** |
| 审核规则 | 见下 | **逐条一致**（有测试证明） |

---

## 规则（与 edict 逐条对齐）

### 12 状态状态机

```
Pending → Taizi → Zhongshu → Menxia → Assigned → Next/Doing → Review → Done
终态：Done / Cancelled（无出边）
```

完整合法转换表：

| 状态 | 可转到 |
|---|---|
| `Pending` | Taizi, Cancelled |
| `Taizi` | Zhongshu, Cancelled |
| `Zhongshu` | Menxia, Cancelled, Blocked |
| **`Menxia`** | Assigned, **Zhongshu（封驳打回）**, Cancelled |
| `Assigned` | Doing, Next, Cancelled, Blocked |
| `Next` | Doing, Cancelled, Blocked |
| `Doing` | Review, Done, Blocked, Cancelled |
| `Review` | Done, **Menxia（复审）**, Doing, Cancelled, PendingConfirm |
| `PendingConfirm` | Done, Review, Cancelled |
| `Blocked` | Taizi, Zhongshu, Menxia, Assigned, Next, Doing, Review, Cancelled |

**非法转换一律拒绝**，并写 `state_rejected` 审计。

### 高风险操作要确认（拦在 PendingConfirm）

| 转换 | 确认方 |
|---|---|
| `Review → Done`（完结任务） | **menxia**（门下省） |
| `Doing → Cancelled`（执行中取消） | **shangshu**（尚书省） |
| `Menxia → Cancelled`（审核中取消） | **zhongshu**（中书省） |

不直接生效：先落 `PendingConfirm`，由确认方 `approve`（落到目标状态）或 `reject`（**退回 Review 复审**）。

### 硬校验

- **`done` 前置**：当前状态必须是 `Doing`/`Next`，且 **todos 全部完成**，否则拒绝（"todos 未完成（1/2），禁止直接收口"）
- **单一 in-progress**：同一任务同时最多 1 个 `in-progress` todo
- **委派防死锁**：深度 ≤ 3，**路径成环直接拒绝**
- **委派权限链**：太子→中书省；中书省→门下省/尚书省；尚书省→六部；六部→只能回报尚书省
- **标题校验**：长度 ≥6 且不能是闲聊词（`好`/`收到`/`测试`…）
- **越权矩阵**：六部不能改状态，门下省不能 create……（11 个角色的命令白名单）

### 审计

每条动作都落 `~/.dsh/edict/audit_log.json`（保留最近 5000 条），含 `ts / task / agent / action / from / to / reason`。拒绝也留痕。

---

## 安装

**从 npm 装**（推荐，一行）：

```bash
dsh plugin --profile desktop add dsh-edict
```

**从 GitHub 装**（想跟最新提交，或 npm 不可用时）：

```bash
dsh plugin --profile desktop add github:Caoran1314/dsh-edict
```

**本地开发**（改代码即时生效，无需重装）：

```bash
dsh plugin --profile desktop add link:D:\path\to\dsh-edict
```

装完重启 DSH。数据目录 `~/.dsh/edict/`。

> `--profile` 填你实际在用的那个：桌面客户端用 `desktop`，`dsh web` 用 `web`。

## 提供的工具

| 工具 | 对应衙门/命令 | 说明 |
|---|---|---|
| `edict_create` | 皇上/太子 `create` | 下旨建任务 |
| `edict_move` | 三省 `state` | 状态流转（含合法性与高风险拦截） |
| `edict_flow` | 各省 `flow` | 部门间流转留痕 |
| `edict_progress` | 六部/各省 `progress` | 实时进展 + `✅/🔄` 清单同步 todos |
| `edict_todo` | 六部 `todo` | 子任务（单一 in-progress） |
| `edict_done` | 六部 `done` | 回报完成 → Review（前置硬校验） |
| `edict_block` | 六部 `block` | 标记阻塞 |
| `edict_confirm` | 门下/尚书 `confirm` | 批准 / 驳回高风险操作 |
| `edict_delegate` | 中书/尚书 `delegate` | 委派（深度+循环+权限链校验） |
| `edict_delegate_result` | 六部 `delegate-result` | 回写子任务结果 |
| `edict_memory` | 全部 `memory` | 衙门记忆（上限 200，pinned 优先） |
| `edict_task_memo` | 全部 `task-memo` | 任务级决策/警示备忘 |
| `edict_shared_memo` | 尚书 `shared-memo` | 全局共享备忘 |
| `edict_status` | 只读 | 军机处看板：各状态数量 / 任务详情 / 流转链 / 待确认项 |
| `edict_role` | — | 设置当前衙门身份（越权矩阵据此生效） |

命令（无 UI 界面时用）：`edict`（看板）、`edict-audit`（审计）、`edict-reset-role`。

### 身份如何确定

越权矩阵需要一个"当前是谁"。DSH 的子代理没有独立环境变量（不像 OpenClaw 的 `OPENCLAW_AGENT_ID`），所以推断链是：

```
工具参数 agent  →  EDICT_AGENT_ID 环境变量  →  ~/.dsh/edict/current_role  →  默认 taizi
```

**子代理开工前先调 `edict_role` 设定身份**，之后再调 `edict_*`，越权矩阵才按你的身份生效。

---

## 用法示例

```
你：用三省六部流程做「把首页加载时间降到 1 秒以内」

1. edict_create(title:"把首页加载时间降到 1 秒以内")        → Pending
2. edict_role(role:"taizi") + edict_move(state:"Taizi")      → 太子分拣
3. edict_role(role:"zhongshu") + edict_move(state:"Zhongshu")→ 中书省规划
4. edict_todo ×N（拆子任务）+ edict_move(state:"Menxia")     → 交门下省审议
5. edict_role(role:"menxia")
   - 不通过 → edict_move(state:"Zhongshu", now:"封驳：缺少回滚方案")
   - 通过   → edict_move(state:"Assigned")
6. edict_role(role:"shangshu") + edict_move(state:"Doing")
   + edict_delegate(to:"hubu", instruction:"…")              → 派发给六部
7. edict_role(role:"hubu") + edict_progress / edict_todo / edict_done
8. edict_role(role:"shangshu") + edict_move(state:"Done")
   → 落 PendingConfirm，edict_role(role:"menxia") + edict_confirm(action:"approve") → Done
```

---

## 与本移植的差异（诚实清单）

规则一致，适配层有三处必然差异，另有两处**实现层差异**（语言/内部一致性问题，非规则改动）：

| 项 | 原版 edict | 本移植 | 性质 |
|---|---|---|---|
| 身份来源 | `OPENCLAW_AGENT_ID` 等环境变量 | 同上 + 工具参数 + 角色文件 | 适配（DSH 无 per-subagent env） |
| 存储 | kanban JSON / Postgres 双写 | `~/.dsh/edict/` JSON 原子写 | 适配 |
| 多 Agent | 11 个 OpenClaw agent 进程 | DSH 子代理 / 人工扮演 | 适配 |
| todos 清单解析 | Python `item[:-1]`（按码位） | `Array.from` 后删末位（按码位） | **语言差异**：JS 里 `slice(0,-1)` 会切断 emoji 代理对，故必须按码位处理 |
| `progress` 替换 todos 后 | 不重算 `ready_to_close`（`cmd_todo` 才置位） | **重算**，保持标记与 todos 一致 | 实现增强（上游内部不一致） |

> 另：垃圾词比较**刻意保持上游行为**——上游 `if t in _JUNK_TITLES` 是集合精确匹配、不忽略大小写，
> 因此 `'OK'`/`'Yes'` 这类大小写变体不会被拦。本移植没有"顺手修好"它，以对齐上游。

## 测试

```bash
node test/edict.test.mjs
```

28 项，覆盖：状态机守卫（**移植自 edict 的 `tests/test_state_machine_consistency.py`**，期望表逐字抄自上游 `task.py`）、高风险确认、封驳路径、done 前置、单一 in-progress、委派深度/循环/权限链、越权矩阵、审计结构、文本清洗。

## 路线图

- [ ] 军机处看板 UI（`dsh.client` 浏览器半侧 + HTTP API），对齐 edict 的 10 个面板
- [ ] 奏折阁：已完成旨意自动归档为 Markdown
- [ ] 旨库：预设圣旨模板
- [ ] 官员总览：Token/耗时排行（`progress` 已在记 tokens/cost/elapsed）

## 许可与署名

MIT。审核流程设计来自 [cft0808/edict](https://github.com/cft0808/edict)（MIT），本移植保留其规则语义并注明出处；实现代码为本项目独立编写。
