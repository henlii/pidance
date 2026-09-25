/**
 * GET  /api/models/enabled — 每模型开关面板的数据：**未过滤**的可用目录 + 当前 enabledModels。
 * POST /api/models/enabled — 开关单个模型（最小编辑 settings.json，只动 enabledModels）。
 *
 * 为什么 GET 不在 /api/models 上加开关位：那里返回的是**已过滤**的列表，被关掉的模型
 * 根本不在里面，界面就没法把它显示成「关」。这里返回完整目录 + `enabled` 标记。
 *
 * 状态语义见 lib/enabled-models-store.ts。错误码：
 * 400 参数非法 / 422 settings.json 读不出（拒写）/ 409 项目级覆盖只读、或不允许关掉最后一个。
 */

import { createEnabledModelsGET, createEnabledModelsPOST } from "@/lib/enabled-models-route";

export const dynamic = "force-dynamic";

export const GET = createEnabledModelsGET();

export const POST = createEnabledModelsPOST();
