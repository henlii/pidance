/**
 * API-key provider 列表：内置目录 + models.json 中已有供应商 + **扩展注册的 provider** + auth 状态。
 * 不依赖 ModelRuntime；OAuth 供应商走 /api/auth/providers。
 *
 * 扩展 provider 的来源见 lib/extension-providers.ts（SDK 默认 resource loader 加载扩展后的
 * pending 注册）。加载失败只降级为空列表并把原因放进 extensionProvidersError，不影响内置目录。
 *
 * `createAllProvidersHandler` 暴露出来只为可测：路由本身不注入实现，测试传假加载器即可断言
 * 「扩展 provider 出现在列表里 / 与内置同 id 时不覆盖 / 失败不炸」。
 */

import { createAllProvidersHandler } from "@/lib/all-providers-route";

export const dynamic = "force-dynamic";

export const GET = createAllProvidersHandler();
