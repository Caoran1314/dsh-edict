/**
 * dsh-edict — 宿主半侧：把三省六部流程注册成 DSH 工具
 * ----------------------------------------------------------------------------
 * 设计要点：
 *   1. 每个命令一个工具，角色身份由工具所在的"衙门"上下文决定。
 *      DSH 的子代理没有独立环境变量（不像 OpenClaw 的 OPENCLAW_AGENT_ID），
 *      因此身份推断链为：显式 agent 参数 → EDICT_AGENT_ID 环境变量 →
 *      ~/.dsh/edict/current_role 文件 → 默认 taizi。
 *   2. 越权矩阵、状态机、高风险确认等规则全部在 lib/commands.mjs + lib/core.mjs，
 *      与 edict 原实现逐条对齐，工具层不做任何规则判断。
 *   3. 数据落在 ~/.dsh/edict/（tasks.json / audit_log.json / agent_memory.json /
 *      shared_memo.json），零依赖、原子写。
 *   4. 设置项用 dsh.commands 无 UI 注册（最稳的契约），不依赖 client 半侧。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EdictStore, resolveDataDir } from './core.mjs'
import { COMMANDS, boardData, taskDetail } from './commands.mjs'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* buildTools() 可被单独调用（测试/检视），execute 需要 store 时取这里 */
let currentStore = null
function getActiveStore() { return currentStore ?? new EdictStore({}) }
const NS = 'dsh-edict'

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0'
  } catch { return '0.0.0' }
})()

/* ── 身份解析 ─────────────────────────────────────────────────────── */
export function resolveAgent(explicit, store) {
  if (explicit) return String(explicit).trim()
  const env = (process.env.EDICT_AGENT_ID || '').trim()
  if (env) return env
  try {
    const f = path.join(store.dir, 'current_role')
    const v = fs.readFileSync(f, 'utf8').trim()
    if (v) return v
  } catch { /* 没有角色文件就用默认 */ }
  return 'taizi'
}

export function setCurrentRole(store, agent) {
  store.ensureDir()
  fs.writeFileSync(path.join(store.dir, 'current_role'), String(agent), 'utf8')
}

/* ── 工具定义 ─────────────────────────────────────────────────────── */
const ROLE_ENUM = ['taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao']
const AGENT_ARG = { type: 'string', enum: ROLE_ENUM, description: '以哪个衙门的身份执行（默认取当前角色，见 edict_role）' }

