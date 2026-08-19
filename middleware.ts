import { NextResponse, type NextRequest } from "next/server";
import { guardRequest, type RequestGuardHeaders } from "@/lib/request-guard";
import { readServerConfig } from "@/lib/pidance-server-config";

// 请求安全中间件（对齐上游 pi-web 0.8.6 + P0 fail-closed + #18 UI 会话）：
// 1. Host 白名单（localhost/IP/PI_WEB_HOSTNAME/PI_WEB_ALLOWED_HOSTS）——防 DNS rebinding
// 2. API 请求 CSRF 防护（origin/sec-fetch-site 校验；会话导出 navigate 豁免）
// 3. 认证：PIDANCE_PASSWORD / PI_WEB_PASSWORD，或设置 → 通用 保存的服务端密码
//    （~/.pi/agent/pidance-server.json）启用时接受 Cookie 会话或 Basic（用户名 pi）
// 4. 兜底：未设密码时仅回环；非回环 401
// 5. 页面未认证：放行到前端由页内登录处理（不再弹 Basic 对话框）；API 未认证返回 401 JSON
export const runtime = "nodejs";

function toHeaders(req: NextRequest): RequestGuardHeaders {
  return {
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    secFetchMode: req.headers.get("sec-fetch-mode"),
    secFetchDest: req.headers.get("sec-fetch-dest"),
    secFetchUser: req.headers.get("sec-fetch-user"),
    authorization: req.headers.get("authorization"),
    cookie: req.headers.get("cookie"),
    method: req.method,
    url: req.url,
    pathname: req.nextUrl.pathname,
  };
}

export function middleware(req: NextRequest) {
  const isApi = req.nextUrl.pathname === "/api" || req.nextUrl.pathname.startsWith("/api/");
  const verdict = guardRequest(toHeaders(req), process.env, {
    config: readServerConfig(),
  });
  switch (verdict) {
    case "untrusted-host":
      return isApi
        ? NextResponse.json({ error: "Untrusted API request" }, { status: 403 })
        : new NextResponse("Untrusted request", { status: 403 });
    case "csrf":
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    case "auth-required":
      // API：401 JSON，不附 WWW-Authenticate（避免浏览器 Basic 弹窗抢主路径）
      if (isApi) {
        return NextResponse.json(
          { error: "Authentication required", locked: true },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }
      // 页面：放行，由客户端渲染页内登录（#18）
      return NextResponse.next();
    default:
      return NextResponse.next();
  }
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
