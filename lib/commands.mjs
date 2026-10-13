/**
 * dsh-edict — 命令实现层
 * ----------------------------------------------------------------------------
 * 每个命令对应 kanban_update.py 里的一个 cmd_* 函数，行为逐条对齐：
 *   create / state / flow / progress / todo / done / block / confirm /
 *   delegate / delegate-result / memory / task-memo / shared-memo
 *
 * 所有命令统一返回 { ok, cmd, agent, ... }，被拒时 ok:false 并带 reason，
 * 同时写入审计（拒绝也要留痕，与原版一致）。
 */
import {
  TaskState, STATE_ORG_MAP, STATE_AGENT_MAP, AGENT_LABELS, ORG_AGENT_MAP,
  DELEGATION_MATRIX, MAX_PROGRESS_LOG, MAX_AGENT_MEMORIES,
  nowIso, sanitizeTitle, sanitizeRemark, isValidTaskTitle, todoCounts,
  isTransitionAllowed, highRiskAuthority, checkPermission, checkDelegation, MAX_DELEGATION_DEPTH
} from './core.mjs'

function newTaskId() {
  return 'oc-' + Math.random().toString(16).slice(2, 10)
}

function shortUuid() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6)
}

/** 统一的越权拦截：返回拒绝结果或 null */
function guard(store, agent, cmd) {
  const denied = checkPermission(agent, cmd)
  if (!denied) return null
  store.appendAudit({ ts: nowIso(), task: '', agent: agent ?? '', action: 'permission_denied', from: cmd, to: null, reason: denied })
  return { ok: false, cmd, agent, rejected: true, reason: denied, code: 'PERMISSION_DENIED' }
}

function audit(store, taskId, agent, action, from = null, to = null, reason = '') {
  store.appendAudit({ ts: nowIso(), task: taskId ?? '', agent: agent ?? '', action, from, to, reason })
}

/* ── create（下旨）─────────────────────────────────────────────────── */
export async function cmdCreate(store, params, agent) {
  const denied = guard(store, agent, 'create')
  if (denied) return denied

  const taskId = params.taskId || newTaskId()
  const title = sanitizeTitle(params.title)
  if (!isValidTaskTitle(title)) {
    const reason = `标题无效（长度需 ≥6 且不能是闲聊词）: ${JSON.stringify(title)}`
    audit(store, taskId, agent, 'create_rejected', null, null, reason)
    return { ok: false, cmd: 'create', agent, rejected: true, reason, code: 'INVALID_TITLE' }
  }

  const state = params.state || TaskState.Pending
  if (!Object.values(TaskState).includes(state)) {
    const reason = `未知状态 ${state}`
    audit(store, taskId, agent, 'create_rejected', null, null, reason)
    return { ok: false, cmd: 'create', agent, rejected: true, reason, code: 'UNKNOWN_STATE' }
  }

  const now = nowIso()
  let created = null
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    if (arr.some((t) => t?.id === taskId)) {
      created = { duplicate: true }
      return arr
    }
    const task = {
      id: taskId,
      title,
      state,
      org: params.org || STATE_ORG_MAP[state] || '',
      official: params.official || agent || '',
      remark: sanitizeRemark(params.remark || ''),
      createdAt: now,
      updatedAt: now,
      now: sanitizeRemark(params.remark || '') || '旨意已下，待太子分拣',
      flow_log: [{ at: now, from: '皇上', to: STATE_ORG_MAP[state] || state, remark: '下旨' }],
      todos: [],
      progress_log: []
    }
    arr.push(task)
    created = task
    return arr
  })

  if (created?.duplicate) {
    return { ok: false, cmd: 'create', agent, rejected: true, reason: `任务 ${taskId} 已存在`, code: 'DUPLICATE' }
  }
  audit(store, taskId, agent, 'create', null, state, title)
  return { ok: true, cmd: 'create', agent, taskId, state, org: created.org, title }
}

