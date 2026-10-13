/**
 * dsh-edict 测试
 * ----------------------------------------------------------------------------
 * 目标：证明本移植的规则与 edict 原实现逐条一致。
 *
 * 其中第一组（状态机守卫）是从 edict 的 tests/test_state_machine_consistency.py
 * 移植过来的同一批不变量；原版用来防止"只改一侧状态机"，这里改成对
 * 上游 task.py 的硬编码期望表做回归守卫——期望表逐字抄自 task.py。
 *
 * 运行：node test/edict.test.mjs
 *      （不用 node --test：它会派生子进程，在受限沙箱里会 EPERM）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── 极简 runner ──────────────────────────────────────────────────── */
const cases = []
const test = (title, fn) => { cases.push({ title, fn }) }

const sorted = (a) => [...a].sort()

import {
  TaskState, STATE_TRANSITIONS, TERMINAL_STATES, HIGH_RISK_TRANSITIONS, CONFIRM_AUTHORITY,
  AGENT_POLICY, DELEGATION_MATRIX, MAX_DELEGATION_DEPTH, STATE_ORG_MAP,
  isTransitionAllowed, highRiskAuthority, checkPermission, checkDelegation,
  sanitizeText, isValidTaskTitle, todoCounts, EdictStore
} from '../lib/core.mjs'
import { COMMANDS, parseTodosPipe } from '../lib/commands.mjs'

/* ── 期望表：逐字抄自 edict/edict/backend/app/models/task.py ────────────── */
const EXPECTED_TRANSITIONS = {
  Pending: ['Taizi', 'Cancelled'],
  Taizi: ['Zhongshu', 'Cancelled'],
  Zhongshu: ['Menxia', 'Cancelled', 'Blocked'],
  Menxia: ['Assigned', 'Zhongshu', 'Cancelled'],
  Assigned: ['Doing', 'Next', 'Cancelled', 'Blocked'],
  Next: ['Doing', 'Cancelled', 'Blocked'],
  Doing: ['Review', 'Done', 'Blocked', 'Cancelled'],
  Review: ['Done', 'Menxia', 'Doing', 'Cancelled', 'PendingConfirm'],
  PendingConfirm: ['Done', 'Review', 'Cancelled'],
  Blocked: ['Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing', 'Review', 'Cancelled'],
  Done: [],
  Cancelled: []
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edict-test-'))
  return new EdictStore({ dataDir: dir })
}

/* ══ 1. 状态机守卫（移植自 test_state_machine_consistency.py）══ */

test('状态转换表与上游 task.py 逐条一致', () => {
  for (const [state, expected] of Object.entries(EXPECTED_TRANSITIONS)) {
    const actual = STATE_TRANSITIONS[state]
    assert.ok(actual !== undefined, `缺失状态 ${state} 的转换定义`)
    assert.deepEqual(sorted(actual), sorted(expected), `状态 ${state} 的转换与上游不一致`)
  }
})

test('12 个状态齐全（与 TaskState 枚举一致）', () => {
  assert.deepEqual(sorted(Object.values(TaskState)), sorted([
    'Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing',
    'Review', 'Done', 'Blocked', 'Cancelled', 'Pending', 'PendingConfirm'
  ]))
})

test('PendingConfirm 存在，且 Pending 不是死胡同', () => {
  assert.ok('PendingConfirm' in STATE_TRANSITIONS)
  assert.ok(STATE_TRANSITIONS.Pending.length > 0, 'Pending 无出边（死胡同）')
})

test('终态 Done / Cancelled 无出边', () => {
  assert.deepEqual(STATE_TRANSITIONS.Done, [])
  assert.deepEqual(STATE_TRANSITIONS.Cancelled, [])
  assert.deepEqual(sorted(TERMINAL_STATES), ['Cancelled', 'Done'])
})

test('门下省封驳回环存在：Menxia → Zhongshu', () => {
  assert.ok(STATE_TRANSITIONS.Menxia.includes('Zhongshu'), '封驳路径缺失')
  assert.ok(STATE_TRANSITIONS.Review.includes('Menxia'), '复审回门下省的路径缺失')
})

/* ══ 2. 高风险转换与确认权限 ══ */

