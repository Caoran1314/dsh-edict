# 发布宣传草稿

用于发到各社区。按平台改一改就能用。**末尾的链接统一用**：https://github.com/Caoran1314/dsh-edict

---

## 1. DeepSeek Harness Discussions（英文帖，发在 Show and tell / Plugins 分类）

**Title**: `[Plugin] dsh-edict — Three Departments & Six Ministries review pipeline for DSH (ported from edict)`

**Body**:

```
I ported the review workflow of edict (the "Three Departments & Six Ministries" multi-agent
orchestrator, ~17k stars, OpenClaw ecosystem) into a native DeepSeek Harness plugin.

What it gives you: an enforced review gate between planning and execution, with a real
state machine, audit trail, and permission matrix — no OpenClaw or Python required.

Repo: https://github.com/Caoran1314/dsh-edict

## The rules (aligned line-by-line with upstream edict)

- 12-state machine — transition table matches upstream `task.py` STATE_TRANSITIONS
- Menxia (Chancellery) rejection loop — `Menxia → Zhongshu` sends the plan back for rework;
  `confirm reject` returns to `Review`
- High-risk transitions are gated: `Review→Done` (menxia), `Doing→Cancelled` (shangshu),
  `Menxia→Cancelled` (zhongshu) land in `PendingConfirm` first
- Authority matrix — 11 role-based command allowlists (the six ministries cannot change state)
- `done` preconditions — state must be `Doing/Next` and all todos completed
- Single in-progress todo per task
- Delegation guard — depth ≤ 3, cycle detection, delegation permission chain
- Audit trail — ts/task/agent/action/from/to/reason, 5000-entry cap, rejections recorded too

## What you get in DSH

- 15 tools (`edict_create` … `edict_status`, plus `edict_role` to set your office)
- 3 commands (`edict` board, `edict-audit`, `edict-reset-role`)
- War Room board UI — a settings panel and a standalone `/edict` page
- Zero dependencies — Node built-ins only; data in `~/.dsh/edict/`, atomic writes + cross-process lock

## Install

    dsh plugin --profile desktop add dsh-edict

## Tests

- 28 unit tests, including the state-machine guards ported from upstream's
  `test_state_machine_consistency.py`
- Smoke test loads the plugin with a mock ctx and runs a full edict
  (rejection → blocked closure → high-risk confirm → authority denial)

## Notes

Two deliberate behavior improvements over upstream are documented in the README
(`ready_to_close` recalculation after `progress`, and code-point-safe emoji parsing).

Design credit: cft0808/edict (MIT). This port keeps the rule semantics and credits the source;
the implementation is independent.
```

---

## 2. edict 上游致谢（发在 github.com/cft0808/edict 的 Discussions，或作为 issue）

**Title**: `DSH 侧移植：把三省六部审核流程做成了 DeepSeek Harness 插件`

**Body**:

