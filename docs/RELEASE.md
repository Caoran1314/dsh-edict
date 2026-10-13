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

```bash
npm login          # 首次
npm publish        # 若包名被占用，改成 @<你的scope>/dsh-edict 并同步改 cordis.patch.yml 与 README
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