export function buildTools() {
  const tools = []

  /* 工具必须自带 execute 与 output（DSH 注册中心的硬性要求，见 registerTools 注释） */
  const add = (name, description, properties, required, cmd) => {
    tools.push(withOutput({
      name,
      description,
      parameters: { type: 'object', properties, required: required ?? [], additionalProperties: false },
      execute: async (args = {}) => {
        const store = getActiveStore()
        const agent = resolveAgent(args.agent, store)
        const fn = COMMANDS[cmd]
        if (typeof fn !== 'function') return { ok: false, error: `未知命令 ${cmd}` }
        if (cmd === 'status') return fn(store, args)
        return fn(store, args, agent)
      },
      cmd
    }))
  }

  add('edict_create', '下旨：创建一张新旨意（任务）。标题需 ≥6 字且不能是闲聊词，否则被拒。默认进入 Pending，由太子分拣。',
    { title: { type: 'string', description: '旨意标题' }, taskId: { type: 'string', description: '可选，自定义任务号' }, remark: { type: 'string' }, agent: AGENT_ARG },
    ['title'], 'create')

  add('edict_move', '状态流转：按三省六部状态机推进任务。非法转换会被拒绝并记审计；高风险转换（Review→Done / Doing→Cancelled / Menxia→Cancelled）不直接生效，先落 PendingConfirm 等确认。',
    { taskId: { type: 'string' }, state: { type: 'string', enum: ['Pending', 'Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing', 'Review', 'Done', 'Blocked', 'Cancelled', 'PendingConfirm'] }, now: { type: 'string', description: '当前进展一句话' }, agent: AGENT_ARG },
    ['taskId', 'state'], 'state')

  add('edict_flow', '记录一次部门间流转（不改状态机，只留痕并更新当前归属部门）。',
    { taskId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, remark: { type: 'string' }, agent: AGENT_ARG },
    ['taskId', 'to'], 'flow')

  add('edict_progress', '实时进展汇报：更新"现在在做什么"，可用 | 分隔的清单同步 todos（以 ✅ 结尾=已完成，🔄=进行中，其他=未开始）。不改状态。',
    { taskId: { type: 'string' }, now: { type: 'string' }, todos: { type: 'string', description: '如 "读代码✅|改实现🔄|写测试"' }, tokens: { type: 'number' }, cost: { type: 'number' }, elapsed: { type: 'number' }, agent: AGENT_ARG },
    ['taskId', 'now'], 'progress')

  add('edict_todo', '新增或更新子任务 todo。硬约束：同一时刻最多只能有 1 个 in-progress。全部完成会置 ready_to_close。',
    { taskId: { type: 'string' }, todoId: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'] }, detail: { type: 'string' }, agent: AGENT_ARG },
    ['taskId', 'todoId'], 'todo')

  add('edict_done', '执行部门回报完成：任务转入 Review 待尚书省汇总。前置硬校验——当前状态必须是 Doing/Next，且 todos 全部完成，否则拒绝。',
    { taskId: { type: 'string' }, summary: { type: 'string' }, outputPath: { type: 'string' }, agent: AGENT_ARG },
    ['taskId'], 'done')

  add('edict_block', '标记任务阻塞并记录原因。',
    { taskId: { type: 'string' }, reason: { type: 'string' }, agent: AGENT_ARG },
    ['taskId', 'reason'], 'block')

  add('edict_confirm', '批准或驳回 PendingConfirm 里的高风险操作。approve→落到目标状态；reject→退回 Review（复审）。',
    { taskId: { type: 'string' }, action: { type: 'string', enum: ['approve', 'reject'] }, reason: { type: 'string' }, agent: AGENT_ARG },
    ['taskId', 'action'], 'confirm')

  add('edict_delegate', '把子任务委派给下游衙门（受权限链限制）。防死锁：委派深度上限 3，路径成环直接拒绝。',
    { taskId: { type: 'string' }, to: { type: 'string', enum: ROLE_ENUM }, instruction: { type: 'string' }, returnSpec: { type: 'string' }, agent: AGENT_ARG },
    ['taskId', 'to', 'instruction'], 'delegate')

  add('edict_delegate_result', '提交委派子任务的结果，回写父任务记忆，自身转入 Review。',
    { taskId: { type: 'string' }, result: { type: 'object', description: '任意结果对象' }, agent: AGENT_ARG },
    ['taskId'], 'delegate-result')

  add('edict_memory', '写入本衙门记忆（跨任务复用），单 Agent 上限 200 条，pinned 优先保留。',
    { type: { type: 'string', description: 'note / lesson / preference 等' }, content: { type: 'string' }, sourceTask: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, agent: AGENT_ARG },
    ['content'], 'memory')

  add('edict_task_memo', '给任务写决策与警示备忘（decisions / warnings）。',
    { taskId: { type: 'string' }, decisions: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } }, agent: AGENT_ARG },
    ['taskId'], 'task-memo')

  add('edict_shared_memo', '写全局共享备忘（跨衙门可见）。',
    { content: { type: 'string' }, agent: AGENT_ARG },
    ['content'], 'shared-memo')

  add('edict_status', '查看军机处看板：不传 taskId 时返回各状态数量与全部在办任务；传 taskId 返回该任务的完整详情（状态、部门、todos、流转链、待确认项、委派链）。',
    { taskId: { type: 'string' } },
    [], 'status')

  /* 角色切换：给没有环境变量能力的子代理一个显式入口 */
  tools.push(withOutput({
    name: 'edict_role',
    description: '设置或查看当前以哪个衙门身份执行（taizi/zhongshu/menxia/shangshu/六部）。子代理开工前先调一次，越权矩阵才会按你的身份生效。',
    parameters: { type: 'object', properties: { role: { type: 'string', enum: ROLE_ENUM }, agent: AGENT_ARG }, required: [], additionalProperties: false },
    execute: async (args = {}) => {
      const store = getActiveStore()
      if (args.role) {
        setCurrentRole(store, args.role)
        return { ok: true, cmd: 'role', role: args.role, dataDir: store.dir }
      }
      return { ok: true, cmd: 'role', role: resolveAgent(args.agent, store), dataDir: store.dir }
    },
    cmd: 'role'
  }))

  return tools
}

