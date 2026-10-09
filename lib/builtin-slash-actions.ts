/**
 * 内置斜杠命令的 Web 落点映射（纯模块，供命令面板与测试共用）。
 *
 * 终端 TUI 有 25 条内置命令（SDK `dist/core/slash-commands.js:2-27`）。Web 端不可能也不需要
 * 全部照搬：有些是终端专有（退出进程、终端快捷键表），有些功能我们**已经有别的入口**
 * （认证在设置页、模型轮换在模型下拉）。这个文件把三类分清楚：
 *
 * - `host`：由宿主 RPC 处理的命令（`hooks/useAgentSession.ts` 的 handleBuiltinSlashCommand）；
 * - `ui`：Web 端有落点、由界面自己完成的命令（打开设置页 / 模型下拉 / 分支树 …）；
 * - `excluded`：明确不做，**每条都写清理由**，免得以后被当成缺口反复提。
 *
 * 不在三张表里的名字一律当「不是内置命令」（返回 unknown）——扩展/提示词/技能注册的命令走宿主，
 * 不能被这里吞掉。
 */

export type BuiltinSlashUiAction =
  | "openSettings"
  | "openModelSelector"
  | "newSession"
  | "resumeSession"
  | "openTree"
  | "exportSessionHtml";

export interface BuiltinSlashPaletteEntry {
  name: string;
  /** i18n 键（en.ts 是唯一来源）；渲染时由组件翻译。 */
  descriptionKey: string;
}

/** 命令面板里列出的内置命令（名称 + 描述键）。顺序即展示顺序。 */
export const BUILTIN_SLASH_PALETTE: BuiltinSlashPaletteEntry[] = [
  { name: "model", descriptionKey: "input_modelCommandDescription" },
  { name: "thinking", descriptionKey: "input_thinkingCommandDescription" },
  { name: "settings", descriptionKey: "input_settingsCommandDescription" },
  { name: "new", descriptionKey: "input_newCommandDescription" },
  { name: "resume", descriptionKey: "input_resumeCommandDescription" },
  { name: "tree", descriptionKey: "input_treeCommandDescription" },
  { name: "compact", descriptionKey: "input_compactCommandDescription" },
  { name: "reload", descriptionKey: "input_reloadCommandDescription" },
  { name: "export", descriptionKey: "input_exportCommandDescription" },
  { name: "name", descriptionKey: "input_nameCommandDescription" },
  { name: "session", descriptionKey: "input_sessionCommandDescription" },
  { name: "copy", descriptionKey: "input_copyCommandDescription" },
];

/** 走宿主 RPC 的命令（改会话状态 / 需要服务端数据），语义不变。 */
export const BUILTIN_SLASH_HOST_COMMANDS: readonly string[] = ["compact", "reload", "name", "session", "copy"];

/** Web 端有落点、由界面自己完成的命令。 */
export const BUILTIN_SLASH_UI_ACTIONS: Record<string, BuiltinSlashUiAction> = {
  settings: "openSettings",
  model: "openModelSelector",
  // 思考档位在 Web 上和模型在**同一个下拉**里（每个模型一行、行内展开档位），
  // 所以没有第二个菜单可开：无参数时开这个下拉，有参数时直接切换（见 resolveThinkingLevelArgument）。
  thinking: "openModelSelector",
  new: "newSession",
  resume: "resumeSession",
  tree: "openTree",
  export: "exportSessionHtml",
};

/**
 * 明确不做的内置命令 → 理由。**新增/删除都要走测试**（`lib/builtin-slash-actions.test.mjs`），
 * 免得有人无声地把某条命令挪来挪去。
 */
export const BUILTIN_SLASH_EXCLUDED: Record<string, string> = {
  quit: "终端里是退出进程；Web 端关标签页即可，没有对应动作",
  hotkeys: "Web 没有统一的按键映射表（焦点在侧栏/编辑器/插件面板时各不相同）",
  "scoped-models": "Ctrl+P 轮换用的启用集合；Web 走模型下拉与「可用模型」设置",
  share: "要发布到 GitHub gist（外部服务动作），未做",
  bug: "向 Pi 官方提 issue，属外部动作；Web 端应引导到项目自己的渠道",
  changelog: "更新日志在设置/关于里，另有版本检查入口",
  import: "要把 JSONL 写进 ~/.pi/agent 并登记会话，触碰「SessionManager 唯一 writer」规则，属独立任务",
  trust: "项目信任写进 trust.json；Web 端在打开会话时按需询问，没有独立命令入口",
  fork: "Web 是消息级 fork 按钮 + 左侧导航轨道，不是命令式选择器",
  clone: "同上，消息级入口已覆盖",
  login: "凭据在设置页「认证」里管理",
  logout: "凭据在设置页「认证」里管理",
};

export type BuiltinSlashResolution =
  | { kind: "host" }
  | { kind: "ui"; action: BuiltinSlashUiAction }
  | { kind: "excluded"; reason: string }
  | { kind: "unknown" };

/** 解析一条内置命令；不在三张表里的返回 unknown（调用方按原样交给宿主）。 */
export function resolveBuiltinSlashCommand(name: string): BuiltinSlashResolution {
  const key = name.toLowerCase();
  if (BUILTIN_SLASH_HOST_COMMANDS.includes(key)) return { kind: "host" };
  const action = BUILTIN_SLASH_UI_ACTIONS[key];
  if (action) return { kind: "ui", action };
  const reason = BUILTIN_SLASH_EXCLUDED[key];
  if (reason) return { kind: "excluded", reason };
  return { kind: "unknown" };
}

export type BuiltinThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `/thinking <level>` 的参数；大小写不敏感，非法或空返回 null。 */
export function resolveThinkingLevelArgument(raw: string): BuiltinThinkingLevel | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return THINKING_LEVELS.includes(value) ? (value as BuiltinThinkingLevel) : null;
}

export interface ModelArgumentCandidate {
  id: string;
  provider: string;
  name: string;
}

/**
 * `/model <provider/modelId>` 的参数解析。
 *
 * 支持三种写法（TUI 只认 provider/model）：`provider/modelId`、模型 id、模型显示名 —— 后两种
 * 只在**唯一命中**时才算数，「同名歧义」返回 null 让调用方退回打开选择器（不猜）。
 */
export function resolveModelArgument(raw: string, models: ModelArgumentCandidate[]): ModelArgumentCandidate | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const list = Array.isArray(models) ? models : [];

  const slash = value.indexOf("/");
  if (slash > 0) {
    const provider = value.slice(0, slash);
    const id = value.slice(slash + 1);
    return list.find((m) => m.provider === provider && m.id === id) ?? null;
  }

  const byId = list.filter((m) => m.id === value);
  if (byId.length === 1) return byId[0];
  const byName = list.filter((m) => m.name === value);
  return byName.length === 1 ? byName[0] : null;
}
