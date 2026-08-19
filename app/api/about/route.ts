import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { buildAboutInfo } from "@/lib/about-info";

export async function GET() {
  try {
    // 31415 安装位是 wrapper（cwd/package.json 的 version 恒为 1.0.0）：
    // 优先读产品包 @henlii/pidance 的 package.json，版本/SDK/仓库信息才真实。
    const productPkg = join(process.cwd(), "node_modules", "@henlii", "pidance", "package.json");
    const pkgPath = existsSync(productPkg) ? productPkg : join(process.cwd(), "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg: unknown = JSON.parse(raw);
    const info = buildAboutInfo(pkg);
    return NextResponse.json(info, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    const fallback = buildAboutInfo({
      name: "@henlii/pidance",
      version: process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0",
      homepage: "https://github.com/henlii/pidance#readme",
      repository: { type: "git", url: "git+https://github.com/henlii/pidance.git" },
    });
    return NextResponse.json(fallback, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
