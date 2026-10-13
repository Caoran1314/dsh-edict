# DSH 插件发布检查清单

> 这份清单来自真实事故：一个插件因为 `exports` 少写一行，**把整个 DSH 启动搞挂、并触发自愈清空了用户 profile 里所有插件层**。
> 每条"为什么"都对应一次真实踩坑，不是理论推演。

适用：任何以 `dsh.bundle` + 可选 `dsh.client` 形式分发的 DSH 插件。

---

## 阶段 0 · 发布前自检（本机，无需任何凭据）

- [ ] **语法**：`node --check` 过一遍所有入口（`lib/index.js`、`lib/client.js`、各 `.mjs`）
- [ ] **单元测试**：`npm test` 全绿
- [ ] **冒烟测试**：用 mock ctx 加载插件宿主半侧，确认工具/命令**真的注册上了**
- [ ] **★ 清单一致性校验（最高优先级，见下方"事故 1"）**
  - [ ] 若声明了 `dsh.bundle.patch` → 该文件必须存在，且内容是**顶层 YAML 数组**
  - [ ] 若声明了 `dsh.client` → **`exports` 里必须有 `"./client"`**，且目标文件存在
  - [ ] client bundle 的 `ModuleLoader` 注册 id **必须等于包名**
  - [ ] patch 里 `insert` 的每个 `name` 都能被解析（自己包名 + `@deepseek-ai/*` 宿主内置）
  - 👉 这四条建议直接写成**回归测试**，让 CI 拦住你
- [ ] **打包预览**：`npm pack --dry-run`，确认
  - [ ] 该进的都进了（`lib` / `cordis.patch.yml` / `README` / `LICENSE`）
  - [ ] 不该进的没进（`test/`、`.git/`、`node_modules/`、本地数据、`.npmrc`、`*.tgz`）
  - [ ] 记下 `fileCount` 与 `package size`，作为后续对比基线
- [ ] **Windows 特有**（若在 Windows 开发）
  - [ ] 写文件用 **UTF-8 无 BOM**（PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM！）
  - [ ] 换行策略明确（建议 `.gitattributes` 统一 `eol=lf`）
  - [ ] 包名/路径**不含**保留设备名（`NUL`/`CON`/`AUX`…），否则 git 操作会莫名失败

## 阶段 1 · 本地实机验证（发布前必做）

- [ ] 用 `link:` 装进真实 profile 并**重启 DSH**，确认能正常启动
  ```bash
  dsh plugin --profile desktop add link:/abs/path/to/your-plugin
  ```
- [ ] 界面/工具真的出现（设置面板、右下角挂件、`<your_tool>` 调用）
- [ ] 数据目录被创建（说明宿主半侧 `apply()` 跑到了）
- [ ] **重启两次**（第一次可能是缓存，第二次才暴露真问题）
- [ ] 验证完卸载开发链接，避免和正式版冲突

## 阶段 2 · 版本与三处对齐

- [ ] `package.json` 的 `version` 已更新
- [ ] **三处版本必须一致**：
  - [ ] `package.json` 的 version
  - [ ] git tag（如 `v0.1.2`）
  - [ ] npm 上发布的版本
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 已填（npm 页面才会显示仓库链接）
- [ ] `CHANGELOG.md` 已更新，**并明确标注已知问题版本**

## 阶段 3 · 发布 npm

- [ ] 凭据就绪（见"事故 4"：`npm login --auth-type=web` 的 token 可能发不了包）
- [ ] `npm publish --access public`
- [ ] **确认不是 staged publish**（新包首次发布可能被转成暂存，只留个 `0.0.0-stage` 占位壳）
- [ ] **`latest` 标签指向真版本**——不指向就手动改：
  ```bash
  curl -X PUT "https://registry.npmjs.org/-/package/<pkg>/dist-tags/latest" \
    -H "Authorization: Bearer <npm_token>" -H "Content-Type: application/json" -d '"0.1.2"'
  # 成功返回 204
  ```
- [ ] **★ 用线上 tarball 实测**（不要相信自己源码树）
  ```bash
  curl -sL "$(npm view <pkg> dist.tarball)" -o /tmp/p.tgz
  tar -xzf /tmp/p.tgz -C /tmp && ls /tmp/package/lib
  # 核对关键字段真的在包里：dsh.bundle.patch / dsh.client / exports["./client"]
  ```
