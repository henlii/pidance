import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { buildAboutInfo } from "@/lib/about-info";

export async function GET() {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg: unknown = JSON.parse(raw);
    const info = buildAboutInfo(pkg);
    return NextResponse.json(
      {
        ...info,
        agentRuntimeMode: "inprocess",
        runtimePiVersion: info.piSdkVersion,
        runtimePath: "in-process:@earendil-works/pi-coding-agent",
        runtimeCompatible: true,
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    const fallback = buildAboutInfo({
      name: "@henlii/pidance",
      version: process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0",
      homepage: "https://github.com/henlii/pidance#readme",
      repository: { type: "git", url: "git+https://github.com/henlii/pidance.git" },
    });
    return NextResponse.json(
      {
        ...fallback,
        agentRuntimeMode: "inprocess",
        runtimePiVersion: fallback.piSdkVersion,
        runtimePath: "in-process:@earendil-works/pi-coding-agent",
        runtimeCompatible: true,
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