/* ── state（状态流转，含合法性 + 高风险拦截）────────────────────────── */
export async function cmdState(store, params, agent) {
  const denied = guard(store, agent, 'state')
  if (denied) return denied

  const { taskId } = params
  const newState = params.state
  if (!Object.values(TaskState).includes(newState)) {
    return { ok: false, cmd: 'state', agent, rejected: true, reason: `未知状态 ${newState}`, code: 'UNKNOWN_STATE' }
  }

  const outcome = { rejected: false, pendingConfirm: false, old: null, reason: '' }
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { outcome.rejected = true; outcome.reason = `任务 ${taskId} 不存在`; return arr }
    outcome.old = t.state

    const check = isTransitionAllowed(t.state, newState)
    if (!check.ok) { outcome.rejected = true; outcome.reason = check.reason; return arr }

    const authority = highRiskAuthority(t.state, newState)
    if (authority) {
      // 高风险 → 先落 PendingConfirm，等待有权限方确认
      t.pending_confirm = {
        target_state: newState,
        requested_by: agent ?? '',
        requested_at: nowIso(),
        confirm_by: authority
      }
      t.state = TaskState.PendingConfirm
      t.org = STATE_ORG_MAP.PendingConfirm
      t.now = `待确认: ${outcome.old}→${newState}`
      t.updatedAt = nowIso()
      outcome.pendingConfirm = true
      return arr
    }

    t.state = newState
    if (STATE_ORG_MAP[newState]) t.org = STATE_ORG_MAP[newState]
    if (params.now) t.now = sanitizeRemark(params.now)
    t.updatedAt = nowIso()
    return arr
  })

  if (outcome.rejected) {
    audit(store, taskId, agent, 'state_rejected', outcome.old, newState, outcome.reason || '非法状态转换')
    return { ok: false, cmd: 'state', agent, rejected: true, reason: outcome.reason, code: 'ILLEGAL_TRANSITION', taskId }
  }
  if (outcome.pendingConfirm) {
    const t = store.getTask(taskId)
    const confirmBy = t?.pending_confirm?.confirm_by ?? 'shangshu'
    audit(store, taskId, agent, 'pending_confirm', outcome.old, newState, `需 ${confirmBy} 确认`)
    return {
      ok: true, cmd: 'state', agent, taskId,
      from: outcome.old, to: TaskState.PendingConfirm,
      pendingConfirm: true, confirmBy, requiresConfirmation: true
    }
  }
  audit(store, taskId, agent, 'state', outcome.old, newState, params.now ? sanitizeRemark(params.now) : '')
  return { ok: true, cmd: 'state', agent, taskId, from: outcome.old, to: newState }
}

/* ── flow（流转记录）───────────────────────────────────────────────── */
export async function cmdFlow(store, params, agent) {
  const denied = guard(store, agent, 'flow')
  if (denied) return denied

  const { taskId } = params
  const from = params.from ?? ''
  const to = params.to ?? ''
  const remark = sanitizeRemark(params.remark || '')
  let missing = false
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { missing = true; return arr }
    t.flow_log = t.flow_log ?? []
    t.flow_log.push({ at: nowIso(), from, to, remark, agent: agent ?? '', agentLabel: AGENT_LABELS[agent] ?? agent ?? '' })
    t.org = to
    t.updatedAt = nowIso()
    return arr
  })
  if (missing) return { ok: false, cmd: 'flow', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  audit(store, taskId, agent, 'flow', from, to, remark)
  return { ok: true, cmd: 'flow', agent, taskId, from, to, remark }
}

/* ── progress（实时进展，不改状态）─────────────────────────────────── */
/** 去掉标题尾部遗留的状态标记（✅ / 🔄 及其变体选择符与零宽连接符） */
function stripTrailingMarker(s) {
  return String(s ?? '').replace(/[\s\uFE0F\u200D\p{Extended_Pictographic}]+$/gu, '').trim()
}

/** 按码位删除末尾一个字符（emoji 是代理对，不能用 slice(0,-1)） */
function dropLastCodePoint(s) {
  const arr = Array.from(String(s ?? ''))
  arr.pop()
  return arr.join('')
}

