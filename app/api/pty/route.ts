import { NextResponse } from "next/server";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { tryLoadNodePty } = requireCjs("../../../bin/pty-manager.cjs") as { tryLoadNodePty: () => unknown };

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ available: tryLoadNodePty() !== null });
}