/* ── 工具注册 ─────────────────────────────────────────────────────────
 * ★ 真实契约（踩坑实录，写进 dsh-plugin-authoring 技能）：
 *   1. 工具必须声明 output { schema, render }，否则 tools.register() 抛
 *        'tool "x" must declare output { schema, render, presentationMeta? }'
 *      而且该异常会被**静默吞掉** —— 现象是"插件加载成功但一个工具都没注册"。
 *   2. apply() 执行时 'tools' / 'webServer' 服务**可能尚未就绪**，
 *      必须监听 internal/service 并配定时重试兜底，否则工具与路由全都注册不上
 *      （dsh-edict 0.1.2 之前就是这样：看板路由返回裸 401、工具全无）。
 * ─────────────────────────────────────────────────────────────────── */
function textBlock(text) { return [{ type: 'text', text }] }

/** 统一的返回值渲染：把对象结果转成内容块 */
function renderResult(value) {
  try {
    return textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  } catch { return textBlock(String(value)) }
}

/** 给工具补齐 output（DSH 注册中心的硬性要求） */
function withOutput(def) {
  if (def.output?.schema && typeof def.output.render === 'function') return def
  return {
    ...def,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderResult(value)
    }
  }
}

/** 注册一批工具；返回成功数。tools 服务未就绪时返回 0（等重试） */
function registerTools(ctx, defs, state) {
  const toolsService = (typeof ctx.get === 'function' ? ctx.get('tools') : undefined) || ctx.tools
  if (!toolsService || typeof toolsService.register !== 'function') return 0
  if (state.done) return defs.length

  let count = 0
  for (const raw of defs) {
    const tool = withOutput(raw)
    if (!tool.output?.schema || typeof tool.output.render !== 'function') {
      try { ctx.logger?.warn?.(`[${NS}] 工具 ${tool.name} 缺少 output，跳过`) } catch {}
      continue
    }
    try {
      ctx.effect(() => toolsService.register(tool))
      count += 1
    } catch (e) {
      try { ctx.logger?.warn?.(`[${NS}] 工具 ${tool.name} 注册失败: ${String(e?.message ?? e)}`) } catch {}
    }
  }
  if (count > 0) state.done = true
  return count
}

