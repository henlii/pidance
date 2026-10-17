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
5. 桌面壳与主包**同版本发布**，2026-10-17 恢复（2026-10-09 起曾按用户决定冻结停更）。
   停更与桌面构建的版本校验本质冲突：冻结期间 `desktop/` 停在 0.2.54，而 `v*` tag 构建会用工作区
   源码打候选包替换内置服务，于是 v0.2.55、v0.2.56、v0.2.57 三次桌面构建都因「内置服务版本与
   `desktop/package.json` 声明不一致」变红。发主包时按第 6 条同步 `desktop/` 的两个版本文件。
   解冻后的 0.2.57 安装包只落在 Actions Artifacts（构建 run 39040747600，保留 30 天），没挂
   Release：已推送的 tag 不能动，三个旧 Release 补不了桌面包，下次 `v*` 起恢复自动挂同一个 Release。
6. 桌面壳与主包**同版本**：改 `desktop/package.json` 的 `version` 与 `@henlii/pidance` 依赖，
   以及 `desktop/package-lock.json` 的顶层 `version`、`packages.""` 的 `version` 与依赖声明。
   **lockfile 里 `node_modules/@henlii/pidance` 条目：`version` 跟到新版本，`resolved`/`integrity`
   仍指向上一版正式 tgz** —— 目标版本此刻还没发布，指向它会让桌面 workflow 的 `npm ci` 直接 404；
   而条目版本停在旧版则会在 lockfileVersion 3 下 ETARGET。发行完成、npm 传播结束后，再补一次
   `chore(desktop): lockfile 指向 <version> 的正式 tgz` 提交把条目对齐。桌面壳必须与主包一起提交。
   改完后跑 `npm run release:desktop-check` 校验：它按「目标版本是否已在 npm 上」自动判断阶段，
   不一致会带修复指引非零退出（离线用 `--stage=pre|post`）。v0.2.35 与 v0.2.37 两次桌面构建变红
   就是这套口径被漏改/写错，别再靠人肉核对这几个字段。

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

# Pidance 正式发布（agent 操作卡）

与 `docs/release.md`、全局 skill **nm-deploy** 的 `references/npm-publish-guide.md` 对齐；本文件只写 **本仓最短可执行路径与红线**。

## 何时用

- 用户要求「打新包 / 发版 / publish / GitHub Release」
- 改完版本号后要上 npm

## 触发

用户说「**发新包** / **发布**」即视为授权：按本文件逐步执行到底（版本 → 提交 → push → tag →
盯 CI），**不要逐步询问**。仅在失败或需要用户决策时回头问。

## 版本与桌面壳（v0.2.34 / v0.2.35 / v0.2.36 三次实测后的口径）

**版本号落在 8 个文件**（缺一个就会不一致，桌面 workflow 的输入校验会直接失败）：

| 文件 | 改什么 |
|------|--------|
| `package.json` | `version` |
| `package-lock.json` | 根 `version` 两处（顶层 + `packages.""`） |
| `desktop/package.json` | `version` + `dependencies["@henlii/pidance"]` pin |
| `desktop/package-lock.json` | 顶层 `version`、`packages.""` 的 `version` 与 `dependencies` 声明 |
| `desktop/package-lock.json` 的 `node_modules/@henlii/pidance` 条目 | **`version` 跟到新版本**；`resolved`/`integrity` **先留上一版正式 tgz** |

改完上面这些字段，**先跑校验再提交**（口径错了它会直接拦下并给修复指引，不给 CI 变红的机会）：

```bash
npm run release:desktop-check                    # 发行前：条目 version 跟新、resolved 留上一版 tgz
npm run release:desktop-check -- --stage=post    # 发行后对齐条目时用（离线也可用 --stage=pre）
```

脚本按「目标版本在 npm 上是否已发布」自动判断阶段；它拦的就是 v0.2.35 与 v0.2.37 两次桌面构建
变红的形态（条目停在旧版 → ETARGET；resolved 指向未发布版本 → 404；三处 version 不同步 → 输入校验失败）。
**不要再靠人肉数这 8 个字段**。
| `README.md` / `README.en.md` | 版本行 |

**为什么 `resolved` 不能一起改**：lockfileVersion 3 要求 lock 条目满足根声明 ——

- 条目 `version` 停在旧版 → `npm ci` **ETARGET**（v0.2.35 的 tag 绑定桌面构建就是这样永久变红的，
  而已推送的 tag 不能移动）；
- 条目 `version` 跟新版、`resolved` 指向未发布的 tarball → **404**。

