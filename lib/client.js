/**
 * dsh-edict — 浏览器半侧：军机处看板（设置页「三省六部」面板）
 * ----------------------------------------------------------------------------
 * 以 dsh.client bundle 格式加载（手写 ModuleLoader bundle，无需构建）。
 * 数据全部来自宿主半侧的 HTTP API（/edict/board、/edict/audit、/edict/task），
 * 面板本身不实现任何规则判断。
 *
 * 注册 id 必须等于 loader entry 名（dsh-edict）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-edict',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /* ── 样式 ─────────────────────────────────────────────────────────── */
    var CSS = [
      '.ed_root{max-width:900px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ed_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.ed_title{font-size:14px;font-weight:700;letter-spacing:.04em}',
      '.ed_ver{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.ed_hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.ed_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px}',
      '.ed_sect{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:9px}',
      '.ed_cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:8px}',
      '.ed_col{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 9px;background:var(--dsw-alias-bg-layer-3)}',
      '.ed_col.gate{border-color:#ff7500}',
      '.ed_col.ok{border-color:#3fbf6f}',
      '.ed_col.bad{border-color:#ff5c5c}',
      '.ed_colTop{display:flex;align-items:baseline;justify-content:space-between;gap:6px}',
      '.ed_state{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}',
      '.ed_num{font-family:ui-monospace,Consolas,monospace;font-size:17px;font-weight:700}',
      '.ed_org{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:3px}',
      '.ed_rows{display:flex;flex-direction:column;gap:6px}',
      '.ed_row{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;cursor:pointer}',
      '.ed_row:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.ed_rowTop{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.ed_badge{font-family:ui-monospace,Consolas,monospace;font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2)}',
      '.ed_badge.gate{border-color:#ff7500;color:#ff7500}',
      '.ed_badge.block{border-color:#d9a441;color:#d9a441}',
      '.ed_id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.ed_now{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px}',
      '.ed_acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ed_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.ed_btn:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.ed_log{font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.75;max-height:260px;overflow:auto}',
      '.ed_logRow{display:flex;gap:8px}',
      '.ed_ts{color:var(--dsw-alias-label-tertiary);flex:none}',
      '.ed_act{flex:none;min-width:132px}',
      '.ed_detail{border-top:1px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:8px;font-size:12px}',
      '.ed_kv{display:grid;grid-template-columns:118px 1fr;gap:4px 10px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}',
      '.ed_k{color:var(--dsw-alias-label-tertiary)}',
      '.ed_flow{margin-top:6px;font-size:11px;font-family:ui-monospace,Consolas,monospace;line-height:1.7}',
      '.ed_msg{font-size:12px;color:var(--dsw-alias-label-tertiary)}'
    ].join('')

    function ensureCss() {
      if (document.getElementById('ed_panel_css')) return
      var s = document.createElement('style')
      s.id = 'ed_panel_css'
      s.textContent = CSS
      document.head.appendChild(s)
    }

    /* 状态分级：终态 / 闸门 / 常规 */
    var GATE = { Menxia: 1, PendingConfirm: 1, Review: 1 }
    var OK = { Done: 1 }
    var BAD = { Cancelled: 1 }

    function colClass(state) {
      if (GATE[state]) return 'ed_col gate'
      if (OK[state]) return 'ed_col ok'
      if (BAD[state]) return 'ed_col bad'
      return 'ed_col'
    }

    var STATE_ORDER = ['Pending', 'Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing', 'Review', 'PendingConfirm', 'Blocked', 'Done', 'Cancelled']

    function Panel() {
      ensureCss()
      var [board, setBoard] = react.useState(null)
      var [audit, setAudit] = react.useState([])
      var [detail, setDetail] = react.useState(null)
      var [msg, setMsg] = react.useState('')

      function load() {
        setMsg('载入中…')
        fetch('/edict/board', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((j) => { setBoard(j); setMsg('') })
          .catch((e) => setMsg('看板载入失败：' + String(e && e.message || e)))
        fetch('/edict/audit?limit=40', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((j) => setAudit((j && j.logs) || []))
          .catch(() => {})
      }

      react.useEffect(function () { load() }, [])

      function openTask(id) {
        fetch('/edict/task?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((j) => setDetail(j && j.task ? j.task : null))
          .catch(() => setMsg('任务详情载入失败'))
      }

      if (!board) return h('div', { className: 'ed_root' }, h('div', { className: 'ed_hint' }, msg || '载入中…'))

      var byState = board.byState || {}
      var active = board.active || []

      return h('div', { className: 'ed_root' },
        h('div', { className: 'ed_head' },
          h('div', { className: 'ed_title' }, '三省六部 · 军机处看板'),
          h('span', { className: 'ed_ver' }, 'dsh-edict v' + (board.version || '?')),
          h('span', { className: 'ed_ver' }, '共 ' + board.total + ' 张旨意 / 在办 ' + active.length)
        ),
        h('div', { className: 'ed_hint' },
          '门下省（Menxia）是架构内的强制质量闸门：不通过就封驳打回中书省重做。' +
          '高风险操作（Review→Done 等）会先落到 PendingConfirm，等对应衙门批准或驳回。'),

        h('div', { className: 'ed_card' },
          h('div', { className: 'ed_sect' }, '各状态分布'),
          h('div', { className: 'ed_cols' },
            STATE_ORDER.map(function (s) {
              return h('div', { key: s, className: colClass(s) },
                h('div', { className: 'ed_colTop' },
                  h('span', { className: 'ed_state' }, s),
                  h('span', { className: 'ed_num' }, String(byState[s] || 0))
                ),
                h('div', { className: 'ed_org' }, orgOf(s))
              )
            })
          )
        ),

        h('div', { className: 'ed_card' },
          h('div', { className: 'ed_sect' }, '在办旨意'),
          active.length === 0
            ? h('div', { className: 'ed_hint' }, '暂无在办任务。用 edict_create 下一道旨意试试。')
            : h('div', { className: 'ed_rows' }, active.map(function (t) {
                var isGate = t.state === 'PendingConfirm'
                var isBlocked = t.state === 'Blocked'
                return h('div', { key: t.id, className: 'ed_row', onClick: function () { openTask(t.id) } },
                  h('div', { className: 'ed_rowTop' },
                    h('span', { className: 'ed_state' }, t.state),
                    h('span', { className: 'ed_badge' }, t.org || '-'),
                    isGate ? h('span', { className: 'ed_badge gate' }, '待确认') : null,
                    isBlocked ? h('span', { className: 'ed_badge block' }, '阻塞') : null,
                    h('span', { className: 'ed_id' }, t.id)
                  ),
                  h('div', { className: 'ed_now' }, (t.title || '') + (t.now ? '  —  ' + t.now : '')),
                  detail && detail.id === t.id ? renderDetail(detail) : null
                )
              }))
        ),

        h('div', { className: 'ed_card' },
          h('div', { className: 'ed_sect' }, '奏折阁 · 最近审计'),
          audit.length === 0
            ? h('div', { className: 'ed_hint' }, '暂无审计记录')
            : h('div', { className: 'ed_log' }, audit.slice().reverse().map(function (l, i) {
                return h('div', { key: i, className: 'ed_logRow' },
                  h('span', { className: 'ed_ts' }, shortTs(l.ts)),
                  h('span', { className: 'ed_act' }, String(l.action || '')),
                  h('span', null, (l.agent ? l.agent + ' ' : '') + (l.from || '') + (l.to ? '→' + l.to : '') + (l.reason ? '  ' + l.reason : ''))
                )
              }))
        ),

        h('div', { className: 'ed_acts' },
          h('button', { className: 'ed_btn', onClick: load }, '刷新'),
          h('button', { className: 'ed_btn', onClick: function () {
            setMsg('正在获取带凭据的看板地址…')
            fetch('/edict/url', { credentials: 'same-origin' })
              .then(function (r) { return r.json() })
              .then(function (j) {
                if (j && j.url) { setMsg(''); window.open(j.url, '_blank', 'noopener') }
                else { setMsg('宿主未提供带凭据地址；看板已内嵌在本面板，可直接在此查看。') }
              })
              .catch(function (e) { setMsg('获取地址失败：' + String(e && e.message || e)) })
          } }, '打开独立看板'),
          msg ? h('span', { className: 'ed_msg' }, msg) : null
        )
      )
    }

    function orgOf(state) {
      var m = {
        Taizi: '太子 · 分拣', Zhongshu: '中书省 · 规划', Menxia: '门下省 · 审议',
        Assigned: '尚书省 · 派发', Review: '尚书省 · 汇总', PendingConfirm: '高风险 · 待确认',
        Pending: '中书省 · 待分拣', Next: '排队', Doing: '六部 · 执行',
        Blocked: '阻塞', Done: '终态', Cancelled: '终态'
      }
      return m[state] || ''
    }

    function shortTs(ts) {
      var s = String(ts || '')
      var i = s.indexOf('T')
      return i > 0 ? s.slice(i + 1, i + 9) : s
    }

    function renderDetail(t) {
      var todo = t.todos || { completed: 0, total: 0 }
      return h('div', { className: 'ed_detail' },
        h('div', { className: 'ed_kv' },
          h('span', { className: 'ed_k' }, 'title'), h('span', null, t.title || '-'),
          h('span', { className: 'ed_k' }, 'state'), h('span', null, t.state),
          h('span', { className: 'ed_k' }, 'org'), h('span', null, t.org || '-'),
          h('span', { className: 'ed_k' }, 'official'), h('span', null, t.official || '-'),
          h('span', { className: 'ed_k' }, 'todos'), h('span', null, (todo.completed || 0) + '/' + (todo.total || 0)),
          t.pendingConfirm ? h('span', { className: 'ed_k' }, '待确认') : null,
          t.pendingConfirm ? h('span', null, (t.pendingConfirm.target_state || '?') + ' ← 需 ' + (t.pendingConfirm.confirm_by || '?')) : null,
          t.blocked ? h('span', { className: 'ed_k' }, '阻塞原因') : null,
          t.blocked ? h('span', null, t.blocked) : null,
          t.parent ? h('span', { className: 'ed_k' }, '父任务') : null,
          t.parent ? h('span', null, t.parent) : null
        ),
        (t.flow && t.flow.length)
          ? h('div', { className: 'ed_flow' }, t.flow.map(function (f, i) {
              return h('div', { key: i }, shortTs(f.at) + '  ' + (f.from || '') + ' → ' + (f.to || '') + (f.remark ? '  ' + f.remark : ''))
            }))
          : null
      )
    }

    /* ── 插件 ─────────────────────────────────────────────────────────── */
    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'edict', order: 28, label: '三省六部' },
          function () { return h(Panel, {}) }
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
