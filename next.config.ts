import type { NextConfig } from "next";
import { builtinModules } from "module";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
// 产品默认只用外部 pi；不再读 npm 包版本
const piVersion = process.env.NEXT_PUBLIC_PI_VERSION || "external";

// 31416 持续测试构建（PIDANCE_DIST_DIR=.next-public）与正式/发布构建（默认 .next）分流。
const isLocalTestDist = process.env.PIDANCE_DIST_DIR === ".next-public";

const nextConfig: NextConfig = {
  // 公网生产构建可设 PIDANCE_DIST_DIR=.next-public，避免污染 dev 的 .next
  distDir: process.env.PIDANCE_DIST_DIR || ".next",
  // 测试构建跳过整仓 tsc（省 ~30–60s）；类型安全仍由 `npm run typecheck` / 发布链路兜底。
  // 正式构建（无 PIDANCE_DIST_DIR 或非 .next-public）保持严格。
  typescript: {
    ignoreBuildErrors: isLocalTestDist,
  },
  // Next 16.2：Turbopack 生产构建磁盘缓存需显式开启（16.3 起默认）。
  // 缓存位于 distDir/cache/turbopack；local-deploy 不得删除整个 .next-public。
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
  serverExternalPackages: [
    "undici",
  ],
  // 仅 webpack 路径使用（`next build --webpack` / 发布）。Turbopack 忽略本回调，
  // 依赖 serverExternalPackages + 原生 node: 处理。
  webpack(config, { isServer }) {
    if (isServer) {
      // instrumentation.ts 也必须复用 Node 侧的 undici；否则 webpack 会尝试
      // 打包其 node:console 等内建模块并触发 UnhandledSchemeError。
      config.externals.push({ undici: "commonjs undici" });
      // instrumentation 链上的本地模块（pi-subagent-bridge 等）直接 import
      // node: 内建（fs/path/url/...），同样必须保持 external，否则
      // UnhandledSchemeError 打断 server 编译。
      for (const name of builtinModules) {
        config.externals.push({ [`node:${name}`]: `commonjs node:${name}` });
      }
    }
    return config;
  },
  ...(process.env.NODE_ENV === "development"
    ? { allowedDevOrigins: ["127.0.0.1", "192.168.*.*", "100.99.31.21", "pidance.namixinxi.cn"] }
    : {}),
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
