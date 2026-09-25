import { loadRememberedTabSessionId } from "./tab-session-memory";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /**
   * 地址栏没有给出会话时的兜底：**本标签页**上次在看的会话（issue #81 第 5 项 / 上游 #887）。
   *
   * 与 `sessionId` 的区别是它只是提示：目标会话可能已被删除或换了分支，
   * 调用方在这种情况下应当丢弃它并按裸地址走，不要停在「会话未找到」。
   */
  rememberedSessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  // 首帧就要定「是否深链打开某个会话」，而 useSearchParams 在静态预渲染/水合阶段
  // 可能还是空的（Suspense bailout 之后才带值）；把空参数当成「无会话」会退回自动
  // 新建会话，把地址栏里的 ?session= 冲成 "/"。所以客户端以浏览器实际地址为准。
  const params = typeof window === "undefined" ? searchParams : new URLSearchParams(window.location.search);
  const requestedCwd = params.get("cwd")?.trim() || null;
  const sessionId = requestedCwd ? null : params.get("session");

  return {
    requestedCwd,
    sessionId,
    // `?cwd=`（显式指定项目）与 `?session=` 都是明确意图，这时不看记忆。
    rememberedSessionId: requestedCwd || sessionId ? null : loadRememberedTabSessionId(),
  };
}
