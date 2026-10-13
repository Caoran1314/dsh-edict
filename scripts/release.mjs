#!/usr/bin/env node
/**
 * release.mjs — DSH 插件/技能一键发布
 * ----------------------------------------------------------------------------
 * 一条命令走完全部发布点，替代手工依次执行 8 件事：
 *
 *   1. 版本号检查/递增（package.json）
 *   2. 语法检查 + 全部测试
 *   3. CHANGELOG 校验（必须有对应版本小节）
 *   4. git commit + push（main）
 *   5. git tag + push tag
 *   6. GitHub Release（用 CHANGELOG 对应小节作为正文）
 *   7. npm publish --access public
 *   8. 等 npm 索引 → 校验线上 tarball 关键字段（dsh.bundle / dsh.client / exports）
 *   9. 报告：把 npm 版本装进 profile 的命令（不自动动 profile）
 *
 * 用法：
 *   node release.mjs                       # 用 package.json 里的当前版本发布
 *   node release.mjs patch|minor|major     # 先递增版本再发布
 *   node release.mjs patch --dry           # 只演练，不推送/不发布
 *   node release.mjs --profile             # 额外把新版本装进 desktop profile
 *
 * 凭据（环境变量，缺失时只跳过对应步骤）：
 *   GH_TOKEN   GitHub token（建 Release 用；不设则跳过 Release，仍会 push）
 *   NPM_TOKEN  npm granular token（Bypass 2FA；不设则跳过 npm 发布）
 *   DSH_PROFILE  目标 profile 名，默认 desktop
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'

const ROOT = process.cwd()
const ARGS = process.argv.slice(2)
const DRY = ARGS.includes('--dry')
const INSTALL = ARGS.includes('--profile')
const BUMP = ARGS.find((a) => ['patch', 'minor', 'major'].includes(a)) || null

const NODE = process.execPath
const NPM_CLI = 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js'
const PNPM = 'C:/Program Files/nodejs/node_modules/corepack/shims/pnpm.cmd'
const PROFILE_NAME = process.env.DSH_PROFILE || 'desktop'
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', PROFILE_NAME)

const log = (s) => console.log(s)
const step = (n, s) => console.log(`\n[${n}] ${s}`)
const fail = (s) => { console.error('\n✗ ' + s); process.exit(1) }

function run(cmd, args, opts = {}) {
  /* 注意：opts 要覆盖默认 cwd，不能写成 {...opts, cwd: ROOT}（那会吞掉调用方传的 cwd） */
  const { cwd = ROOT, ...rest } = opts
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...rest, cwd })
  return { code: r.status ?? -1, out: String(r.stdout || ''), err: String(r.stderr || ''), all: String((r.stdout || '') + (r.stderr || '')) }
}
function git(args, opts) { return run('git', args, opts) }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, j) => fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8')   // 无 BOM

/* ── 0. 前置检查 ───────────────────────────────────────────────────── */
step(0, '前置检查')
if (!fs.existsSync(path.join(ROOT, 'package.json'))) fail('当前目录没有 package.json')
const pkgPath = path.join(ROOT, 'package.json')
let pkg = readJson(pkgPath)
if (!pkg.name) fail('package.json 缺 name')
log(`  包名 ${pkg.name}  当前版本 ${pkg.version}`)
log(`  GitHub token: ${process.env.GH_TOKEN ? '有' : '无（跳过 Release）'}`)
log(`  npm token   : ${process.env.NPM_TOKEN ? '有' : '无（跳过 npm）'}`)
if (DRY) log('  模式: --dry（不推送、不发布）')

/* ── 1. 版本递增 ───────────────────────────────────────────────────── */
if (BUMP) {
  step(1, `版本递增 (${BUMP})`)
  const [a, b, c] = String(pkg.version).split('.').map(Number)
  const next = BUMP === 'major' ? `${a + 1}.0.0` : BUMP === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
  log(`  ${pkg.version} → ${next}`)
  if (!DRY) { pkg.version = next; writeJson(pkgPath, pkg) }
} else {
  step(1, '版本（用现有值）')
  log(`  ${pkg.version}`)
}
const VERSION = pkg.version

/* ── 2. 语法 + 测试 ────────────────────────────────────────────────── */
step(2, '语法检查与测试')
const libFiles = fs.existsSync(path.join(ROOT, 'lib'))
  ? fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join('lib', f))
  : []