test('高风险转换表与确认权限一致', () => {
  const expected = [['Review', 'Done'], ['Doing', 'Cancelled'], ['Menxia', 'Cancelled']]
  assert.deepEqual(HIGH_RISK_TRANSITIONS.map((p) => [...p]), expected)
  assert.equal(CONFIRM_AUTHORITY.Review, 'menxia')
  assert.equal(CONFIRM_AUTHORITY.Doing, 'shangshu')
  assert.equal(CONFIRM_AUTHORITY.Menxia, 'zhongshu')
  for (const [from, to] of HIGH_RISK_TRANSITIONS) {
    assert.equal(highRiskAuthority(from, to), CONFIRM_AUTHORITY[from])
  }
  assert.equal(highRiskAuthority('Taizi', 'Zhongshu'), null)
})

/* ══ 3. 越权矩阵 ══ */

test('越权矩阵：六部不能改状态，门下省不能 create', () => {
  assert.equal(checkPermission('hubu', 'state'), 'hubu 越权执行 state（允许: progress, todo, done, block, memory, task-memo, delegate-result）')
  assert.equal(checkPermission('menxia', 'create'), 'menxia 越权执行 create（允许: state, flow, progress, todo, confirm, memory, task-memo）')
  assert.equal(checkPermission('taizi', 'create'), null)
  assert.equal(checkPermission('menxia', 'confirm'), null)
  assert.equal(checkPermission('shangshu', 'delegate'), null)
  assert.equal(checkPermission('unknown-agent', 'anything'), null, '未注册 Agent 不应被拦截')
  assert.equal(checkPermission(null, 'anything'), null, '无法推断身份时不拦截')
})

test('AGENT_POLICY 覆盖 11 个衙门角色', () => {
  assert.deepEqual(sorted(Object.keys(AGENT_POLICY)), sorted([
    'taizi', 'zhongshu', 'menxia', 'shangshu',
    'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao'
  ]))
})

/* ══ 4. 委派防死锁 ══ */

test('委派深度上限 3，超限拒绝', () => {
  assert.equal(MAX_DELEGATION_DEPTH, 3)
  const parent = { delegation_depth: 3, delegation_path: ['taizi', 'zhongshu', 'menxia'] }
  const r = checkDelegation('menxia', 'shangshu', parent)
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'depth')
})

test('循环委派被拒绝', () => {
  const parent = { delegation_depth: 1, delegation_path: ['zhongshu', 'menxia'] }
  const r = checkDelegation('menxia', 'zhongshu', parent) // 回到路径上已出现的节点
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'circular')
})

test('首次委派深度为 1 且允许', () => {
  const r = checkDelegation('taizi', 'zhongshu', undefined)
  assert.equal(r.ok, true)
  assert.equal(r.depth, 1)
  assert.deepEqual(r.path, ['taizi', 'zhongshu'])
})

test('委派权限链：taizi 只能派给 zhongshu，六部只能回报 shangshu', () => {
  assert.deepEqual(sorted(DELEGATION_MATRIX.taizi), ['zhongshu'])
  assert.deepEqual(sorted(DELEGATION_MATRIX.hubu), ['shangshu'])
  assert.equal(DELEGATION_MATRIX.zaochao.length, 0)
})

/* ══ 5. 文本清洗与标题校验 ══ */

test('文本清洗：剥离路径/URL/元数据/传旨前缀', () => {
  // 注意：上游正则只吃掉 "://..." 部分，残留的 "https:" 是原实现的行为，此处保持一致
  assert.equal(sanitizeText('传旨：把 /Users/x/a.py 里的 https://a.b/c 逻辑改掉'), '把 里的 https: 逻辑改掉')
  assert.equal(sanitizeText('做点事\nConversation info: x'), '做点事')
  assert.equal(sanitizeText('a'.repeat(100), 10), 'aaaaaaaaaa…')
})

test('标题校验：长度 ≥6 且不吃闲聊词', () => {
  assert.equal(isValidTaskTitle('短'), false)
  assert.equal(isValidTaskTitle('收到'), false)
  assert.equal(isValidTaskTitle('测试'), false)
  assert.equal(isValidTaskTitle('OK'), false, '垃圾词比较应忽略大小写')
  assert.equal(isValidTaskTitle('实现三人省六部审核插件'), true)
})

