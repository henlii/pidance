# 发布与候选包

[文档导航](README.md) · [开发验证](development.md) · [产物管理](artifacts.md)

本文是现行发布操作说明，不代表已执行发布。主包为 `@henlii/pidance`，CLI **仅** `pidance`；桌面壳独立构建，见 [Desktop](../desktop/README.md)。

## 1. 发布边界

- 日常开发在 `main`；只有明确发布任务才执行版本提交、push 和 tag。
- 不使用本地“一键 version/tag/push/publish”脚本；版本、提交、tag 逐步显式操作。已配置的 tag CI 是正式发布执行方，会自动 publish，这是与本地脚本限制不同的边界。
- 正式构建只在隔离发布根进行，不在工作区运行 `next build`，不影响 31415/31416，也不操作上游服务。
- 必须前后 allowlist/内容审计；npm 与 GitHub Release 使用同一已验收 tgz 及 SHA-256。
- 不移动或删除已发布 tag 来重试，不复用已发布版本号覆盖内容。发生版本冲突先核对远端状态。

## 2. 版本准备与质量门禁

1. 确认工作区改动归属，目标版本在 npm/tag 中未占用。
2. 同步主包 `package.json`、`package-lock.json` 的版本，以及中英 README 版本行。
3. 新增 `docs/release-notes/v<version>.md`，中文在上、英文在下，写明包名、CLI、变更与验收范围；补齐 [发布记录索引](release-notes/README.md)。
4. 执行发布前门禁：`npm run typecheck` + `npm test` + 主浏览器套件 + 31416 部署冒烟，
   通过后显式创建 `chore(release)` 提交。（`npm run check` 还含 lint 段；本仓当前有 14 个既有的
   React Compiler memo error 会让它在 lint 处停下，门禁现状与处理口径见
   [.agents/skills/pidance-development/references/release.md](.agents/skills/pidance-development/references/release.md)。）
5. 桌面壳与主包**同版本**：改 `desktop/package.json` 的 `version` 与 `@henlii/pidance` 依赖，
   以及 `desktop/package-lock.json` 的顶层 `version`、`packages.""` 的 `version` 与依赖声明。
   **lockfile 里 `node_modules/@henlii/pidance` 条目：`version` 跟到新版本，`resolved`/`integrity`
   仍指向上一版正式 tgz** —— 目标版本此刻还没发布，指向它会让桌面 workflow 的 `npm ci` 直接 404；
   而条目版本停在旧版则会在 lockfileVersion 3 下 ETARGET。发行完成、npm 传播结束后，再补一次
   `chore(desktop): lockfile 指向 <version> 的正式 tgz` 提交把条目对齐。桌面壳必须与主包一起提交。

当前 release workflow 不运行 `npm run check`，因此不能跳过发布前本地质量门禁。

## 3. 显式 push 与 annotated tag

以下 `<version>` / `<run-id>` 是占位符，执行时替换为本次确认值，不照抄占位符或自动猜测版本。

```bash
git status --short
git push origin main
git ls-remote --tags origin refs/tags/v<version>
git tag -a v<version> -m "v<version>"
git rev-parse HEAD
git rev-parse v<version>^{}
git push origin v<version>
```

创建前确认远端无同名 tag；推送前核对 annotated tag 解引用与预期 HEAD 一致，且 `package.json` 版本与 tag 一致。不同则停止，不通过强制重打 tag 掩盖错误。

```bash
gh run list --workflow release.yml --repo henlii/pidance --limit 5
gh run watch <run-id> --repo henlii/pidance
```

## 4. CI 的实际流程

事实来源：[`.github/workflows/release.yml`](../.github/workflows/release.yml)。`push v*` 触发：

1. checkout tag，复制到中性根 `/tmp/pidance-release-build`。
2. Node 24，`npm ci --include=dev`。
3. webpack 生产构建。
4. 生成前审计 `npm run release:audit`。
5. `npm pack --ignore-scripts`，文件名来自 package 版本。
6. 对真实 tgz 执行生成后审计，再生成 SHA-256。
7. 使用 npm Trusted Publishing / OIDC 发布到官方源并附 provenance；需要发布方配置对应 trusted publisher，不使用长期 token。
8. 优先采用 `docs/release-notes/<tag>.md`，缺失时回退 commit 列表。
9. 发布后核验：registry 的 tgz 与 Release 资产逐字节一致（`sha256sum` 相同、`dist.integrity` 吻合），
   `dist-tags.latest` 已切到新版本；Windows 安装包与 `sha256.txt` 一致。新版本 tarball 发布后约
   2–4 分钟才可下载，下游 job 在此期间失败应等传播完成再重跑，不要改 lockfile 或动 tag。
10. `gh release create` 上传同一 tgz 和 sha256。

