

import { createSessionLockHandler } from "@/lib/session-lock-route";

export const dynamic = "force-dynamic";

export const GET = createSessionLockHandler();