- [ ] 干净环境真装一次：`dsh plugin --profile desktop add <pkg>`

## 阶段 4 · 发布 GitHub

- [ ] `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`
- [ ] 建 Release，notes 里写清**破坏性变更与已知问题版本**
- [ ] 打主题（否则插件市场搜不到）：
  ```bash
  gh repo edit --add-topic dsh-plugin --add-topic deepseek-harness
  ```
- [ ] 确认仓库是 **public**（私有仓库无法被市场索引）

## 阶段 5 · 发布后

- [ ] 社区宣发（DSH Discussions 的 Show Your Plugins! 等）
- [ ] 若有上游/参考实现 → 发致谢并注明许可与出处
- [ ] **撤销所有临时凭据**（token 用完即删）
- [ ] 记下本次发布的 `fileCount` / `shasum`，便于日后核对是否被篡改

---

## 事故与对照（这份清单的存在理由）

### 事故 1：`exports` 少一行 → 整个 app 起不来

```
dsh-edict declares dsh.client but exports no "./client" bundle
→ DesktopHostFatalError → DSH 自愈 → profile 里所有插件层被清空
```

**症状**：用户重启后"插件全没了"，看起来像插件被禁用，其实是启动失败后的自愈。
**教训**：`dsh.client` 与 `exports["./client"]` 是**成对契约**，必须写进自动测试。

### 事故 2：插件加载失败会触发"自愈清空"

DSH 启动时若有必需插件无法激活，它会把 profile 的 `bundles` 打回只剩内置，**但保留 `dependencies`**。
**症状**：依赖都在、插件层空了 → 用户以为插件被删。
**应对**：
- [ ] 崩溃日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`，**先读它，别猜**
- [ ] 恢复方式：把 `bundles` 补回即可（依赖没丢），或用 `dsh plugin add` 重装
- [ ] **不要**因为"插件没了"就删 profile 目录

### 事故 3：profile 被写入 BOM → CLI 全线报错

```
SyntaxError: Unexpected token '﻿', "﻿{...
```

原因：用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 改了 profile 的 `package.json`。
**教训**：改 JSON 用 Node（`JSON.stringify` + `utf8` 写出），或显式用 `UTF8Encoding($false)`。

### 事故 4：npm 的发布策略坑（2026 版）

| 现象 | 原因 | 解法 |
|---|---|---|
| `E403 two-factor ... required` | `--auth-type=web` 的 token 无 2FA bypass，且**不提示输 OTP** | 用带 **Bypass 2FA** 的 Granular Token |
| 线上出现 `0.0.0-stage` 占位壳 | 新包首次发布被转成 **staged publish** | 换版本号直发，再手动重打 `latest` |
| `E403 ... may not perform this action` | bypass-2FA token **被禁止删版本/删包** | 只能去 npm 网页删 |
| `E409 Cannot publish over previously staged version` | 版本号被暂存记录占住 | **换版本号** |

### 事故 5：坏版本发出去怎么办

- [ ] 72 小时内：npm 网页 → Settings → **Delete package**（网页端不受 token 限制）
- [ ] 超过 72 小时：**只能发新版本**，并在 CHANGELOG 里明确标注坏版本"请勿使用"
- [ ] 版本号**绝不复用**（同号内容不同 = 供应链灾难）

---

## 最小可用脚本（可直接落进仓库）

```bash
# package.json
"scripts": {
  "check": "node --check lib/index.js && node --check lib/client.js",
  "test":  "node test/unit.mjs && node test/smoke.mjs",
  "prepublishOnly": "npm run check && npm test && npm pack --dry-run"
}
```

`test/smoke.mjs` 里至少要有这一段（事故 1 的回归守卫）：

```js
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (pkg.dsh?.client) {
  const clientExport = pkg.exports?.['./client']
  if (!clientExport) throw new Error('dsh.client 已声明但 exports 缺少 "./client"')
  if (!fs.existsSync(path.resolve(pkgDir, clientExport))) throw new Error('exports["./client"] 指向的文件不存在')
  const src = fs.readFileSync(path.resolve(pkgDir, clientExport), 'utf8')
  if (!src.includes(`id: '${pkg.name}'`)) throw new Error('client bundle 注册 id 与包名不一致')
}
```
