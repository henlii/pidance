export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  // 首帧就要定「是否深链打开某个会话」，而 useSearchParams 在静态预渲染/水合阶段
  // 可能还是空的（Suspense bailout 之后才带值）；把空参数当成「无会话」会退回自动
  // 新建会话，把地址栏里的 ?session= 冲成 "/"。所以客户端以浏览器实际地址为准。
  const params = typeof window === "undefined" ? searchParams : new URLSearchParams(window.location.search);
  const requestedCwd = params.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : params.get("session"),
  };
}