for (const f of libFiles) {
  const r = run(NODE, ['--check', f])
  if (r.code !== 0) fail(`语法错误 ${f}\n${r.all}`)
}
log(`  ✓ 语法 ${libFiles.length} 个文件通过`)
const testDir = path.join(ROOT, 'test')
if (fs.existsSync(testDir)) {
  for (const t of fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs'))) {
    const r = run(NODE, [path.join('test', t)])
    const last = r.all.trim().split('\n').filter(Boolean).slice(-1)[0] || ''
    if (r.code !== 0) fail(`${t} 失败\n${r.all}`)
    log(`  ✓ ${t} — ${last.trim()}`)
  }
} else log('  （无 test/ 目录）')

/* ── 3. CHANGELOG 校验 ─────────────────────────────────────────────── */
step(3, 'CHANGELOG 校验')
const clPath = path.join(ROOT, 'CHANGELOG.md')
let releaseNotes = `## ${pkg.name} v${VERSION}\n\n（无 CHANGELOG 记录）`
if (fs.existsSync(clPath)) {
  const cl = fs.readFileSync(clPath, 'utf8')
  const m = cl.split(/\n(?=## \[)/).find((s) => s.startsWith(`## [${VERSION}]`))
  if (!m) fail(`CHANGELOG.md 缺少 "## [${VERSION}]" 小节 —— 先补上再发布`)
  releaseNotes = m.trim()
  log(`  ✓ 找到 [${VERSION}] 小节（${releaseNotes.length} 字符）`)
} else log('  · 无 CHANGELOG.md，Release 正文用占位')

/* ── 4. git 提交并推送 ──────────────────────────────────────────── */
step(4, 'git 提交并推送')
const st = git(['status', '--short'])

/* ★ 安全闸门：绝不允许把凭据提交上去。
   真实事故：本脚本用 `git add -A`，而发布过程中会临时写一个含 npm token 的 .npmrc
   （虽然 .gitignore 里有 .npmrc，但只要它曾被跟踪过、或忽略规则被改动就会漏出去）。
   GitHub 的 push protection 拦住了那次推送，但本地提交里确实带上了 token —— 靠人记得删不可靠，
   所以在提交前主动扫描并拒绝。 */
const FORBIDDEN_PATHS = ['.npmrc', '.env', 'id_rsa', 'id_ed25519', 'credentials.json']
const SECRET_PATTERNS = [
  [/\bnpm_[A-Za-z0-9]{20,}/, 'npm token'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token (classic)'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub token (fine-grained)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥']
]
function assertNoSecrets(paths) {
  const bad = []
  for (const p of paths) {
    const base = path.basename(p)
    if (FORBIDDEN_PATHS.includes(base)) { bad.push(`${p} —— 凭据文件名（应加入 .gitignore）`); continue }
    const full = path.join(ROOT, p)
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue
    let text = ''
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) { bad.push(`${p} —— 内含 ${label}`); break }
    }
  }
  return bad
}

if (st.out.trim()) {
  log('  待提交:\n' + st.out.trim().split('\n').map((l) => '    ' + l).join('\n'))
  if (!DRY) {
    git(['add', '-A'])
    /* 扫描**已暂存**的文件（这才是真正会被提交的内容） */
    const staged = git(['diff', '--cached', '--name-only']).out.split('\n').map((s) => s.trim()).filter(Boolean)
    const violations = assertNoSecrets(staged)
    if (violations.length) {
      git(['reset'])
      fail('检测到凭据，已撤销暂存；请把下列文件加入 .gitignore 后重试:\n' +
        violations.map((v) => '    ✗ ' + v).join('\n'))
    }
    /* 再兜底扫一遍完整补丁文本（防止多行/编码绕过） */
    const patch = git(['diff', '--cached']).out
    const patchHits = SECRET_PATTERNS.filter(([re]) => re.test(patch)).map(([, l]) => l)
    if (patchHits.length) {
      git(['reset'])
      fail('暂存补丁里检测到凭据（' + patchHits.join(', ') + '），已撤销暂存')
    }
    log(`  ✓ 安全扫描通过（${staged.length} 个文件，无凭据）`)
    const c = git(['commit', '-m', `release: v${VERSION}`])
    if (c.code !== 0 && !/nothing to commit/.test(c.all)) fail('git commit 失败\n' + c.all)
    log('  ✓ 已提交')
  }
} else log('  · 工作区干净，无需提交')
if (!DRY) {
  const p = git(['push', 'origin', 'HEAD'])
  if (p.code !== 0) fail('git push 失败\n' + p.all)
  log('  ✓ 已推送 main')
}