/* ══ 6. 端到端：完整流程 + 各条硬规则 ══ */

test('正常流程：Pending→Taizi→Zhongshu→Menxia→Assigned→Doing→Review→Done', async () => {
  const store = tmpStore()
  const create = await COMMANDS.create(store, { title: '实现一个完整的三省六部流程' }, 'taizi')
  assert.equal(create.ok, true)
  const id = create.taskId
  assert.equal(create.state, 'Pending')

  const step = async (from, to) => {
    const r = await COMMANDS.state(store, { taskId: id, state: to }, 'shangshu')
    assert.equal(r.ok, true, `${from}→${to} 应被允许: ${r.reason ?? ''}`)
  }
  await step('Pending', 'Taizi')
  await step('Taizi', 'Zhongshu')
  await step('Zhongshu', 'Menxia')
  await step('Menxia', 'Assigned')
  await step('Assigned', 'Doing')

  const done = await COMMANDS.done(store, { taskId: id, summary: '做完了' }, 'hubu')
  assert.equal(done.ok, true, done.reason)
  assert.equal(store.getTask(id).state, 'Review')

  // Review→Done 是高风险：不直接落地，先进 PendingConfirm
  const risky = await COMMANDS.state(store, { taskId: id, state: 'Done' }, 'shangshu')
  assert.equal(risky.pendingConfirm, true)
  assert.equal(risky.confirmBy, 'menxia')
  assert.equal(store.getTask(id).state, 'PendingConfirm')

  const approve = await COMMANDS.confirm(store, { taskId: id, action: 'approve', reason: '准' }, 'menxia')
  assert.equal(approve.ok, true)
  assert.equal(store.getTask(id).state, 'Done')
})

test('非法状态转换被拒绝并留审计', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '非法转换测试用例' }, 'taizi')
  const r = await COMMANDS.state(store, { taskId, state: 'Done' }, 'shangshu') // Pending→Done 非法
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ILLEGAL_TRANSITION')
  assert.equal(store.getTask(taskId).state, 'Pending', '状态不应被改动')
  const logs = store.listAudit(50, taskId)
  assert.ok(logs.some((l) => l.action === 'state_rejected'), '拒绝必须写审计')
})

test('封驳：Menxia→Zhongshu 打回重做，配合高风险确认退回 Review', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '封驳路径测试用例' }, 'taizi')
  await COMMANDS.state(store, { taskId, state: 'Taizi' }, 'taizi')
  await COMMANDS.state(store, { taskId, state: 'Zhongshu' }, 'zhongshu')
  await COMMANDS.state(store, { taskId, state: 'Menxia' }, 'zhongshu')

  // 门下省封驳：打回中书省重做
  const bounce = await COMMANDS.state(store, { taskId, state: 'Zhongshu', now: '方案不完备，封驳' }, 'menxia')
  assert.equal(bounce.ok, true, `封驳失败: ${JSON.stringify(bounce)}`)
  assert.equal(store.getTask(taskId).state, 'Zhongshu')

  // 高速通道：走到 Doing，再申请取消（Doing→Cancelled 是高风险，需 shangshu 确认；
  // 注意 Menxia→Cancelled 虽同为高风险，但需 zhongshu 确认而 zhongshu 无 confirm 权限
  // ——这是上游 AGENT_POLICY 的既有组合，本移植不改规则）
  await COMMANDS.state(store, { taskId, state: 'Menxia' }, 'zhongshu')
  await COMMANDS.state(store, { taskId, state: 'Assigned' }, 'menxia')
  await COMMANDS.state(store, { taskId, state: 'Doing' }, 'shangshu')

  const cancel = await COMMANDS.state(store, { taskId, state: 'Cancelled' }, 'shangshu')
  assert.equal(cancel.ok, true, JSON.stringify(cancel))
  assert.equal(cancel.pendingConfirm, true)
  assert.equal(cancel.confirmBy, 'shangshu')
  assert.equal(store.getTask(taskId).state, 'PendingConfirm')

  const reject = await COMMANDS.confirm(store, { taskId, action: 'reject', reason: '不准取消' }, 'shangshu')
  assert.equal(reject.ok, true, JSON.stringify(reject))
  assert.equal(store.getTask(taskId).state, 'Review')
})

