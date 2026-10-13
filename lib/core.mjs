/**
 * dsh-edict — 三省六部任务状态机（核心逻辑）
 * ----------------------------------------------------------------------------
 * 本文件是 edict（https://github.com/cft0808/edict，MIT）审核流程的忠实移植：
 * 状态集合、合法转换表、高风险确认、封驳回环、收口前置校验、单一 in-progress
 * 约束、委派深度与循环检测、越权矩阵、审计日志——全部按原实现对齐。
 *
 * 与原实现的差异（仅适配层，不动规则）：
 *   - 原版用 OPENCLAW_AGENT_ID 等环境变量推断当前 Agent；本移植改为在每次调用
 *     的上下文里显式给出 agent（DSH 工具按角色拆开，结构性保证身份正确）。
 *     仍支持 EDICT_AGENT_ID 环境变量覆盖，语义与原版 _infer_agent_id_from_runtime 一致。
 *   - 原版把状态写入 kanban JSON / Postgres；本移植写入 ~/.dsh/edict/。
 *
 * 零依赖：只用 node 内置模块。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/* ── 状态枚举（对齐 task.py TaskState）───────────────────────────────── */
export const TaskState = Object.freeze({
  Taizi: 'Taizi',
  Zhongshu: 'Zhongshu',
  Menxia: 'Menxia',
  Assigned: 'Assigned',
  Next: 'Next',
  Doing: 'Doing',
  Review: 'Review',
  Done: 'Done',
  Blocked: 'Blocked',
  Cancelled: 'Cancelled',
  Pending: 'Pending',
  PendingConfirm: 'PendingConfirm'
})

export const ALL_STATES = Object.freeze(Object.values(TaskState))
export const TERMINAL_STATES = Object.freeze([TaskState.Done, TaskState.Cancelled])

/**
 * 合法状态转换表 —— 与 task.py STATE_TRANSITIONS 逐条对齐。
 * 注意 `Done` / `Cancelled` 在 Python 侧只出现在 TERMINAL_STATES，
 * 未列为键；此处显式给出空集合，等价于"无出边"，并让查表更直白。
 */
export const STATE_TRANSITIONS = Object.freeze({
  Pending: Object.freeze(['Taizi', 'Cancelled']),
  Taizi: Object.freeze(['Zhongshu', 'Cancelled']),
  Zhongshu: Object.freeze(['Menxia', 'Cancelled', 'Blocked']),
  Menxia: Object.freeze(['Assigned', 'Zhongshu', 'Cancelled']),
  Assigned: Object.freeze(['Doing', 'Next', 'Cancelled', 'Blocked']),
  Next: Object.freeze(['Doing', 'Cancelled', 'Blocked']),
  Doing: Object.freeze(['Review', 'Done', 'Blocked', 'Cancelled']),
  Review: Object.freeze(['Done', 'Menxia', 'Doing', 'Cancelled', 'PendingConfirm']),
  PendingConfirm: Object.freeze(['Done', 'Review', 'Cancelled']),
  Blocked: Object.freeze(['Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing', 'Review', 'Cancelled']),
  Done: Object.freeze([]),
  Cancelled: Object.freeze([])
})

/** 状态 → 负责部门（STATE_AGENT_MAP） */
export const STATE_AGENT_MAP = Object.freeze({
  Taizi: 'taizi',
  Zhongshu: 'zhongshu',
  Menxia: 'menxia',
  Assigned: 'shangshu',
  Review: 'shangshu',
  PendingConfirm: 'shangshu',
  Pending: 'zhongshu'
})

/** 状态 → 部门显示名（STATE_ORG_MAP） */
export const STATE_ORG_MAP = Object.freeze({
  Taizi: '太子',
  Zhongshu: '中书省',
  Menxia: '门下省',
  Assigned: '尚书省',
  Review: '尚书省',
  PendingConfirm: '尚书省',
  Pending: '中书省'
})

