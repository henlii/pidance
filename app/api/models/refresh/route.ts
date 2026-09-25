/**
 * POST /api/models/refresh — 服务商上新模型后立刻刷新目录（带网络）。
 *
 * 失败语义见 lib/model-catalog-refresh.ts：明确 502 + 原因，**不改动**任何文件，
 * 也不让已有列表看起来变空。SDK 不可用时给 503（可选依赖未安装）。
 *
 * `createRefreshHandler` 暴露出来只为可测：路由本身不注入任何实现，
 * 测试传假刷新器来断言状态码与响应体，不必触网。
 */

import { createRefreshHandler } from "@/lib/models-refresh-route";

export const dynamic = "force-dynamic";

export const POST = createRefreshHandler();