test('done 前置：状态必须 Doing/Next，且 todos 必须全部完成', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: 'done 前置校验测试' }, 'taizi')

  // 状态不对
  const wrongState = await COMMANDS.done(store, { taskId }, 'hubu')
  assert.equal(wrongState.ok, false)
  assert.equal(wrongState.code, 'DONE_REJECTED')
  assert.match(wrongState.reason, /不允许直接上报完成/)

  // 走到 Doing
  await COMMANDS.state(store, { taskId, state: 'Taizi' }, 'taizi')
  await COMMANDS.state(store, { taskId, state: 'Zhongshu' }, 'zhongshu')
  await COMMANDS.state(store, { taskId, state: 'Menxia' }, 'zhongshu')
  await COMMANDS.state(store, { taskId, state: 'Assigned' }, 'menxia')
  await COMMANDS.state(store, { taskId, state: 'Doing' }, 'shangshu')

  await COMMANDS.todo(store, { taskId, todoId: '1', title: '第一步', status: 'completed' }, 'hubu')
  await COMMANDS.todo(store, { taskId, todoId: '2', title: '第二步', status: 'in-progress' }, 'hubu')
  const pending = await COMMANDS.done(store, { taskId }, 'hubu')
  assert.equal(pending.ok, false)
  assert.match(pending.reason, /todos 未完成（1\/2）/)

  await COMMANDS.todo(store, { taskId, todoId: '2', status: 'completed' }, 'hubu')
  const ok = await COMMANDS.done(store, { taskId }, 'hubu')
  assert.equal(ok.ok, true)
})

test('单一 in-progress 约束', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '单一进行中约束测试' }, 'taizi')
  await COMMANDS.todo(store, { taskId, todoId: '1', title: 'A', status: 'in-progress' }, 'hubu')
  const conflict = await COMMANDS.todo(store, { taskId, todoId: '2', title: 'B', status: 'in-progress' }, 'hubu')
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'SINGLE_IN_PROGRESS')
  assert.match(conflict.reason, /#1 正在执行中/)
  // 同一 todo 反复置为 in-progress 不算冲突
  const same = await COMMANDS.todo(store, { taskId, todoId: '1', title: 'A', status: 'in-progress' }, 'hubu')
  assert.equal(same.ok, true)
})

test('progress 的 | 清单解析与 ready_to_close', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '进展汇报解析测试' }, 'taizi')
  const parsed = parseTodosPipe('读代码✅|改实现🔄|写测试')
  assert.deepEqual(parsed, [
    { id: '1', title: '读代码', status: 'completed' },
    { id: '2', title: '改实现', status: 'in-progress' },
    { id: '3', title: '写测试', status: 'not-started' }
  ])
  const r = await COMMANDS.progress(store, { taskId, now: '正在改实现', todos: '读代码✅|改实现🔄', tokens: 1200, cost: 0.03, elapsed: 42 }, 'hubu')
  assert.equal(r.ok, true)
  assert.equal(r.tokens, 1200)
  const t = store.getTask(taskId)
  assert.equal(t.progress_log.length, 1)
  assert.equal(t.progress_log[0].cost, 0.03)

  const all = await COMMANDS.progress(store, { taskId, now: '全做完', todos: '读代码✅|改实现✅' }, 'hubu')
  assert.equal(all.ok, true)
  assert.equal(all.completed, 2)
  assert.equal(store.getTask(taskId).ready_to_close, true)
})

test('progress_log 上限 100 条', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '进展日志上限测试' }, 'taizi')
  for (let i = 0; i < 105; i += 1) {
    await COMMANDS.progress(store, { taskId, now: `第 ${i} 步` }, 'hubu')
  }
  assert.equal(store.getTask(taskId).progress_log.length, 100)
})