export function parseTodosPipe(pipe) {
  if (!pipe) return null
  const out = []
  let i = 0
  for (const raw of String(pipe).split('|')) {
    const item = raw.trim()
    if (!item) continue
    i += 1
    let status = 'not-started'
    let title = item
    if (item.endsWith('✅')) { status = 'completed'; title = stripTrailingMarker(dropLastCodePoint(item)) }
    else if (item.endsWith('🔄')) { status = 'in-progress'; title = stripTrailingMarker(dropLastCodePoint(item)) }
    out.push({ id: String(i), title, status })
  }
  return out.length ? out : null
}

export async function cmdProgress(store, params, agent) {
  const denied = guard(store, agent, 'progress')
  if (denied) return denied

  const { taskId } = params
  const clean = sanitizeRemark(params.now || '')
  const parsedTodos = parseTodosPipe(params.todos)
  const tokens = Number(params.tokens) > 0 ? Math.trunc(Number(params.tokens)) : 0
  const cost = Number(params.cost) > 0 ? Number(params.cost) : 0
  const elapsed = Number(params.elapsed) > 0 ? Math.trunc(Number(params.elapsed)) : 0

  let missing = false
  let counts = { completed: 0, total: 0 }
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { missing = true; return arr }
    t.now = clean
    if (parsedTodos) t.todos = parsedTodos
    const at = nowIso()
    const logTodos = parsedTodos ?? t.todos ?? []
    const entry = {
      at, agent: agent ?? '', agentLabel: AGENT_LABELS[agent] ?? agent ?? '',
      text: clean, todos: logTodos, state: t.state ?? '', org: t.org ?? ''
    }
    if (tokens > 0) entry.tokens = tokens
    if (cost > 0) entry.cost = cost
    if (elapsed > 0) entry.elapsed = elapsed
    t.progress_log = t.progress_log ?? []
    t.progress_log.push(entry)
    if (t.progress_log.length > MAX_PROGRESS_LOG) t.progress_log = t.progress_log.slice(-MAX_PROGRESS_LOG)
    t.updatedAt = at
    counts = todoCounts(t)
    /* 注意：上游 cmd_progress 只替换 todos、不重算 ready_to_close，会让该标记失真。
       本移植在替换后重算，保持"全部完成"标记与 todos 一致（行为增强，规则不变）。 */
    if (counts.total > 0 && counts.completed === counts.total) t.ready_to_close = true
    else delete t.ready_to_close
    return arr
  })
  if (missing) return { ok: false, cmd: 'progress', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  audit(store, taskId, agent, 'progress', null, null, clean)
  return { ok: true, cmd: 'progress', agent, taskId, now: clean, todos: counts.total, completed: counts.completed, tokens, cost, elapsed }
}

/* ── todo（子任务，单一 in-progress 约束）──────────────────────────── */
export async function cmdTodo(store, params, agent) {
  const denied = guard(store, agent, 'todo')
  if (denied) return denied

  const { taskId } = params
  const todoId = String(params.todoId ?? '')
  let status = params.status || 'not-started'
  if (!['not-started', 'in-progress', 'completed'].includes(status)) status = 'not-started'

  const outcome = { missing: false, rejected: false, reason: '', completed: 0, total: 0, readyToClose: false }
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { outcome.missing = true; return arr }
    t.todos = t.todos ?? []

    if (status === 'in-progress') {
      const existingIp = t.todos.filter((td) => td?.status === 'in-progress' && String(td?.id) !== todoId)
      if (existingIp.length) {
        outcome.rejected = true
        outcome.reason = `todo #${existingIp[0].id} 正在执行中，请先完成或取消后再开始 #${todoId}`
        return arr
      }
    }

    const existing = t.todos.find((td) => String(td?.id) === todoId)
    if (existing) {
      existing.status = status
      if (params.title) existing.title = params.title
      if (params.detail) existing.detail = params.detail
    } else {
      const item = { id: todoId, title: params.title ?? '', status }
      if (params.detail) item.detail = params.detail
      t.todos.push(item)
    }
    t.updatedAt = nowIso()
    const c = todoCounts(t)
    outcome.completed = c.completed
    outcome.total = c.total
    if (c.total > 0 && c.completed === c.total) {
      t.ready_to_close = true
      outcome.readyToClose = true
    }
    return arr
  })

  if (outcome.missing) return { ok: false, cmd: 'todo', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  if (outcome.rejected) {
    audit(store, taskId, agent, 'todo_rejected', todoId, 'in-progress', 'single in-progress constraint')
    return { ok: false, cmd: 'todo', agent, rejected: true, reason: outcome.reason, code: 'SINGLE_IN_PROGRESS' }
  }
  return { ok: true, cmd: 'todo', agent, taskId, todoId, status, completed: outcome.completed, total: outcome.total, readyToClose: outcome.readyToClose }
}