/** 注册看板路由；返回成功数。webServer 未就绪时返回 0（等重试） */
function registerBoardRoutes(ctx, store, state) {
  const webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) || ctx.webServer
  const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
  if (!webServer || typeof webServer.register !== 'function') return 0
  if (state.done) return 4

  const rejected = (req, res) => {
    try {
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch { return false }
  }
  const sendJson = (res, payload, code = 200) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) })
    res.end(body)
  }
  const sendHtml = (res, html) => {
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) })
    res.end(body)
  }

  let count = 0
  const route = (p, handler) => {
    try {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: p,
        handler: async (req, res) => { if (rejected(req, res)) return; return handler(req, res) }
      }))
      count += 1
    } catch (e) {
      try { ctx.logger?.warn?.(`[${NS}] 路由 ${p} 注册失败: ${String(e?.message ?? e)}`) } catch {}
    }
  }

  route('/edict/board', (req, res) => sendJson(res, { ok: true, version: VERSION, ...boardData(store) }))
  route('/edict/audit', (req, res) => {
    const url = String(req.url || '')
    const m = /[?&]limit=(\d+)/.exec(url)
    const taskId = (/[?&]task=([^&]+)/.exec(url) || [])[1]
    sendJson(res, { ok: true, logs: store.listAudit(Math.min(500, Number(m?.[1]) || 60), taskId ? decodeURIComponent(taskId) : null) })
  })
  route('/edict/task', (req, res) => {
    const url = String(req.url || '')
    const id = (/[?&]id=([^&]+)/.exec(url) || [])[1]
    const task = id ? taskDetail(store, decodeURIComponent(id)) : null
    if (!task) { sendJson(res, { ok: false, error: 'task not found' }, 404); return }
    sendJson(res, { ok: true, task })
  })
  /* 独立看板的「带凭据 URL」
   * 新标签页的顶层导航不会自带浏览器凭据，必须由宿主生成带 token 的地址。
   * 真实签名（从 dsh-host-frontend-static 挖出）：
   *   ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)  → 返回带凭据的 URL 字符串
   * 即：传【完整 base URL】，不是 (req, path)。返回值可能是 `base?token=x` 或 `base/xxx?token=x`。 */
  route('/edict/url', (req, res) => {
    const result = { ok: false, url: null, note: '' }
    try {
      const port = webServer.port ?? webServer.listenedPort
      const host = (req.headers?.host) || (port ? `127.0.0.1:${port}` : null)
      if (!conn || typeof conn.authenticatedUrl !== 'function') {
        result.note = '宿主没有 connection.authenticatedUrl；请从应用内打开看板（面板里已内嵌）。'
      } else if (!host) {
        result.note = '拿不到 webServer.port / Host 头，无法构造 base URL。'
      } else {
        const authed = conn.authenticatedUrl(`http://${host}`)
        if (typeof authed !== 'string' || !authed) {
          result.note = 'authenticatedUrl 未返回字符串。'
        } else {
          /* 把 /edict 路径塞进去，同时保留它附带的查询串（token 就在其中） */
          const u = new URL(authed)
          u.pathname = '/edict'
          result.ok = true
          result.url = u.toString()
          result.note = '用这个地址打开（已带凭据）'
        }
      }
    } catch (e) {
      result.note = '生成凭据地址失败：' + String(e?.message ?? e)
    }
    sendJson(res, result)
  })
  route('/edict', (req, res) => sendHtml(res, standaloneBoardHtml(VERSION)))

  if (count > 0) state.done = true
  return count
}

const name = NS
/* webServer/connection 用于注册看板路由；没有它们的 profile（桌面端 file:// + IPC）
   仍然可以加载插件与工具，只是少了看板 UI。 */
const inject = ['webServer', 'connection']

/** 加载证据：便于区分"没加载"与"加载了但没注册" */
function writeLoadMarker(tools, routes, dirOverride) {
  try {
    const dir = dirOverride || resolveDataDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'last-load.json'), JSON.stringify({
      version: VERSION, at: new Date().toISOString(), tools, routes,
      node: process.version, platform: process.platform
    }, null, 2), 'utf8')
  } catch { /* 写不了不影响加载 */ }
}