test('委派：合法链通过，越权与跳级被拒，子任务落库', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '委派链路测试用例' }, 'taizi')

  // taizi 的 AGENT_POLICY 里没有 delegate（与上游一致），因此先被越权矩阵拦下
  const taiziTry = await COMMANDS.delegate(store, { taskId, to: 'zhongshu', instruction: '太子试图委派' }, 'taizi')
  assert.equal(taiziTry.ok, false)
  assert.equal(taiziTry.code, 'PERMISSION_DENIED')

  // 换有 delegate 权限的中书省做跳级委派（zhongshu 只能派 menxia / shangshu）
  const badChain = await COMMANDS.delegate(store, { taskId, to: 'hubu', instruction: '跳级委派' }, 'zhongshu')
  assert.equal(badChain.ok, false)
  assert.equal(badChain.code, 'DELEGATION_NOT_ALLOWED')

  const ok = await COMMANDS.delegate(store, { taskId, to: 'zhongshu', instruction: '请中书省规划' }, 'shangshu')
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.depth, 1)
  const sub = store.getTask(ok.subTaskId)
  assert.equal(sub.parent_task, taskId)
  assert.equal(sub.state, 'Doing')
  assert.equal(sub.delegation.delegation_depth, 1)
  assert.deepEqual(sub.delegation.delegation_path, ['shangshu', 'zhongshu'])
  assert.equal(sub.delegation.timeout_minutes, 30)
  assert.equal(sub.delegation.review_required, true)
})

test('越权：六部改状态被拒且写 permission_denied 审计', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '越权拦截测试用例' }, 'taizi')
  const r = await COMMANDS.state(store, { taskId, state: 'Taizi' }, 'hubu')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PERMISSION_DENIED')
  assert.ok(store.listAudit(50).some((l) => l.action === 'permission_denied'))
})

test('confirm 只在 PendingConfirm 状态可执行', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '确认状态前置测试' }, 'taizi')
  const r = await COMMANDS.confirm(store, { taskId, action: 'approve' }, 'menxia')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_PENDING_CONFIRM')
})

test('block 与审计上限', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '阻塞与审计测试用例' }, 'taizi')
  const r = await COMMANDS.block(store, { taskId, reason: '等外部依赖' }, 'hubu')
  assert.equal(r.ok, true)
  assert.equal(store.getTask(taskId).state, 'Blocked')
  assert.equal(store.getTask(taskId).block, '等外部依赖')
})

test('审计日志结构完整且按任务可查', async () => {
  const store = tmpStore()
  const { taskId } = await COMMANDS.create(store, { title: '审计结构校验测试' }, 'taizi')
  await COMMANDS.state(store, { taskId, state: 'Taizi' }, 'taizi')
  const logs = store.listAudit(50, taskId)
  assert.ok(logs.length >= 2)
  for (const l of logs) {
    assert.ok(typeof l.ts === 'string' && l.ts.includes('T'))
    assert.equal(typeof l.action, 'string')
    assert.ok('from' in l && 'to' in l && 'reason' in l && 'agent' in l)
  }
})

test('状态→部门映射与上游 STATE_ORG_MAP 一致', () => {
  assert.equal(STATE_ORG_MAP.Taizi, '太子')
  assert.equal(STATE_ORG_MAP.Zhongshu, '中书省')
  assert.equal(STATE_ORG_MAP.Menxia, '门下省')
  assert.equal(STATE_ORG_MAP.Assigned, '尚书省')
  assert.equal(STATE_ORG_MAP.Review, '尚书省')
  assert.equal(STATE_ORG_MAP.PendingConfirm, '尚书省')
  assert.equal(STATE_ORG_MAP.Pending, '中书省')
})

test('todoCounts 统计正确', () => {
  assert.deepEqual(todoCounts({ todos: [{ status: 'completed' }, { status: 'in-progress' }] }), { completed: 1, total: 2 })
  assert.deepEqual(todoCounts({}), { completed: 0, total: 0 })
})

/* ── 执行 ─────────────────────────────────────────────────────────── */
let passed = 0
const failures = []
for (const { title, fn } of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (err) {
    failures.push({ title, err })
    console.log(`  ✗ ${title}`)
    console.log(`      ${String(err?.message ?? err).split('\n')[0]}`)
  }
}
console.log('')
console.log(`  ${passed}/${cases.length} 通过`)
if (failures.length) {
  console.log('')
  for (const f of failures) {
    console.log(`  ── ${f.title}`)
    console.log(String(f.err?.stack ?? f.err).split('\n').slice(0, 6).join('\n'))
  }
  process.exitCode = 1
} else {
  console.log('  全部通过 ✅')
}

