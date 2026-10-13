/**
 * 冒烟测试：用 mock ctx 加载插件宿主半侧，验证
 *   1) 15 个工具 + 3 个命令都能注册
 *   2) 通过工具 handler 真的能跑完一条旨意（含封驳与高风险确认）
 * 不依赖真实 DSH 运行时，可在沙箱内直接跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edict-smoke-'))

const registeredTools = new Map()
const registeredCommands = new Map()

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {
    register(def) {
      // 兼容 {name, description, parameters, execute} 形态
      if (!def || !def.name) return false
      registeredTools.set(def.name, def)
      return true
    }
  },
  commands: {
    register(def) {
      if (!def || !def.name) return false
      registeredCommands.set(def.name, def)
      return true
    }
  }
}

const plugin = await import('../lib/index.js')
plugin.apply(ctx, { dataDir: dir })

console.log(`注册工具 ${registeredTools.size} 个，命令 ${registeredCommands.size} 个`)
const expectedTools = [
  'edict_create', 'edict_move', 'edict_flow', 'edict_progress', 'edict_todo',
  'edict_done', 'edict_block', 'edict_confirm', 'edict_delegate',
  'edict_delegate_result', 'edict_memory', 'edict_task_memo', 'edict_shared_memo',
  'edict_status', 'edict_role'
]
const missing = expectedTools.filter((t) => !registeredTools.has(t))
if (missing.length) {
  console.error('✗ 缺失工具: ' + missing.join(', '))
  process.exit(1)
}
console.log('✓ 15 个工具齐全')

const call = (name, args) => registeredTools.get(name).execute(args)

/* ── 跑一条完整旨意 ── */
const created = await call('edict_create', { title: '把首页加载时间降到 1 秒以内', agent: 'taizi' })
if (!created.ok) { console.error('✗ create 失败', created); process.exit(1) }
const id = created.taskId
console.log(`✓ 下旨 ${id}`)

const move = async (state, agent, extra = {}) => {
  const r = await call('edict_move', { taskId: id, state, agent, ...extra })
  return r
}

for (const [state, agent] of [['Taizi', 'taizi'], ['Zhongshu', 'zhongshu'], ['Menxia', 'zhongshu']]) {
  const r = await move(state, agent)
  if (!r.ok) { console.error(`✗ ${state} 失败`, r); process.exit(1) }
}

// 门下省封驳打回
const b = await move('Zhongshu', 'menxia', { now: '封驳：缺少回滚方案' })
if (!b.ok) { console.error('✗ 封驳失败', b); process.exit(1) }
console.log('✓ 门下省封驳 → 打回中书省')

// 重新走并推进到 Doing
for (const [state, agent] of [['Menxia', 'zhongshu'], ['Assigned', 'menxia'], ['Doing', 'shangshu']]) {
  const r = await move(state, agent)
  if (!r.ok) { console.error(`✗ ${state} 失败`, r); process.exit(1) }
}

// 六部拆 todo + 报进展
const t1 = await call('edict_todo', { taskId: id, todoId: '1', title: '定位瓶颈', status: 'in-progress', agent: 'gongbu' })
if (!t1.ok) { console.error('✗ todo 失败', t1); process.exit(1) }
const p = await call('edict_progress', { taskId: id, now: '正在看瀑布图', todos: '定位瓶颈✅|改实现🔄', tokens: 800, agent: 'gongbu' })
if (!p.ok) { console.error('✗ progress 失败', p); process.exit(1) }
console.log('✓ 六部报进展（todos 1/2）')

// 未完成就收口 → 必须被拒
const badDone = await call('edict_done', { taskId: id, agent: 'gongbu' })
if (badDone.ok) { console.error('✗ todos 未完成却允许收口'); process.exit(1) }
console.log(`✓ 未完成收口被拒：${badDone.reason}`)

// 完成剩下 todo 再收口
await call('edict_todo', { taskId: id, todoId: '2', title: '改实现', status: 'completed', agent: 'gongbu' })
const done = await call('edict_done', { taskId: id, summary: '已压到 0.8s', agent: 'gongbu' })
if (!done.ok) { console.error('✗ done 失败', done); process.exit(1) }
console.log('✓ 六部收口 → Review')

// Review → Done 是高风险，应落 PendingConfirm
const risky = await call('edict_move', { taskId: id, state: 'Done', agent: 'shangshu' })
if (!risky.pendingConfirm) { console.error('✗ 高风险未拦截', risky); process.exit(1) }
console.log(`✓ 高风险拦截 → PendingConfirm（确认方 ${risky.confirmBy}）`)

// 门下省批准
const approve = await call('edict_confirm', { taskId: id, action: 'approve', reason: '准', agent: 'menxia' })
if (!approve.ok) { console.error('✗ confirm 失败', approve); process.exit(1) }
console.log('✓ 门下省批准 → Done')

// 越权：六部改状态必须被拒
const denied = await call('edict_move', { taskId: id, state: 'Doing', agent: 'hubu' })
if (denied.ok) { console.error('✗ 越权未被拦截'); process.exit(1) }
console.log(`✓ 越权拦截：${denied.reason}`)

// 看板
const board = await call('edict_status', {})
console.log(`✓ 看板：共 ${board.total} 张，Done=${board.byState.Done}`)

// 审计
const audits = await registeredCommands.get('edict-audit').run({ limit: 100 })
const lines = String(audits.text).split('\n').filter(Boolean)
console.log(`✓ 审计 ${lines.length} 条，最后一条：${lines[lines.length - 1]}`)

// 角色文件
const role = await call('edict_role', { role: 'menxia' })
const roleFile = path.join(dir, 'current_role')
if (!fs.existsSync(roleFile) || fs.readFileSync(roleFile, 'utf8').trim() !== 'menxia') {
  console.error('✗ 角色文件未写入'); process.exit(1)
}
console.log(`✓ 角色切换落盘：${role.role}`)

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n冒烟测试全部通过 ✅')