function apply(ctx, config = {}) {
  const store = new EdictStore({ dataDir: config.dataDir, dshHome: config.dshHome })
  store.ensureDir()
  currentStore = store   // buildTools() 里的 execute 通过 getActiveStore() 取它

  const toolDefs = buildTools()
  const toolState = { done: false }
  const routeState = { done: false }
  let registered = registerTools(ctx, toolDefs, toolState)
  let boardRoutes = registerBoardRoutes(ctx, store, routeState)

  const retry = (why) => {
    if (!toolState.done) {
      const n = registerTools(ctx, toolDefs, toolState)
      if (n) registered = n
    }
    if (!routeState.done) {
      const n = registerBoardRoutes(ctx, store, routeState)
      if (n) boardRoutes = n
    }
    if (toolState.done && routeState.done) {
      writeLoadMarker(registered, boardRoutes, store.dir)
      return true
    }
    return false
  }

  /* 服务可能晚于 apply() 就绪 —— 事件 + 定时重试双保险 */
  try { ctx.on?.('internal/service', () => retry('internal/service')) } catch {}
  let tries = 0
  const timer = setInterval(() => {
    tries += 1
    if (retry('timer') || tries >= 12) {
      clearInterval(timer)
      writeLoadMarker(registered, boardRoutes, store.dir)
    }
  }, 1500)
  try { if (typeof timer.unref === 'function') timer.unref() } catch {}

  writeLoadMarker(registered, boardRoutes, store.dir)

  /* 无 UI 的设置入口（dsh.commands 是最稳的契约，不依赖 client 半侧） */
  const registerCommand = (name_, description, run) => {
    try {
      if (ctx.commands?.register) {
        ctx.commands.register({ name: name_, description, run })
        return true
      }
    } catch { /* 命令注册失败不影响工具 */ }
    try {
      if (ctx.commands?.add) {
        ctx.commands.add({ name: name_, description, run })
        return true
      }
    } catch { /* 同上 */ }
    return false
  }

  registerCommand('edict', '三省六部：查看军机处看板', async () => {
    const r = await COMMANDS.status(store, {})
    const lines = [`三省六部 · 军机处看板  (dsh-edict v${VERSION})`, `在办 ${r.active.length} / 共 ${r.total}`, '']
    for (const [s, n] of Object.entries(r.byState)) if (n) lines.push(`  ${s.padEnd(15)} ${n}`)
    lines.push('', '在办任务:')
    for (const t of r.active) lines.push(`  [${t.state}] ${t.id} ${t.title ?? ''} — ${t.now ?? ''}`)
    lines.push('', `数据目录: ${store.dir}`)
    return { ok: true, text: lines.join('\n') }
  })

  registerCommand('edict-audit', '三省六部：查看审计日志（默认最近 30 条）', async (args = {}) => {
    const logs = store.listAudit(Number(args.limit) || 30, args.taskId ?? null)
    const lines = logs.map((l) => `${l.ts} ${String(l.agent).padEnd(9)} ${String(l.action).padEnd(20)} ${l.from ?? ''}→${l.to ?? ''} ${l.reason ?? ''}`)
    return { ok: true, text: lines.join('\n') || '（无审计记录）' }
  })

  registerCommand('edict-reset-role', '三省六部：清空当前角色（回到默认 taizi）', async () => {
    try { fs.unlinkSync(path.join(store.dir, 'current_role')) } catch {}
    return { ok: true, text: '已清空当前角色，默认 taizi' }
  })


  try {
    ctx.logger?.info?.(`[${NS}] v${VERSION} 已加载：注册 ${registered} 个工具，看板路由 ${boardRoutes} 条，数据目录 ${store.dir}`)
  } catch { /* 日志失败不影响加载 */ }

  return { store, registered, boardRoutes, totalTools: toolDefs.length }
}