正确口径 = **条目版本跟、tarball 先指上一版**（v0.2.34 与 v0.2.36 都因此一次通过，tag 绑定的
桌面构建自己就把 Setup 挂到了同一个 Release）。

**发布完成后补一次对齐提交**（v0.2.34 的 `ee9910c`、v0.2.35 的 `148a834`、v0.2.36 的 `c529e1f`）：

```bash
# 1. 等 npm 传播完（tarball 200 之后才拿得到 integrity）
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/@henlii/pidance/-/pidance-<ver>.tgz
# 2. 把 desktop/package-lock.json 条目 resolved/integrity 指向新 tgz
#    integrity 用本地 tgz 的 sha512（与 registry dist.integrity 一致）
git commit -m "chore(desktop): lockfile 指向 <ver> 的正式 tgz"
```

## 发布后核验（必做）

```bash
# npm 与 Release 必须同一份 tgz
gh release download v<ver> --repo henlii/pidance --pattern "henlii-pidance-<ver>.tgz"
curl -sO https://registry.npmjs.org/@henlii/pidance/-/pidance-<ver>.tgz
sha256sum henlii-pidance-<ver>.tgz pidance-<ver>.tgz     # 必须相同
# registry 的 dist.integrity(sha512) 与本地 sha512 一致；dist-tags.latest 已切到 <ver>
gh release view v<ver> --repo henlii/pidance --json assets   # tgz + sha256 + Setup.exe + sha256.txt
```

Windows 安装包：`desktop-win.yml` 的挂载步骤带 `if: startsWith(github.ref, 'refs/tags/v')` 守卫 ——
**tag 绑定运行**会把 Setup 自动挂到同一个 Release（v0.2.36 即如此）。若它失败（如 v0.2.35 的 ETARGET），
main 推送的运行只出 artifact 不挂载，需要手工 `gh release upload v<ver> --clobber` 并核对 `sha256.txt`。

**传播延迟**：新版本 tarball 在发布后约 2–4 分钟才可下载、`dist-tags` 滞后约 2 分钟。
下游 job 在这段时间失败（ETARGET/404）→ **等 tarball 200 后重跑**；不要改 lockfile、不要动 tag。

## 红线

1. **禁止**在开发工作区执行正式 `next build`（污染 `.next`，干扰 `npm run dev` / 31416）。
2. **禁止**脚本自动 version / tag / push / publish：逐步显式执行命令，不写「一键发布」脚本。
3. **禁止**操作上游服务与未验收的 **31415** 切换。
4. npm 与 GitHub Release **必须同一已审计 tgz + SHA256**。
5. CLI **仅** `pidance`，包内不得出现 `pi-web`。

## 推荐路径：CI 可信发布

```bash
# 1. 版本（示例 0.2.0）
# 改 package.json version；同步 README 版本行；提交 chore(release)

# 2. 门禁（见下节「本工作区门禁现状」）
npm run typecheck && npm test

# 3. 推 main
git push origin main

# 4. annotated tag —— 必须指向目标 HEAD
git ls-remote --tags origin refs/tags/v0.2.0   # 必须先确认远端无同名 tag（有则停下来问）
git rev-parse HEAD
git tag -d v0.2.0 2>/dev/null || true          # 只允许删**本地**错指的 tag
git tag -a v0.2.0 -m "v0.2.0"
test "$(git rev-parse v0.2.0^{})" = "$(git rev-parse HEAD)"
git push origin v0.2.0

# 5. 盯 CI
gh run list --repo henlii/pidance --limit 3
gh run watch <run-id>
```

CI（`.github/workflows/release.yml`）自动：中性根 `/tmp/pidance-release-build` → webpack build → 前后审计 → pack → npm OIDC publish → `gh release create`。

## 本工作区门禁现状（2026-09-22）

`npm run check` = typecheck + lint + test，但**当前会在 lint 段停住**：eslint 报 14 个 error，
全是既有的 `react-hooks/preserve-manual-memoization`（React Compiler 跳过提示），分布在
AppShell/ChatInput/ChatMinimap/FileViewer/MessageNavRail/PluginsConfig/useAgentSession/ChangesPanel
等**与本次发行无关**的文件里；另有约 157 个 warning。

- 所以本仓当下的实际门禁 = **`npm run typecheck` + `npm test` + 主浏览器套件 + 31416 部署冒烟**，
  并在 `chore(release)` 提交信息里如实写明「lint 未通过的原因与范围」。