/* ── done（执行部门回报，进入 Review）──────────────────────────────── */
export async function cmdDone(store, params, agent) {
  const denied = guard(store, agent, 'done')
  if (denied) return denied

  const { taskId } = params
  const outcome = { missing: false, rejected: false, reason: '' }
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { outcome.missing = true; return arr }

    if (t.state !== TaskState.Doing && t.state !== TaskState.Next) {
      outcome.rejected = true
      outcome.reason = `当前状态 ${t.state} 不允许直接上报完成`
      return arr
    }
    const c = todoCounts(t)
    if (c.total > 0 && c.completed < c.total) {
      outcome.rejected = true
      outcome.reason = `todos 未完成（${c.completed}/${c.total}），禁止直接收口`
      return arr
    }

    const now = nowIso()
    const fromOrg = t.org || '执行部门'
    t.state = TaskState.Review
    t.org = STATE_ORG_MAP.Review
    t.output = params.outputPath ?? ''
    t.now = sanitizeRemark(params.summary || '') || '执行已完成，提交尚书省汇总审查'
    t.flow_log = t.flow_log ?? []
    t.flow_log.push({ at: now, from: fromOrg, to: STATE_ORG_MAP.Review, remark: t.now, agent: agent ?? '', agentLabel: AGENT_LABELS[agent] ?? agent ?? '' })
    t.updatedAt = now
    return arr
  })

  if (outcome.missing) return { ok: false, cmd: 'done', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  if (outcome.rejected) {
    audit(store, taskId, agent, 'done_rejected', null, TaskState.Review, outcome.reason)
    return { ok: false, cmd: 'done', agent, rejected: true, reason: outcome.reason, code: 'DONE_REJECTED' }
  }
  audit(store, taskId, agent, 'done', null, TaskState.Review, sanitizeRemark(params.summary || ''))
  return { ok: true, cmd: 'done', agent, taskId, to: TaskState.Review }
}

/* ── block（标记阻塞）──────────────────────────────────────────────── */
export async function cmdBlock(store, params, agent) {
  const denied = guard(store, agent, 'block')
  if (denied) return denied

  const { taskId } = params
  const reason = sanitizeRemark(params.reason || '')
  let missing = false
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { missing = true; return arr }
    t.state = TaskState.Blocked
    t.block = reason
    t.updatedAt = nowIso()
    return arr
  })
  if (missing) return { ok: false, cmd: 'block', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  audit(store, taskId, agent, 'block', null, TaskState.Blocked, reason)
  return { ok: true, cmd: 'block', agent, taskId, state: TaskState.Blocked, reason }
}