/* ── 独立看板页（零依赖静态 HTML）───────────────────────────────────── */
function standaloneBoardHtml(version) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>三省六部 · 军机处看板</title>
<style>
  :root{--bg:#0d0f12;--card:#141821;--line:#262c36;--ink:#e8eaee;--mut:#8a919c;--org:#ff7500;--ok:#3fbf6f;--bad:#ff5c5c;--warn:#d9a441}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.6 ui-monospace,"Cascadia Mono",Consolas,"Microsoft YaHei",monospace;padding:26px}
  h1{font-size:19px;letter-spacing:.14em;margin:0 0 4px}
  .sub{color:var(--mut);font-size:12px;margin-bottom:18px}
  .cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;margin-bottom:18px}
  .col{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 10px}
  .col.gate{border-color:var(--org)}.col.ok{border-color:var(--ok)}.col.bad{border-color:var(--bad)}
  .colTop{display:flex;justify-content:space-between;align-items:baseline}
  .st{font-size:11.5px}.num{font-size:18px;font-weight:700}
  .org{color:var(--mut);font-size:10.5px;margin-top:3px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:16px}
  .sect{color:var(--mut);font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px}
  .row{border-bottom:1px solid var(--line);padding:8px 0;cursor:pointer}
  .row:last-child{border-bottom:0}
  .row:hover{background:#181d27}
  .badge{border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:10px;margin-right:6px}
  .badge.gate{border-color:var(--org);color:var(--org)}
  .badge.block{border-color:var(--warn);color:var(--warn)}
  .id{color:var(--mut);font-size:11px}
  .now{color:#b9c0cb;font-size:11.5px;margin-top:2px}
  .log{max-height:300px;overflow:auto;font-size:11px}
  .logRow{display:flex;gap:8px}.ts{color:var(--mut);flex:none}.act{min-width:140px;flex:none}
  .det{border-top:1px solid var(--line);margin-top:8px;padding-top:8px;font-size:11.5;color:#c6ccd6;white-space:pre-wrap}
  .empty{color:var(--mut)}
  button{background:#1b212c;border:1px solid var(--line);color:var(--ink);border-radius:7px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
  button:hover{border-color:var(--org)}
</style></head>
<body>
  <h1>三省六部 · 军机处看板</h1>
  <div class="sub">dsh-edict v${version} · 数据每 3 秒自动刷新 · 流程设计源自 cft0808/edict (MIT)</div>
  <div class="cols" id="cols"></div>
  <div class="card"><div class="sect">在办旨意</div><div id="active"></div></div>
  <div class="card"><div class="sect">奏折阁 · 最近审计</div><div class="log" id="log"></div></div>
  <button onclick="load()">立即刷新</button>
<script>
var ORDER=['Pending','Taizi','Zhongshu','Menxia','Assigned','Next','Doing','Review','PendingConfirm','Blocked','Done','Cancelled'];
var ORG={Taizi:'太子·分拣',Zhongshu:'中书省·规划',Menxia:'门下省·审议',Assigned:'尚书省·派发',Review:'尚书省·汇总',PendingConfirm:'高风险·待确认',Pending:'中书省·待分拣',Next:'排队',Doing:'六部·执行',Blocked:'阻塞',Done:'终态',Cancelled:'终态'};
function cls(s){return s==='Menxia'||s==='PendingConfirm'||s==='Review'?'col gate':s==='Done'?'col ok':s==='Cancelled'?'col bad':'col'}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function ts(s){s=String(s||'');var i=s.indexOf('T');return i>0?s.slice(i+1,i+9):s}
function load(){
  fetch('/edict/board',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(b){
    document.getElementById('cols').innerHTML=ORDER.map(function(s){
      return '<div class="'+cls(s)+'"><div class="colTop"><span class="st">'+s+'</span><span class="num">'+(b.byState[s]||0)+'</span></div><div class="org">'+(ORG[s]||'')+'</div></div>'}).join('');
    var a=b.active||[];
    document.getElementById('active').innerHTML=a.length?a.map(function(t){
      return '<div class="row" onclick="detail(\\''+t.id+'\\',this)"><span class="badge">'+esc(t.org||'-')+'</span>'
        +(t.pendingConfirm?'<span class="badge gate">待确认</span>':'')
        +(t.blocked?'<span class="badge block">阻塞</span>':'')
        +'<span class="id">'+esc(t.id)+'</span>'
        +'<div class="now">'+esc(t.title||'')+(t.now?' — '+esc(t.now):'')+'</div></div>'}).join('')
      :'<div class="empty">暂无在办任务</div>';
  });
  fetch('/edict/audit?limit=40',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    var logs=(j.logs||[]).slice().reverse();
    document.getElementById('log').innerHTML=logs.length?logs.map(function(l){
      return '<div class="logRow"><span class="ts">'+ts(l.ts)+'</span><span class="act">'+esc(l.action)+'</span><span>'
        +esc((l.agent?l.agent+' ':'')+(l.from||'')+(l.to?'→'+l.to:'')+(l.reason?'  '+l.reason:''))+'</span></div>'}).join('')
      :'<div class="empty">暂无审计记录</div>';
  });
}
function detail(id,el){
  fetch('/edict/task?id='+encodeURIComponent(id),{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    if(!j.task)return;
    var t=j.task;
    var old=el.querySelector('.det'); if(old){old.remove();return;}
    var d=document.createElement('div'); d.className='det';
    d.textContent='state='+t.state+'  org='+t.org+'  official='+t.official
      +'\\ntodos='+(t.todos?t.todos.completed+'/'+t.todos.total:'0/0')
      +(t.pendingConfirm?'\\n待确认: '+t.pendingConfirm.target_state+' ← 需 '+t.pendingConfirm.confirm_by:'')
      +(t.blocked?'\\n阻塞: '+t.blocked:'')
      +(t.parent?'\\n父任务: '+t.parent:'')
      +'\\n'+(t.flow||[]).map(function(f){return ts(f.at)+' '+f.from+' → '+f.to+(f.remark?'  '+f.remark:'')}).join('\\n');
    el.appendChild(d);
  });
}
load(); setInterval(load,3000);
</script></body></html>`
}

export { name, inject, apply, VERSION, resolveDataDir }
export default { name, inject, apply }