- 不要为了让 check 变绿去改既有 lint 问题（那是另一件事），也不要把它写成通过。
- `npm config get omit` 为 `dev` 时，`npm install` 会剪掉 devDependencies →
  `tsc`/`eslint` 直接消失、命令报 `not found`，而输出容易被管道吞掉看起来像通过。
  先 `node_modules/.bin/tsc --version` 确认工具真的在；需要时 `npm install --no-save --no-package-lock --include=dev typescript@5.9.3 eslint@9`。

## 本地预检（**发布前必做**：`npm run check` 覆盖不到 Next 生成的路由类型）

> v0.2.38 就是这么失败的：`route.ts` 里 `export function createXHandler(...)` 在本地 `tsc --noEmit` 下是绿的，
> 而 `next build` 生成的 `.next/types/app/**/route.ts` 只允许导出 HTTP 方法，于是在 CI 的构建步炸掉。
> 所以**打 tag 之前先跑一次下面的构建段**（隔离根，不用工作区 `.next`）。

```bash
rm -rf /tmp/pidance-release-build
mkdir -p /tmp/pidance-release-build
git archive HEAD | tar -x -C /tmp/pidance-release-build
cd /tmp/pidance-release-build

npm ci --no-audit --no-fund --include=dev

# 关键：清掉 31416 开发环境变量
env -u TURBOPACK -u PIDANCE_DIST_DIR \
  node_modules/.bin/next build --webpack

export PIDANCE_RELEASE_SOURCE_ROOT=/root/works/open/pidance   # 原始仓路径，≠ 构建根
npm run release:audit
npm pack --ignore-scripts
npm run release:audit:tgz -- henlii-pidance-$(node -p "require('./package.json').version").tgz
sha256sum henlii-pidance-*.tgz | tee henlii-pidance-$(node -p "require('./package.json').version").tgz.sha256
```

冒烟：独立目录 `npm install <tgz> --omit=dev`，`npx pidance --no-open -p 31999`（**不用** 31415/31416）。

## 本地候选包（推荐：一条命令）

含未提交改动的工作区直接打本地 tgz（不做 version/tag/push/publish）：

```bash
npm run package:candidate                     # 默认 /tmp/pidance-release-build
npm run package:candidate -- --build-root /tmp/xxx
```

脚本自动完成：镜像工作区（保留构建根 node_modules / .next 实现增量）→
lock 未变跳过 npm ci → 隔离 webpack 构建 → 生成前/后审计 → pack → sha256。
产物：`<构建根>/henlii-pidance-<version>.tgz(.sha256)`。打完只留这份 tgz+sha256（及可选 `node_modules`）；构建根里的 `.next` 与旧版 tgz 删掉。规则见 `docs/artifacts.md`。

## 与 31416 持续测试的边界

| | 31416 持续测试 | 正式发布 |
|--|----------------|----------|
| 构建 | Turbopack → `.next-public` | webpack → `.next` |
| 入口 | `local-deploy.mjs restart` | 中性目录 + `release:check` / CI |
| 环境 | 可有 `PIDANCE_DIST_DIR=.next-public` | **必须** unset `PIDANCE_DIST_DIR` / `TURBOPACK` |
| 端口 | 31416 | 制品默认 31415；冒烟用空闲口 |

开发改完代码仍只重启 31416；**不要**为发版在工作区跑 `next build`。

## 常见失败速查

| 失败 | 处理 |
|------|------|
| `tsc: not found` | `npm ci --include=dev` |
| pack 缺 `.next/BUILD_ID` | 构建时未 unset `PIDANCE_DIST_DIR` |
| 审计「仓库绝对路径」 | 未用中性根，或 `SOURCE_ROOT` 与构建根相同 |
| Route export 非法字段 | 非 handler 常量移出 `app/api/**/route.ts` |
| tag 触发了错误 commit | 删远端 tag 重打到正确 HEAD（见上） |
| lint 14 errors | 既有 React Compiler memo 告警（非本次改动）；按上面「门禁现状」处理并如实记录 |
| 桌面 `npm ci` ETARGET / 404 | lock 条目 `version` 与 `resolved` 口径写错，见「版本与桌面壳」 |
| 发布后下游 404/ETARGET | registry 传播延迟，等 tarball 200 再重跑 |

## 交叉引用

- 仓库：`docs/release.md`
- 全局实操与验收：`~/.agents/skills/nm-deploy/references/npm-publish-guide.md`
- 本地温构建加速：`nm-deploy/references/local-test-build-speed.md`
