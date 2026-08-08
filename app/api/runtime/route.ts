import { NextResponse } from "next/server";
import { buildRuntimeInfo } from "@/lib/pi-runtime/runtime-info";

export const dynamic = "force-dynamic";

/** GET /api/runtime — 管理面 vs 外部 RPC runtime 版本与能力探测（只读）。 */
export async function GET() {
  try {
    const info = buildRuntimeInfo(process.env, process.cwd());
    return NextResponse.json(info, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        pidanceVersion: "0.0.0",
        agentRuntimeMode: "inprocess",
        managementPiVersion: null,
        runtime: {
          path: null,
          version: null,
          source: "none",
          protocol: "inprocess",
          compatible: false,
        },
        capabilities: {
          deltaOnlyMessageUpdate: false,
          agentSettled: false,
          bashExecutionUpdate: false,
          extensionUi: false,
          getEntries: false,
          getTree: false,
        },
        upgrade: {
          policy: {
            allowAutoUpgrade: false,
            allowExplicitUpgrade: false,
            slotsRoot: "",
          },
          slots: [],
          current: null,
          recommendation: "blocked",
          reason: `runtime probe failed: ${message}`,
        },
        notes: [`runtime probe failed: ${message}`],
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