/* ── confirm（批准 / 驳回高风险操作）───────────────────────────────── */
export async function cmdConfirm(store, params, agent) {
  const denied = guard(store, agent, 'confirm')
  if (denied) return denied

  const { taskId } = params
  const action = params.action
  const reason = sanitizeRemark(params.reason || '')
  if (action !== 'approve' && action !== 'reject') {
    return { ok: false, cmd: 'confirm', agent, rejected: true, reason: `未知 confirm 操作: ${action}`, code: 'BAD_ACTION' }
  }

  const outcome = { missing: false, rejected: false, reason: '', result: null, overdue: false }
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { outcome.missing = true; return arr }
    if (t.state !== TaskState.PendingConfirm) {
      outcome.rejected = true
      outcome.reason = `任务不在 PendingConfirm 状态 (当前: ${t.state})`
      return arr
    }
    const pending = t.pending_confirm ?? {}
    if (action === 'approve') {
      const target = pending.target_state || TaskState.Done
      t.state = target
      if (STATE_ORG_MAP[target]) t.org = STATE_ORG_MAP[target]
      t.now = reason || `确认通过 → ${target}`
      outcome.result = target
    } else {
      t.state = TaskState.Review
      t.org = STATE_ORG_MAP.Review
      t.now = reason || '确认被驳回，退回复审'
      outcome.result = TaskState.Review
    }
    delete t.pending_confirm
    t.updatedAt = nowIso()
    t.flow_log = t.flow_log ?? []
    t.flow_log.push({
      at: nowIso(), from: TaskState.PendingConfirm, to: outcome.result,
      remark: `${action === 'approve' ? '✅ 批准' : '❌ 驳回'}: ${reason}`
    })
    return arr
  })

  if (outcome.missing) return { ok: false, cmd: 'confirm', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  if (outcome.rejected) {
    audit(store, taskId, agent, `confirm_${action}_rejected`, TaskState.PendingConfirm, null, outcome.reason)
    return { ok: false, cmd: 'confirm', agent, rejected: true, reason: outcome.reason, code: 'NOT_PENDING_CONFIRM' }
  }
  audit(store, taskId, agent, `confirm_${action}`, TaskState.PendingConfirm, outcome.result, reason)
  return { ok: true, cmd: 'confirm', agent, taskId, action, from: TaskState.PendingConfirm, to: outcome.result }
}

/* ── delegate（委派子任务，防深度/循环）────────────────────────────── */
export async function cmdDelegate(store, params, agent) {
  const denied = guard(store, agent, 'delegate')
  if (denied) return denied

  const { taskId } = params
  const fromAgent = agent ?? ''
  const toAgent = params.to
  const instruction = String(params.instruction ?? '')

  // 权限链校验（agents.json allowAgents）
  const allowed = DELEGATION_MATRIX[fromAgent]
  if (Array.isArray(allowed) && !allowed.includes(toAgent)) {
    const reason = `${fromAgent} 无权委派给 ${toAgent}（允许: ${allowed.join(', ') || '无'}）`
    audit(store, taskId, fromAgent, 'delegate_rejected', toAgent, null, reason)
    return { ok: false, cmd: 'delegate', agent, rejected: true, reason, code: 'DELEGATION_NOT_ALLOWED' }
  }

  const parent = store.getTask(taskId)
  if (!parent) return { ok: false, cmd: 'delegate', agent, rejected: true, reason: `父任务 ${taskId} 不存在`, code: 'NO_TASK' }

  const check = checkDelegation(fromAgent, toAgent, parent.delegation)
  if (!check.ok) {
    audit(store, taskId, fromAgent, 'delegate_rejected', null, null,
      check.kind === 'circular' ? `circular: ${check.path.join(' → ')}` : `depth=${check.depth} exceeds limit`)
    return { ok: false, cmd: 'delegate', agent, rejected: true, reason: check.reason, code: check.kind === 'circular' ? 'CIRCULAR' : 'DEPTH_EXCEEDED' }
  }

  const subTaskId = `${taskId}-sub-${shortUuid()}`
  const org = ORG_AGENT_MAP[toAgent] ?? STATE_ORG_MAP.Doing
  const now = nowIso()
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    arr.unshift({
      id: subTaskId,
      parent_task: taskId,
      type: 'delegation',
      title: `[委派] ${instruction.slice(0, 40)}`,
      state: TaskState.Doing,
      org,
      official: fromAgent,
      now: instruction.slice(0, 60),
      delegation: {
        from: fromAgent,
        to: toAgent,
        instruction,
        return_spec: params.returnSpec ?? '',
        created_at: now,
        timeout_minutes: 30,
        delegation_bypass: true,
        review_required: true,
        delegation_depth: check.depth,
        delegation_path: check.path
      },
      flow_log: [{ at: now, from: fromAgent, to: toAgent, remark: `委派: ${instruction.slice(0, 40)}` }],
      todos: [],
      updatedAt: now
    })
    return arr
  })
  audit(store, taskId, fromAgent, 'delegate', toAgent, subTaskId, instruction)
  return { ok: true, cmd: 'delegate', agent, taskId, subTaskId, from: fromAgent, to: toAgent, depth: check.depth, path: check.path }
}