/** 六部 → agent id（ORG_AGENT_MAP） */
export const ORG_AGENT_MAP = Object.freeze({
  户部: 'hubu',
  礼部: 'libu',
  兵部: 'bingbu',
  刑部: 'xingbu',
  工部: 'gongbu',
  吏部: 'libu_hr'
})

/**
 * 高风险转换 —— 不直接生效，先落到 PendingConfirm 等确认。
 * 对齐 HIGH_RISK_TRANSITIONS。
 */
export const HIGH_RISK_TRANSITIONS = Object.freeze([
  Object.freeze(['Review', 'Done']),      // 完结任务 — 需门下省确认
  Object.freeze(['Doing', 'Cancelled']),  // 执行中取消 — 需尚书省确认
  Object.freeze(['Menxia', 'Cancelled'])  // 审核中取消 — 需中书省确认
])

/** 各状态的确认权限方（CONFIRM_AUTHORITY） */
export const CONFIRM_AUTHORITY = Object.freeze({
  Review: 'menxia',
  Doing: 'shangshu',
  Menxia: 'zhongshu'
})

/** 越权矩阵（AGENT_POLICY） */
export const AGENT_POLICY = Object.freeze({
  taizi: Object.freeze({ role: 'coordination', commands: Object.freeze(['create', 'state', 'flow', 'progress', 'todo', 'memory', 'task-memo']) }),
  zhongshu: Object.freeze({ role: 'coordination', commands: Object.freeze(['state', 'flow', 'progress', 'todo', 'memory', 'task-memo', 'delegate']) }),
  menxia: Object.freeze({ role: 'coordination', commands: Object.freeze(['state', 'flow', 'progress', 'todo', 'confirm', 'memory', 'task-memo']) }),
  shangshu: Object.freeze({ role: 'coordination', commands: Object.freeze(['state', 'flow', 'progress', 'todo', 'confirm', 'delegate', 'memory', 'task-memo', 'shared-memo']) }),
  zaochao: Object.freeze({ role: 'coordination', commands: Object.freeze(['progress', 'todo', 'memory']) }),
  hubu: Object.freeze({ role: 'execution', commands: Object.freeze(['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result']) }),
  libu: Object.freeze({ role: 'execution', commands: Object.freeze(['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result']) }),
  bingbu: Object.freeze({ role: 'execution', commands: Object.freeze(['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result']) }),
  xingbu: Object.freeze({ role: 'execution', commands: Object.freeze(['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result']) }),
  gongbu: Object.freeze({ role: 'execution', commands: Object.freeze(['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result']) }),
  libu_hr: Object.freeze({ role: 'execution', commands: Object.freeze(['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result']) })
})

/** 委派权限链（agents.json subagents.allowAgents） */
export const DELEGATION_MATRIX = Object.freeze({
  taizi: Object.freeze(['zhongshu']),
  zhongshu: Object.freeze(['menxia', 'shangshu']),
  menxia: Object.freeze(['shangshu', 'zhongshu']),
  shangshu: Object.freeze(['zhongshu', 'menxia', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr']),
  hubu: Object.freeze(['shangshu']),
  libu: Object.freeze(['shangshu']),
  bingbu: Object.freeze(['shangshu']),
  xingbu: Object.freeze(['shangshu']),
  gongbu: Object.freeze(['shangshu']),
  libu_hr: Object.freeze(['shangshu']),
  zaochao: Object.freeze([])
})

export const AGENT_LABELS = Object.freeze({
  taizi: '太子', zhongshu: '中书省', menxia: '门下省', shangshu: '尚书省',
  hubu: '户部', libu: '礼部', bingbu: '兵部', xingbu: '刑部', gongbu: '工部',
  libu_hr: '吏部', zaochao: '早朝官'
})

/* ── 上限常量 ─────────────────────────────────────────────────────── */
export const MAX_PROGRESS_LOG = 100
export const MAX_AUDIT_LOG = 5000
export const MAX_AGENT_MEMORIES = 200
export const MAX_DELEGATION_DEPTH = 3
export const MIN_TITLE_LEN = 6

/** 垃圾标题黑名单（_JUNK_TITLES，逐字对齐） */
export const JUNK_TITLES = Object.freeze(new Set([
  '?', '？', '好', '好的', '是', '否', '不', '不是', '对', '了解', '收到',
  '嗯', '哦', '知道了', '开启了么', '可以', '不行', '行', 'ok', 'yes', 'no',
  '你去开启', '测试', '试试', '看看'
]))

/* ── 工具函数 ─────────────────────────────────────────────────────── */
export function nowIso(now = new Date()) {
  return now.toISOString()
}

function shortUuid() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6)
}