/* ── 5. git tag ────────────────────────────────────────────────────── */
step(5, `git tag v${VERSION}`)
const tagName = `v${VERSION}`
const hasTag = git(['tag', '-l', tagName]).out.trim()
if (hasTag) log('  · tag 已存在，跳过')
else if (!DRY) {
  git(['tag', '-a', tagName, '-m', `${pkg.name} ${tagName}`])
  const p = git(['push', 'origin', tagName])
  if (p.code !== 0) fail('push tag 失败\n' + p.all)
  log(`  ✓ ${tagName} 已创建并推送`)
}

/* ── 6. GitHub Release ─────────────────────────────────────────────── */
step(6, 'GitHub Release')
const repoUrl = (pkg.repository?.url || '').replace(/^git\+/, '').replace(/\.git$/, '')
const slug = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+)/)?.[1]
if (!process.env.GH_TOKEN) log('  · 未设 GH_TOKEN，跳过')
else if (!slug) log('  · 无法从 repository 解析 owner/repo，跳过')
else if (DRY) log(`  · dry：将创建 ${slug} ${tagName}`)
else {
  const r = await fetch(`https://api.github.com/repos/${slug}/releases`, {
    method: 'POST',
    headers: { Authorization: 'token ' + process.env.GH_TOKEN, 'User-Agent': 'release-script', 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ tag_name: tagName, name: `${pkg.name} ${tagName}`, body: releaseNotes, draft: false, prerelease: false })
  })
  const t = await r.text()
  if (r.status === 201) log('  ✓ Release: ' + JSON.parse(t).html_url)
  else if (r.status === 422) log('  · Release 已存在，跳过')
  else fail(`建 Release 失败 HTTP ${r.status}: ${t.slice(0, 200)}`)
}

/* ── 7. npm publish（幂等：版本已存在则跳过）───────────────────────── */
step(7, 'npm publish')
const registryUrl = `https://registry.npmjs.org/${pkg.name}`
let alreadyPublished = false
try {
  const r = await fetch(`${registryUrl}/${VERSION}?t=${Date.now()}`, { headers: { 'User-Agent': 'release-script', 'Cache-Control': 'no-cache' } })
  alreadyPublished = r.status === 200
} catch { /* 查不到就当未发布 */ }

if (alreadyPublished) log(`  · ${pkg.name}@${VERSION} 已发布，跳过`)
else if (!process.env.NPM_TOKEN) log('  · 未设 NPM_TOKEN，跳过')
else if (DRY) log('  · dry：将执行 npm publish --access public')
else {
  const npmrc = path.join(ROOT, '.npmrc')
  const hadNpmrc = fs.existsSync(npmrc)
  const backup = hadNpmrc ? fs.readFileSync(npmrc, 'utf8') : null
  fs.writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\nregistry=https://registry.npmjs.org/\n`, 'ascii')
  try {
    const r = run(NODE, [NPM_CLI, 'publish', '--access', 'public', '--cache', 'D:/软件/_tools/npm-cache'])
    if (r.code !== 0 && /previously published versions/i.test(r.all)) {
      log('  · 版本已存在（并发/缓存），视为已发布')
    } else if (r.code !== 0) {
      fail('npm publish 失败\n' + r.all.slice(-1200))
    } else {
      const line = r.all.split('\n').find((l) => l.includes(`+ ${pkg.name}@`))
      log('  ✓ ' + (line || 'published').trim())
    }
  } finally {
    if (hadNpmrc) fs.writeFileSync(npmrc, backup, 'ascii'); else fs.rmSync(npmrc, { force: true })
  }
}

/* ── 8. 等索引 + 线上校验 ──────────────────────────────────────────── */
step(8, '等 npm 索引并校验线上产物')
if (!process.env.NPM_TOKEN && !DRY) log('  · 未发布，跳过')
else {
  const reg = `https://registry.npmjs.org/${pkg.name}`
  let meta = null
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await fetch(`${reg}/${VERSION}?t=${Date.now()}`, { headers: { 'User-Agent': 'release-script', 'Cache-Control': 'no-cache' } })
      if (r.status === 200) { meta = await r.json(); break }
      if (!DRY) process.stdout.write(`  等待索引 ${i}/20…\r`)
    } catch { /* 网络抖动，继续等 */ }
    await new Promise((x) => setTimeout(x, 12000))
  }
  if (!meta) log('  ⚠️ 20 次仍未索引（npm 处理慢，稍后自查）')
  else {
    log(`  ✓ 已索引  files=${meta.dist.fileCount}  license=${meta.license}`)
    const checks = []
    const patch = pkg.dsh?.bundle?.patch
    if (patch) checks.push(['dsh.bundle.patch', meta.dsh?.bundle?.patch === patch])
    if (pkg.dsh?.client) {
      checks.push(['exports["./client"]', !!meta.exports?.['./client']])
      checks.push(['dsh.client', !!meta.dsh?.client])
    }
    for (const [k, ok] of checks) log(`    ${ok ? '✓' : '✗'} ${k}`)
    if (checks.some(([, ok]) => !ok)) fail('线上产物缺少关键字段！')
  }
}