/* ── delegate-result（子任务回写父任务记忆）────────────────────────── */
export async function cmdDelegateResult(store, params, agent) {
  const denied = guard(store, agent, 'delegate-result')
  if (denied) return denied

  const { taskId } = params
  const result = params.result ?? {}
  let missing = false
  let parentId = null
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { missing = true; return arr }
    parentId = t.parent_task ?? null
    t.result = result
    t.state = TaskState.Review
    t.org = STATE_ORG_MAP.Review
    t.updatedAt = nowIso()
    return arr
  })
  if (missing) return { ok: false, cmd: 'delegate-result', agent, rejected: true, reason: `子任务 ${taskId} 不存在`, code: 'NO_TASK' }

  if (parentId) {
    const memories = store.readMemories()
    const list = Array.isArray(memories[agent]) ? memories[agent] : []
    list.push({ at: nowIso(), task: taskId, parent: parentId, result })
    memories[agent] = list.slice(-MAX_AGENT_MEMORIES)
    store.writeJsonAtomic(store.memoryFile, memories)
  }
  audit(store, taskId, agent, 'delegate_result', null, parentId, JSON.stringify(result).slice(0, 200))
  return { ok: true, cmd: 'delegate-result', agent, taskId, parentTask: parentId }
}

/* ── memory（Agent 记忆）───────────────────────────────────────────── */
export async function cmdMemory(store, params, agent) {
  const denied = guard(store, agent, 'memory')
  if (denied) return denied

  const memType = params.type || 'note'
  const content = sanitizeRemark(params.content || '')
  const memories = store.readMemories()
  const list = Array.isArray(memories[agent]) ? memories[agent] : []
  list.push({ at: nowIso(), type: memType, content, source_task: params.sourceTask ?? '', tags: params.tags ?? [] })
  // 上限 200：优先保留 pinned
  const pinned = list.filter((m) => m.pinned)
  const unpinned = list.filter((m) => !m.pinned)
  memories[agent] = pinned.concat(unpinned.slice(-(MAX_AGENT_MEMORIES - pinned.length)))
  store.writeJsonAtomic(store.memoryFile, memories)
  audit(store, params.sourceTask ?? '', agent, 'memory', memType, null, content)
  return { ok: true, cmd: 'memory', agent, type: memType, content, total: memories[agent].length }
}

/* ── task-memo（任务级备忘）────────────────────────────────────────── */
export async function cmdTaskMemo(store, params, agent) {
  const denied = guard(store, agent, 'task-memo')
  if (denied) return denied

  const { taskId } = params
  const decisions = params.decisions ?? []
  const warnings = params.warnings ?? []
  let missing = false
  await store.updateTasks((tasks) => {
    const arr = Array.isArray(tasks) ? tasks : []
    const t = arr.find((x) => x?.id === taskId)
    if (!t) { missing = true; return arr }
    t.memo = t.memo ?? { decisions: [], warnings: [] }
    t.memo.decisions.push(...[].concat(decisions).map((d) => ({ at: nowIso(), by: agent ?? '', text: String(d) })))
    t.memo.warnings.push(...[].concat(warnings).map((w) => ({ at: nowIso(), by: agent ?? '', text: String(w) })))
    t.updatedAt = nowIso()
    return arr
  })
  if (missing) return { ok: false, cmd: 'task-memo', agent, rejected: true, reason: `任务 ${taskId} 不存在`, code: 'NO_TASK' }
  audit(store, taskId, agent, 'task_memo', null, null, `${decisions.length} decisions / ${warnings.length} warnings`)
  return { ok: true, cmd: 'task-memo', agent, taskId, decisions: [].concat(decisions).length, warnings: [].concat(warnings).length }
}