/**
 * 文本清洗（_sanitize_text 的等价实现）：
 * 剥离 Conversation 元数据、代码块、文件路径、URL、传旨前缀、系统字段，并截断。
 */
export function sanitizeText(raw, maxLen = 80) {
  let t = String(raw ?? '').trim()
  t = t.split(/\n*Conversation\b/)[0].trim()
  t = t.split(/\n*```/)[0].trim()
  t = t.replace(/[/\\.~][A-Za-z0-9_\-./]+(?:\.(?:py|js|ts|json|md|sh|yaml|yml|txt|csv|html|css|log))?/g, '')
  t = t.replace(/https?:\/\/\S+/g, '')
  t = t.replace(/^(传旨|下旨)([（(][^)）]*[)）])?[：:\uff1a]\s*/, '')
  t = t.replace(/(message_id|session_id|chat_id|open_id|user_id|tenant_key)\s*[:=]\s*\S+/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > maxLen) t = t.slice(0, maxLen) + '…'
  return t
}

export const sanitizeTitle = (raw) => sanitizeText(raw, 80)
export const sanitizeRemark = (raw) => sanitizeText(raw, 120)

/** 标题有效性（_is_valid_task_title） */
export function isValidTaskTitle(raw) {
  const t = String(raw ?? '').trim()
  if (t.length < MIN_TITLE_LEN) return false
  if (JUNK_TITLES.has(t.toLowerCase())) return false
  return true
}

/** todo 完成度（_todo_counts） */
export function todoCounts(task) {
  const todos = task?.todos ?? []
  const total = todos.length
  const completed = todos.filter((td) => td?.status === 'completed').length
  return { completed, total }
}

/** 转换是否合法 */
export function isTransitionAllowed(from, to) {
  const allowed = STATE_TRANSITIONS[from]
  if (allowed === undefined) return { ok: false, reason: `未知状态 ${from}` }
  if (!allowed.includes(to)) {
    return { ok: false, reason: `非法状态转换 ${from} → ${to}（允许: ${allowed.join(', ') || '无'}）` }
  }
  return { ok: true }
}

/** 是否高风险转换（需确认） */
export function highRiskAuthority(from, to) {
  const hit = HIGH_RISK_TRANSITIONS.some(([a, b]) => a === from && b === to)
  if (!hit) return null
  return CONFIRM_AUTHORITY[from] ?? 'shangshu'
}

/** 越权检查：返回 null 表示放行，否则返回拒绝原因 */
export function checkPermission(agentId, cmd) {
  if (!agentId) return null                     // 无法推断身份时不拦截（对齐原版）
  const policy = AGENT_POLICY[agentId]
  if (!policy) return null                      // 未注册的 Agent 不拦截（向前兼容）
  if (!policy.commands.includes(cmd)) {
    return `${agentId} 越权执行 ${cmd}（允许: ${policy.commands.join(', ')}）`
  }
  return null
}

/** 委派是否允许（深度 + 循环 + 权限链） */
export function checkDelegation(fromAgent, toAgent, parentDelegation) {
  const depth = parentDelegation ? (parentDelegation.delegation_depth ?? 0) + 1 : 1
  const path_ = parentDelegation ? [...(parentDelegation.delegation_path ?? [fromAgent])] : [fromAgent]
  path_.push(toAgent)

  if (depth > MAX_DELEGATION_DEPTH) {
    return { ok: false, kind: 'depth', depth, path: path_, reason: `委派深度超限 (${depth} > ${MAX_DELEGATION_DEPTH})，拒绝委派` }
  }
  if (path_.slice(0, -1).includes(toAgent)) {
    return { ok: false, kind: 'circular', depth, path: path_, reason: `检测到循环委派 (${path_.join(' → ')})，拒绝` }
  }
  return { ok: true, depth, path: path_ }
}

/* ── 数据存储层 ───────────────────────────────────────────────────── */
export function resolveDataDir(opts = {}) {
  const home = opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return opts.dataDir || path.join(home, 'edict')
}

export class EdictStore {
  constructor(opts = {}) {
    this.dir = resolveDataDir(opts)
    this.tasksFile = path.join(this.dir, 'tasks.json')
    this.auditFile = path.join(this.dir, 'audit_log.json')
    this.memoryFile = path.join(this.dir, 'agent_memory.json')
    this.memoFile = path.join(this.dir, 'shared_memo.json')
    this.lockFile = path.join(this.dir, '.lock')
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /** 原子写：临时文件 + rename */
  writeJsonAtomic(file, value) {
    this.ensureDir()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? fallback : parsed
    } catch {
      return fallback
    }
  }

  /**
   * 串行化读改写。原版靠 atomic_json_update 保证原子性；这里用进程内队列 +
   * 一个跨进程锁文件（O_EXCL 创建），保证 DSH 多子代理并发时不写坏数据。
   */
  update(file, modifier, fallback) {
    const run = () => {
      const release = this.acquireLock()
      try {
        const current = this.readJson(file, fallback)
        const next = modifier(current)
        this.writeJsonAtomic(file, next === undefined ? current : next)
        return next === undefined ? current : next
      } finally {
        release()
      }
    }
    const prev = this.queue ?? Promise.resolve()
    const next = prev.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  acquireLock() {
    this.ensureDir()
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx')
        fs.writeSync(fd, String(process.pid))
        return () => {
          try { fs.closeSync(fd) } catch {}
          try { fs.unlinkSync(this.lockFile) } catch {}
        }
      } catch (err) {
        if (Date.now() > deadline) {
          // 超时则强制接管（避免死锁阻塞用户），并留下痕迹
          try { fs.unlinkSync(this.lockFile) } catch {}
          continue
        }
        // 同步等待一小会儿（保持 API 同步以简化调用方）
        const until = Date.now() + 25
        while (Date.now() < until) { /* spin */ }
      }
    }
  }

  /* ── tasks ── */
  listTasks() { return this.readJson(this.tasksFile, []) }
  getTask(id) { return this.listTasks().find((t) => t?.id === id) ?? null }
  updateTasks(modifier) { return this.update(this.tasksFile, modifier, []) }

  /* ── audit ──
     审计按"立即留痕"语义实现为同步读改写：调用方（命令层）在拒绝路径上要能
     紧接着读到刚写的记录，异步队列会漏。任务文件仍走队列 + 跨进程锁。 */
  appendAudit(entry) {
    this.ensureDir()
    let logs = this.readJson(this.auditFile, [])
    if (!Array.isArray(logs)) logs = []
    logs.push(entry)
    if (logs.length > MAX_AUDIT_LOG) logs = logs.slice(-MAX_AUDIT_LOG)
    const tmp = `${this.auditFile}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(logs, null, 2), 'utf8')
    fs.renameSync(tmp, this.auditFile)
    return logs
  }

  listAudit(limit = 50, taskId = null) {
    const logs = this.readJson(this.auditFile, [])
    const filtered = taskId ? logs.filter((l) => l?.task === taskId) : logs
    return filtered.slice(-limit)
  }

  /* ── memory / memo ── */
  readMemories() { return this.readJson(this.memoryFile, {}) }
  readMemo() { return this.readJson(this.memoFile, []) }
}
