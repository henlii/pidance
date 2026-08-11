import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { buildAboutInfo } from "@/lib/about-info";
import { buildRuntimeInfo } from "@/lib/pi-runtime/runtime-info";

function attachRuntimeFields<T extends {
  piSdkVersion: string | null;
  runtimePiVersion?: string | null;
  agentRuntimeMode?: "inprocess" | "rpc";
  runtimePath?: string | null;
  runtimeCompatible?: boolean;
}>(info: T): T {
  try {
    const rt = buildRuntimeInfo(process.env, process.cwd());
    info.agentRuntimeMode = rt.agentRuntimeMode;
    info.runtimePiVersion = rt.runtime.version;
    info.runtimePath = rt.runtime.path;
    info.runtimeCompatible = rt.runtime.compatible;
    // piSdkVersion 保留 package.json 内置 SDK 版本；外部 RPC 版本在 runtimePiVersion
  } catch {
    // best-effort
  }
  return info;
}

export async function GET() {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg: unknown = JSON.parse(raw);
    const info = buildAboutInfo(pkg);
    return NextResponse.json(attachRuntimeFields(info), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    const fallback = buildAboutInfo({
      name: "@henlii/pidance",
      version: process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0",
      homepage: "https://github.com/henlii/pidance#readme",
      repository: { type: "git", url: "git+https://github.com/henlii/pidance.git" },
    });
    return NextResponse.json(attachRuntimeFields(fallback), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