/* ── shared-memo（全局共享备忘）────────────────────────────────────── */
export async function cmdSharedMemo(store, params, agent) {
  const denied = guard(store, agent, 'shared-memo')
  if (denied) return denied

  const content = sanitizeRemark(params.content || '')
  await store.update(store.memoFile, (memo) => {
    const arr = Array.isArray(memo) ? memo : []
    arr.push({ at: nowIso(), by: agent ?? '', content })
    return arr.slice(-200)
  }, [])
  audit(store, '', agent, 'shared_memo', null, null, content)
  return { ok: true, cmd: 'shared-memo', agent, content }
}

/* ── status（只读查询，不写审计）───────────────────────────────────── */
export async function cmdStatus(store, params) {
  const tasks = store.listTasks()
  if (params?.taskId) {
    const t = tasks.find((x) => x?.id === params.taskId)
    if (!t) return { ok: false, cmd: 'status', rejected: true, reason: `任务 ${params.taskId} 不存在`, code: 'NO_TASK' }
    return {
      ok: true, cmd: 'status', task: {
        id: t.id, title: t.title, state: t.state, org: t.org, now: t.now,
        official: t.official, todos: todoCounts(t),
        pendingConfirm: t.pending_confirm ?? null,
        flow: t.flow_log ?? [], blocked: t.block ?? null,
        delegation: t.delegation ?? null, parent: t.parent_task ?? null
      }
    }
  }
  const byState = {}
  for (const s of Object.values(TaskState)) byState[s] = 0
  for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1
  return {
    ok: true, cmd: 'status',
    total: tasks.length,
    byState,
    active: tasks.filter((t) => !['Done', 'Cancelled'].includes(t.state)).map((t) => ({ id: t.id, title: t.title, state: t.state, org: t.org, now: t.now }))
  }
}

/* ── 看板数据（供 UI 路由使用，与 cmdStatus 同一数据源）───────────────── */
export function boardData(store) {
  const tasks = store.listTasks()
  const byState = {}
  for (const s of Object.values(TaskState)) byState[s] = 0
  for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1
  const active = tasks
    .filter((t) => !['Done', 'Cancelled'].includes(t.state))
    .map((t) => ({
      id: t.id, title: t.title, state: t.state, org: t.org, now: t.now,
      official: t.official, type: t.type ?? 'edict',
      todos: todoCounts(t),
      pendingConfirm: t.pending_confirm ?? null,
      blocked: t.block ?? null,
      updatedAt: t.updatedAt ?? null
    }))
  const done = tasks.filter((t) => t.state === 'Done').length
  const cancelled = tasks.filter((t) => t.state === 'Cancelled').length
  return { total: tasks.length, active, byState, done, cancelled }
}

/** 单任务详情（含流转链与 todos 明细） */
export function taskDetail(store, id) {
  const t = store.listTasks().find((x) => x?.id === id)
  if (!t) return null
  return {
    id: t.id, title: t.title, state: t.state, org: t.org, now: t.now,
    official: t.official, type: t.type ?? 'edict',
    todos: todoCounts(t), todoList: t.todos ?? [],
    flow: t.flow_log ?? [],
    pendingConfirm: t.pending_confirm ?? null,
    blocked: t.block ?? null,
    parent: t.parent_task ?? null,
    delegation: t.delegation ?? null,
    memo: t.memo ?? null,
    output: t.output ?? null,
    createdAt: t.createdAt ?? null,
    updatedAt: t.updatedAt ?? null
  }
}

/** 命令分发表：工具层按名字调用 */
export const COMMANDS = Object.freeze({
  create: cmdCreate,
  state: cmdState,
  flow: cmdFlow,
  progress: cmdProgress,
  todo: cmdTodo,
  done: cmdDone,
  block: cmdBlock,
  confirm: cmdConfirm,
  delegate: cmdDelegate,
  'delegate-result': cmdDelegateResult,
  memory: cmdMemory,
  'task-memo': cmdTaskMemo,
  'shared-memo': cmdSharedMemo,
  status: cmdStatus
})

export { newTaskId, MAX_DELEGATION_DEPTH }
