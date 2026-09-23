/**
 * 桌面壳 lockfile 一致性校验（纯函数，供 CLI 与单测复用）。
 *
 * 背景：`desktop/package.json` 依赖 `@henlii/pidance@<版本>`，而该版本在发布前**还不存在**，
 * 能不能装完全取决于 `desktop/package-lock.json` 的口径（见 docs/release.md 2.5）：
 *
 * - 目标版本尚未上 npm → 条目 version 跟到新版本，但 `resolved`/`integrity` 必须留在
 *   上一版正式 tgz（指向未发布版本会让桌面 workflow 的 `npm ci` 直接 404）；
 * - 条目 version 停在旧版 → lockfileVersion 3 下 ETARGET（v0.2.35 的 tag 构建就是这样
 *   永久变红的）；
 * - 发行完成、npm 传播结束后 → 再把 `resolved`/`integrity` 对齐到本版正式 tgz。
 *
 * 这套纪律靠人记会漏（v0.2.35、v0.2.37 各漏一次，每次都是 tag 与 main 两条红），
 * 所以把它做成脚本，在发布流程里必跑。
 */

const DEP_NAME = "@henlii/pidance";

/** 从 tgz URL 里取版本号：…/@henlii/pidance/-/pidance-0.2.37.tgz → 0.2.37 */
export function versionFromResolved(resolved) {
  if (typeof resolved !== "string") return null;
  const m = /\/pidance-(\d+\.\d+\.\d+(?:[-+][^/]*)?)\.tgz$/.exec(resolved);
  return m ? m[1] : null;
}

/**
 * @param {object} input
 * @param {string} input.pkgVersion   desktop/package.json 的 version
 * @param {object} input.lock         desktop/package-lock.json 解析后的对象
 * @param {string[]} [input.publishedVersions]  registry 上已存在的版本（离线校验时留空）
 * @param {"pre"|"post"|null} [input.stage]     强制阶段；null 时按「目标版本是否已发布」推断
 * @returns {{ stage: "pre"|"post", ok: boolean, errors: string[], hints: string[] }}
 */
export function checkDesktopLockfile({ pkgVersion, lock, publishedVersions = [], stage = null }) {
  const errors = [];
  const hints = [];
  const published = publishedVersions.includes(pkgVersion);
  const resolvedStage = stage ?? (published ? "post" : "pre");

  if (typeof pkgVersion !== "string" || !pkgVersion) {
    return { stage: resolvedStage, ok: false, errors: ["desktop/package.json 缺少 version"], hints: [] };
  }

  const root = lock?.packages?.[""];
  const entry = lock?.packages?.[`node_modules/${DEP_NAME}`];

  if (!root || !entry) {
    return {
      stage: resolvedStage,
      ok: false,
      errors: ["desktop/package-lock.json 结构异常：缺少 packages[\"\"] 或 node_modules 条目"],
      hints: [],
    };
  }

  // 1) 三处 version 必须与 desktop/package.json 同步
  if (lock.version !== pkgVersion) {
    errors.push(`lockfile 顶层 version=${lock.version}，应为 ${pkgVersion}`);
  }
  if (root.version !== pkgVersion) {
    errors.push(`lockfile packages[""].version=${root.version}，应为 ${pkgVersion}`);
  }
  const declared = root.dependencies?.[DEP_NAME];
  if (declared !== pkgVersion) {
    errors.push(`lockfile packages[""].dependencies["${DEP_NAME}"]=${declared}，应为 ${pkgVersion}`);
  }
  if (entry.version !== pkgVersion) {
    // 这条正是 v0.2.35 的成因：条目停旧版会在 lockfileVersion 3 下 ETARGET
    errors.push(`lockfile 依赖条目 version=${entry.version}，应为 ${pkgVersion}（停旧版会 ETARGET）`);
  }

  // 2) resolved 指向哪个 tgz，取决于目标版本此刻有没有发布
  const resolvedVersion = versionFromResolved(entry.resolved);
  if (resolvedVersion === null) {
    errors.push(`依赖条目 resolved 不是 pidance 的 tgz：${entry.resolved}`);
  } else if (resolvedStage === "pre") {
    if (resolvedVersion === pkgVersion) {
      errors.push(
        `目标版本 ${pkgVersion} 还没上 npm，resolved 却已指向它（${entry.resolved}）——`
        + "桌面 workflow 的 npm ci 会 404",
      );
      hints.push("把 resolved/integrity 改回上一版正式 tgz（docs/release.md 2.5）");
    }
  } else if (resolvedVersion !== pkgVersion) {
    errors.push(
      `目标版本 ${pkgVersion} 已发布，resolved 仍指向 ${resolvedVersion}（${entry.resolved}）`,
    );
    hints.push(`发行后把 resolved/integrity 对齐到 ${pkgVersion} 的正式 tgz（stage=post）`);
  }

  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    errors.push("依赖条目缺少 sha512 integrity");
  }

  return { stage: resolvedStage, ok: errors.length === 0, errors, hints };
}