同一个 `v*` tag 还会触发 [`.github/workflows/desktop-win.yml`](../.github/workflows/desktop-win.yml)（Windows 桌面壳）：只出 NSIS 安装版（不做便携 zip）→ 瘦身 → 打包 → 在 electron-builder 留下的 `dist/*-unpacked` 应用目录上验证（页面 + `_next` 静态资源 + `/api/about` 版本 + node-pty + SDK 会话 + 可停）→ 真实 Electron 壳冒烟 → 静默安装/卸载验证 → 等 Release 建好后用 `gh release upload` 把 Setup exe 与 sha256 挂到**同一个 Release**。桌面壳与主包同版本，但不会自动更新已安装的桌面版：用户在托盘里手动「检查更新」。

### 当前 CI 限制

- 未包含完整 check 或安装后运行冒烟；这些验证需要在发布准备阶段补齐，不能声称 CI 自动完成。
- npm 精确版本已存在时跳过 publish，GitHub Release 已存在时跳过创建。
- 因此重跑构建所得 tgz **不能仅凭版本号相同就认定与 npm 已发布字节一致**。部分成功后应核对已有制品及哈希，不盲目重新打包上传。
- tag 与 package 版本一致性需在推 tag 前人工/显式核对，当前 workflow 不提供完整的该项门禁。
- 桌面制品**未做代码签名**（无证书）：用户首次安装会有 SmartScreen 提示；自更新按 Release 声明的 sha256 校验后才执行，校验不过不运行安装包。

以上为现状限制，本轮仅整理文档，没有修改 workflow。

## 5. 本地候选包（不发布）

```bash
npm run package:candidate
# 或指定专用构建根
npm run package:candidate -- --build-root /tmp/pidance-candidate-example
```

候选脚本可包含未提交改动，负责工作区镜像、隔离 webpack 构建、前后审计、pack 与 sha256，不修改版本、不提交、不推送、不发布。它不替代 `npm run check`。

默认产物为 `/tmp/pidance-release-build/henlii-pidance-<version>.tgz` 及 `.sha256`。不能将相同版本号的本地候选误称为 npm 已发布制品。

### 手工隔离预检

需要调查打包问题时，在专用中性 checkout 中执行（不要在主工作区运行）：

```bash
npm ci --include=dev
npm run check
# 先清除维护环境的 PIDANCE_DIST_DIR / TURBOPACK；下面是 POSIX 示例
env -u PIDANCE_DIST_DIR -u TURBOPACK npm run build
npm run release:audit
npm pack --ignore-scripts
npm run release:audit:tgz -- henlii-pidance-<version>.tgz
sha256sum henlii-pidance-<version>.tgz
```

审计使用 `PIDANCE_RELEASE_SOURCE_ROOT` 标明原始源码目录；它应与隔离构建根不同。不要在文档中写入维护机器的实际绝对路径。

## 6. 审计与冒烟

- pre-pack 审计通过 dry-run 清单及完整有界扫描检查必要 `.next` 产物、CLI allowlist、禁入源码/测试/密钥/本机路径等内容。
- post-pack 直接解析真实 tgz 字节，检查 tar 路径、条目类型、大小预算、包身份与相同敏感内容规则；不能回读工作区来替代包内容。
- 审计失败立即停止，不继续 publish。
- 将已审计的同一 tgz 安装到专用临时目录，使用 production 依赖验证 CLI/HTTP；使用隔离 `PI_CODING_AGENT_DIR` 和空闲端口（例如先确认未占用的 31999），**不用 31415/31416 做安装冒烟**。
- 仅停止本次冒烟创建的进程并清理本次临时数据，不触碰真实会话。

## 7. 失败与最终核对

- **质量/审计失败**：修复原因后重新准备；未发布不得写“发布成功”。
- **tag/版本冲突**：确认 npm、tag、Release 的实际状态，不自动删除 tag。
- **npm 成功、Release 失败**：优先找回本次已发布的原 tgz 和哈希；核实一致后补 Release，不把重建包当作原包。
- **OIDC 失败**：核对仓库/workflow/trusted publisher 配置；本地登录发布仅是另行授权的故障处理路径，不是默认步骤。

```bash
npm view @henlii/pidance@<version> version dist.integrity dist.tarball --registry https://registry.npmjs.org/
gh release view v<version> --repo henlii/pidance
```

最终核对精确版本、tag 指向、Release 附件及其 SHA-256，并验证 npm 下载内容与 Release tgz 一致。只有全部确认后才能报告发布完成。

## 命令速查

| 命令 | 作用 | 发布副作用 |
|---|---|---|
| `npm run check` | typecheck + lint + 单测 | 无 |
| `npm run package:candidate` | 候选构建、前后审计、pack、sha256 | 无 |
| `npm run release:check` | check + build + pre-pack 审计，仅隔离 checkout | 无，不含 post-pack |
| `npm run release:audit` | pre-pack 审计 | 无 |
| `npm run release:audit:tgz -- <tgz>` | post-pack 审计 | 无 |
| push `v*` tag | 触发正式 release workflow | **有：npm 与 GitHub Release** |
