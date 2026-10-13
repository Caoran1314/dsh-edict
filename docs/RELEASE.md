# 发布检查清单

面向维护者。按顺序走完即可发布到 npm 与 GitHub。

## 0. 发布前自检

```bash
cd dsh-edict

# 语法与测试
node --check lib/index.js && node --check lib/client.js && node --check lib/core.mjs && node --check lib/commands.mjs
node test/edict.test.mjs      # 应输出 28/28 通过
node test/smoke.mjs           # 应输出 冒烟测试全部通过

# 包内容预览（确认没有多余文件被打进去）
npm pack --dry-run
```

`npm pack --dry-run` 应当只列出：

```
lib/index.js  lib/client.js  lib/core.mjs  lib/commands.mjs
cordis.patch.yml  README.md  LICENSE  package.json
docs/...（可选）
```

**不该出现**：`test/`、`.git/`、`node_modules/`、本地数据文件。

## 1. 版本号

发布前改 `package.json` 的 `version`，并保持与 `lib/index.js` 里读到的版本一致（后者是运行时读 package.json，无需重复维护）。

```bash
npm version patch   # 或 minor / major
```

## 2. 本地实机验证（重要）

```bash
dsh plugin --profile desktop add link:$PWD
# 重启 DSH，然后：
#   1) 让助手调 edict_status 看板应有数据
#   2) 设置页应出现「三省六部」面板
#   3) 打开 http://127.0.0.1:<端口>/edict 看独立看板
```

验证完卸载开发链接：

```bash
dsh plugin --profile desktop remove dsh-edict
```

## 3. 发布 npm

> ### ⚠️ 首次发布踩过的坑（务必先读）
>
> npm 从 2026 年起收紧发布策略，**"绕过 2FA 的 granular token"被限制**（[官方说明](https://gh.io/npm-gat-bypass2fa-deprecation)）。实测行为：
>
> | 现象 | 原因 | 解法 |
> |---|---|---|
> | `npm publish` 报 `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required` | 用 `npm login --auth-type=web` 得到的 token 没有 2FA bypass，且**不会提示输 OTP** | 用带 **Bypass 2FA** 的 Granular Access Token |
> | 发布后线上出现 `0.0.0-stage` 占位版本，`latest` 指向它 | 新包首次发布被 npm 转成 **staged publish**（延后 2FA 证明），真实版本被扣住 | 见下：重打 `latest` 标签 + 直发新版本号 |
> | `npm unpublish` 报 `403 ... may not perform this action` | bypass-2FA token **被禁止删除版本/包** | 只能去 npm 网页版删（72 小时内） |
> | `E409 Cannot publish over previously staged version "x.y.z"` | 该版本号已被暂存记录占住 | **换一个版本号**重发 |
> | `https://www.npmjs.com/settings/<user>/staged-packages` 是空的，但确实卡住了 | 暂存记录未挂到用户可见队列 | 不用管，换版本号直发即可 |
>
> **一次成功的路径**（本次实际走通）：
> 1. 建 **Granular Access Token**：勾 **Bypass 2FA**，Permissions = `Read and write (publish and stage)`，Expiration = 7 days
> 2. 若包名已有占位版本（如 `0.0.0-stage`），**把 package.json 版本换一个号**（例：`0.1.0` → `0.1.1`）再 `npm publish --access public`
> 3. 把 `latest` 指向真版本（命令行 `npm dist-tag` 需要 OTP，改用 API）：
>    ```bash
>    curl -X PUT "https://registry.npmjs.org/-/package/<包名>/dist-tags/latest" \
>      -H "Authorization: Bearer <npm_token>" -H "Content-Type: application/json" \
>      -d '"0.1.0"'      # 成功返回 204
>    ```
> 4. 验证：`npm view <包名> dist-tags` 应显示 `latest: <真版本>`，且 `npm view <包名>@<版本> dsh` 有 `bundle.patch`
> 5. 用完**立刻删掉 token**（npm 网页 → Access Tokens → Delete）
>
> **占位版本 `0.0.0-stage` 建议去网页删掉**：https://www.npmjs.com/package/<包名> → Settings → Delete package

```bash
npm login            # 或用上面那种 token
npm publish --access public
```

发布后核对：

```bash
npm view dsh-edict dist-tags            # latest 必须指向真版本
npm view dsh-edict@<版本> dsh           # 应输出 { bundle: { patch: './cordis.patch.yml' }, client: {...} }
npm view dsh-edict@<版本> dist.fileCount  # 应为 11
```

**最长验一步（推荐）**：下载线上 tarball 并跑一遍核心逻辑，确认发出去的不是空壳：

```bash
curl -sL "$(npm view dsh-edict dist.tarball)" -o /tmp/p.tgz
tar -xzf /tmp/p.tgz -C /tmp && ls /tmp/package/lib
node -e "import('/tmp/package/lib/core.mjs').then(m=>console.log(Object.keys(m.STATE_TRANSITIONS).length, m.HIGH_RISK_TRANSITIONS.length))"
# 期望输出：12 3
```

## 4. 发布 GitHub

```bash
git init
git add -A
git commit -m "feat: 三省六部审核流程 DSH 插件（移植自 edict）"
git branch -M main
git remote add origin git@github.com:<你的用户名>/dsh-edict.git
git push -u origin main
```

**让插件市场能搜到**：给仓库加上 `dsh-plugin` 与 `deepseek-harness` 主题（Topics），社区市场（如 dsh-whale-market）按主题收录：

```bash
gh repo edit --add-topic dsh-plugin --add-topic deepseek-harness --add-topic multi-agent --add-topic workflow
```

## 5. 打 tag 与 Release

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes "首个版本：状态机 / 封驳 / 高风险确认 / 越权矩阵 / 委派防死锁 / 看板"
```

## 6. 发布后

- [ ] 在 [deepseek-ai/deepseek-harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 发一条介绍帖（附状态机图与用法）
- [ ] 向 edict 上游致谢（issue 或 Discussions 里说明这是 DSH 侧移植，附链接）
- [ ] 若加了 `dsh-plugin` 主题，等市场索引刷新（各市场周期不同）

## 需要同步维护的地方

| 改了 | 记得同步 |
|---|---|
| 状态机 / 规则 | `lib/core.mjs` + `test/edict.test.mjs` 的 `EXPECTED_TRANSITIONS`（回归守卫会失败提醒你） |
| 工具增删 | `lib/index.js` 的 `buildTools()` + `test/smoke.mjs` 的 `expectedTools` + README 的工具表 |
| 包名 | `cordis.patch.yml` 的 `name` + README 安装命令 |