```
先感谢作者和社区——三省六部这套「制度性审核」的设计（门下省专职封驳、状态流转强校验、
权限矩阵白纸黑字）确实比"做完就交"的框架靠谱，所以我把它移植到了另一个宿主上。

项目：https://github.com/Caoran1314/dsh-edict

## 做了什么

把 edict 的**审核流程逻辑**（不是 UI，也不是 agent 编排层）移植成 DeepSeek Harness 插件：

- 12 状态状态机：转换表逐条对齐 `edict/backend/app/models/task.py` 的 `STATE_TRANSITIONS`
- 高风险转换拦截：`HIGH_RISK_TRANSITIONS` 与 `CONFIRM_AUTHORITY` 原样沿用，
  先落 `PendingConfirm`，由对应衙门批准或驳回
- 越权矩阵：`kanban_update.py` 的 `AGENT_POLICY`（11 个角色的命令白名单）
- 收口前置校验：`cmd_done` 的「状态须 Doing/Next 且 todos 全完成」
- 单一 in-progress 约束、委派深度≤3 与循环检测、审计上限 5000
- 标题清洗与垃圾词黑名单（`_sanitize_text` / `_JUNK_TITLES`）

## 移植时发现的两处上游内部不一致（已在 README 记录）

1. `cmd_progress` 替换 todos 时不重算 `ready_to_close`，会让该标记失真
2. `_JUNK_TITLES` 的比较没有忽略大小写，`'OK'` 这类会被当作有效标题

（如果这两条是有意为之，请忽略；我只是照搬规则时发现的，供参考。）

## 与上游的必然差异（适配层，不动规则）

| 项 | 上游 | DSH 侧 |
|---|---|---|
| 身份来源 | `OPENCLAW_AGENT_ID` 环境变量 | 工具参数 / `EDICT_AGENT_ID` / 角色文件 |
| 存储 | kanban JSON / Postgres | `~/.dsh/edict/` JSON 原子写 |
| 多 Agent | OpenClaw 的 agent 进程 | DSH 子代理 |

MIT 许可见 LICENSE，已在 README 与 Release notes 中注明出处。如果作者希望我改署名方式
（例如加进你们的 README 集成列表、或改项目名），说一声我照办。
```

---

## 3. 中文社区（V2EX / 少数派 / 即刻 / 公众号）

**标题**：`我用 1300 年前的三省六部制，给 AI 加了一道"门下省"审核关`

**正文**：

```
AI 多智能体最大的坑不是不够聪明，是"做完就交"——没人检查产出质量。

有个项目叫 edict（三省六部），用唐代的制度架构重做了多 Agent 协作：
太子分拣 → 中书省规划 → **门下省审议（可以封驳打回）** → 尚书省派发 → 六部执行 → 回奏。
核心就是那个门下省：不是 warning，是直接打回重做。

它原本跑在 OpenClaw 上（要 Python + OpenClaw 网关）。我把它那套**审核逻辑**移植成了
DeepSeek Harness 插件，规则逐条对齐，现在装一行命令就能用：

    dsh plugin --profile desktop add dsh-edict

https://github.com/Caoran1314/dsh-edict

## 它到底管什么

- **12 状态状态机**：非法转换直接拒绝（比如不许从"待分拣"一步跳到"完成"）
- **封驳回环**：门下省不通过 → 打回中书省重做；确认被驳回 → 退回复审
- **高风险操作要确认**：完结任务、执行中取消、审核中取消，都要对应衙门点头
- **越权矩阵**：六部不能改状态、门下省不能下发旨意——白纸黑字
- **收口硬校验**：todo 没做完不许报"完成"
- **完整审计**：谁在什么时候把什么从哪改到哪、为什么，全留痕（连"被拒绝"都记）
- **军机处看板**：设置页有面板，也能开独立看板页看每张旨意的流转链

## 技术上的两个点

1. **零依赖**：只用 Node 内置模块，数据存 `~/.dsh/edict/`，原子写 + 跨进程锁
2. **有测试证明一致**：把上游的状态机守卫测试（`test_state_machine_consistency.py`）
   一起移植过来了，28 项单测 + 冒烟测试，转换表逐条比对

顺带修了上游两个内部不一致（`progress` 后不重算 `ready_to_close`、垃圾词比较没忽略大小写），
都写在 README 的"诚实清单"里。

设计来自 cft0808/edict（MIT），实现独立编写，出处已注明。
```

---

## 发布节奏建议

1. **先发 deepseek-harness Discussions**（第一波用户就在那儿）
2. 隔 1–2 天发 edict 上游致谢（顺便让 edict 的用户知道有 DSH 版本）
3. 中文社区放到最后，可以配那张状态机图

**配图用**：[docs/state-machine.svg](https://github.com/Caoran1314/dsh-edict/blob/main/docs/state-machine.svg)（GitHub 能直接渲染 SVG；中文社区建议先导出 PNG）