/* ── 9. 装进 profile ───────────────────────────────────────────────── */
step(9, '装入 profile')
if (!INSTALL) {
  log('  · 跳过（需要时加 --profile）')
  log(`    手动: npm install 完成后再执行`)
  log(`    node release.mjs --profile   # 或按下面命令`)
  log(`    cd "${PROFILE_DIR}" && pnpm install --config.minimumReleaseAge=1`)
} else if (!fs.existsSync(path.join(PROFILE_DIR, 'package.json'))) log(`  · profile 不存在: ${PROFILE_DIR}`)
else if (DRY) log('  · dry：将更新 profile 依赖并安装')
else {
  const pj = path.join(PROFILE_DIR, 'package.json')
  const j = readJson(pj)
  const prev = j.dependencies?.[pkg.name]
  j.dependencies = j.dependencies || {}
  j.dependencies[pkg.name] = `^${VERSION}`
  writeJson(pj, j)
  log(`  ${pkg.name}: ${prev || '(新增)'} → ^${VERSION}`)
  // 放行"刚发布太新"的版本
  const ws = path.join(PROFILE_DIR, 'pnpm-workspace.yaml')
  if (fs.existsSync(ws)) {
    let txt = fs.readFileSync(ws, 'utf8')
    const entry = `${pkg.name}@${VERSION}`
    if (!txt.includes(`- ${entry}`)) {
      txt = txt.trimEnd() + `\n  - ${entry}\n`
      fs.writeFileSync(ws, txt, 'utf8')
      log('  ✓ 已加入 pnpm 最小发布年龄白名单')
    }
  }
  /* Windows 上要经 cmd.exe 调 pnpm.cmd（Node 直接 spawn .cmd 会 EINVAL）；
     引号交给 Node（不要把引号写进参数里）。
     注意：pnpm 的错误在 **stdout** 而非 stderr，判定必须看 r.all。 */
  const pnpmExe = fs.existsSync(PNPM)
    ? '"' + PNPM.replace(/"/g, '') + '"'
    : 'pnpm'
  const r = run('cmd.exe', ['/d', '/s', '/c', `${pnpmExe} install --config.minimumReleaseAge=1`], { cwd: PROFILE_DIR })

  const eperm = /EPERM|being used by another process|os error 32/i.test(r.all)
  if (r.code !== 0 && !eperm) {
    fail('profile 安装失败（cwd=' + PROFILE_DIR + '）\n' + (r.all || '(无输出)').slice(-900))
  }
  if (eperm) {
    /* 典型场景：DSH 正开着，pnpm 想换出某插件目录时被文件锁挡住，
       会把那个插件目录删空（见 dsh-plugin-authoring 技能 5.1）。自动修复。 */
    const victim = (r.all.match(/node_modules[\\/]([^\\/\s]+)/) || [])[1]
    log(`  ⚠️ pnpm 被运行中的 DSH 文件锁挡住${victim ? `（${victim}）` : ''}`)
    if (victim) {
      const dir = path.join(PROFILE_DIR, 'node_modules', victim)
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
      if (fs.existsSync(dir) && files === 0) {
        fs.rmSync(dir, { recursive: true, force: true })
        log(`  ✓ 已清理被删空的目录 ${victim}（重启 DSH 后会由 pnpm 重装，或关掉 DSH 后重跑本脚本）`)
      }
    }
    log('  ⚠️ 请【先退出 DSH】再重跑本脚本，才能把新版本真正装进 profile')
  }
  const installed = path.join(PROFILE_DIR, 'node_modules', ...pkg.name.split('/'), 'package.json')
  if (fs.existsSync(installed)) log(`  ✓ 已装: v${readJson(installed).version}`)
  else log('  ⚠️ 未在 node_modules 找到（可能被运行中的 DSH 文件锁挡住，退出 DSH 后重跑）')
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(60))
console.log(`  ${pkg.name} v${VERSION} 发布流程完成${DRY ? '（dry-run）' : ''}`)
console.log('─'.repeat(60))
if (slug) console.log(`  GitHub : https://github.com/${slug}/releases/tag/${tagName}`)
console.log(`  npm    : https://www.npmjs.com/package/${pkg.name}`)
if (!INSTALL) console.log(`  装进 profile: node release.mjs --profile  （或手动 pnpm install）`)
console.log('  提示: 运行中的 DSH 需重启才能加载新版本')
