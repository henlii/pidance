# Pidance UI 主题令牌（设计参考）

[设计稿索引](README.md) · [文档导航](../README.md)

> 本文保留设计阶段的主题值与尺寸目标，不保证与当前生产 CSS 逐项一致。当前变量、selector 与实际值以 [app/globals.css](../../app/globals.css) 为准；修改组件时复用现有语义变量，不将本表复制为第二套运行时主题。

两套方向保持 Pidance 现有 `--bg / --text / --accent` 命名骨架，并补充 surface、状态、焦点和阴影变量。组件只引用语义变量，不在组件内出现主题色值。

## A · Chamber 原生

### 浅色

```css
:root[data-theme="light"][data-skin="chamber-native"] {
  --bg: #fdfcfa;
  --bg-panel: #f7f6f4;
  --bg-elevated: #ffffff;
  --bg-hover: #0000000d;
  --bg-selected: #b350172b;
  --bg-subtle: #f4f3f1;
  --border: #e5e1de;
  --border-strong: #cbc7c2;
  --text: #393a34;
  --text-muted: #5c5c54;
  --text-dim: #797970;
  --accent: #b35017;
  --accent-hover: #9a4310;
  --accent-foreground: #ffffff;
  --user-bg: #f7f2ee;
  --assistant-bg: #fdfcfa;
  --tool-bg: #efeeec80;
  --code-bg: #f4f3f1;
  --status-running: #b35017;
  --status-unread: #2d72c4;
  --status-success: #5f8d3d;
  --status-warning: #8d6c15;
  --status-danger: #b7493f;
  --focus: #b35017;
  --focus-ring: #b3501755;
  --overlay: #39393420;
  --shadow-float: 0 18px 50px #39393424;
  --shadow-input: 0 1px 2px #39393412, 0 0 0 1px #ffffff80 inset;
}
```

### 深色

```css
:root[data-theme="dark"][data-skin="chamber-native"] {
  --bg: #120f0e;
  --bg-panel: #171615;
  --bg-elevated: #1c1a18;
  --bg-hover: #ffffff12;
  --bg-selected: #b9a5992b;
  --bg-subtle: #171616;
  --border: #242323;
  --border-strong: #504e4c;
  --text: #c9c5ba;
  --text-muted: #8f8b81;
  --text-dim: #77736b;
  --accent: #da7c47;
  --accent-hover: #eb8c57;
  --accent-foreground: #120f0e;
  --user-bg: #25170e;
  --assistant-bg: #120f0e;
  --tool-bg: #120f0e80;
  --code-bg: #0e0c0b;
  --status-running: #da7c47;
  --status-unread: #479fe6;
  --status-success: #76ad4f;
  --status-warning: #c67f13;
  --status-danger: #da5b4a;
  --focus: #da7c47;
  --focus-ring: #da7c4755;
  --overlay: #00000099;
  --shadow-float: 0 20px 60px #00000070;
  --shadow-input: 0 1px 2px #00000040, 0 0 0 1px #ffffff08 inset;
}
```

## B · Pidance 融合

### 浅色

```css
:root[data-theme="light"][data-skin="pidance-fusion"] {
  --bg: #fbfcfd;
  --bg-panel: #f3f6f7;
  --bg-elevated: #ffffff;
  --bg-hover: #163b4d0a;
  --bg-selected: #2e6f9520;
  --bg-subtle: #eef2f3;
  --border: #dce4e6;
  --border-strong: #bdcbd0;
  --text: #263439;
  --text-muted: #607077;
  --text-dim: #819096;
  --accent: #286e98;
  --accent-hover: #1e5c82;
  --accent-foreground: #ffffff;
  --user-bg: #eaf2f7;
  --assistant-bg: #fbfcfd;
  --tool-bg: #f0f5f4;
  --code-bg: #172126;
  --status-running: #27836e;
  --status-unread: #286e98;
  --status-success: #49805d;
  --status-warning: #9a6a1a;
  --status-danger: #b34f58;
  --focus: #286e98;
  --focus-ring: #286e9844;
  --overlay: #18343d30;
  --shadow-float: 0 18px 48px #163b4d20;
  --shadow-input: 0 1px 2px #163b4d12, 0 0 0 1px #ffffff inset;
}
```

### 深色

```css
:root[data-theme="dark"][data-skin="pidance-fusion"] {
  --bg: #101719;
  --bg-panel: #141d20;
  --bg-elevated: #192428;
  --bg-hover: #d8edf212;
  --bg-selected: #6ba7c426;
  --bg-subtle: #172124;
  --border: #263337;
  --border-strong: #46585e;
  --text: #ced8d8;
  --text-muted: #8d9c9e;
  --text-dim: #708084;
  --accent: #69a7ca;
  --accent-hover: #7fb8d6;
  --accent-foreground: #0f1719;
  --user-bg: #162832;
  --assistant-bg: #101719;
  --tool-bg: #121d1f;
  --code-bg: #0b1113;
  --status-running: #5eb39b;
  --status-unread: #69a7ca;
  --status-success: #79ad78;
  --status-warning: #d0a356;
  --status-danger: #dd777e;
  --focus: #69a7ca;
  --focus-ring: #69a7ca55;
  --overlay: #00000099;
  --shadow-float: 0 20px 60px #00000066;
  --shadow-input: 0 1px 2px #0000003d, 0 0 0 1px #ffffff08 inset;
}
```

## 共通非颜色令牌

```css
:root {
  --font-ui: "Aptos", "Segoe UI Variable", "Noto Sans SC", sans-serif;
  --font-reading: "Source Han Sans SC", "Noto Sans SC", sans-serif;
  --font-mono: "Cascadia Code", "SFMono-Regular", "Noto Sans Mono CJK SC", monospace;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 9px;
  --radius-lg: 13px;
  --radius-pill: 999px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --sidebar-width: 268px;
  --workspace-width: 320px;
  --rail-width: 40px;
  --chat-max-width: 760px;
  --motion-fast: 150ms ease;
  --motion-normal: 250ms ease;
  --motion-drawer: 280ms cubic-bezier(.22, 1, .36, 1);
}
```

## 细节规范

### 排版

| 角色 | 桌面 | 手机 | 规则 |
|---|---:|---:|---|
| 会话／控件 | 12.5px / 1.4 | 14px / 1.4 | 常规 400；选中不加粗，避免截断抖动。 |
| 正文 | 14px / 1.72 | 15px / 1.68 | 桌面每行 60–75 字符，手机 35–55 字符。 |
| 小标题 | 16px / 1.35 | 17px / 1.35 | 600，段前留 20px。 |
| 辅助信息 | 11px / 1.35 | 12px / 1.35 | 状态计时使用等宽数字。 |
| 代码 | 12.5px / 1.65 | 12px / 1.6 | 禁止以更小字号塞入更多内容。 |

### 结构与状态

- 侧栏会话行高 30px，项目行 32px；子层每级缩进 16px，最多直显 4 层，更多层沿同一导线滚动。
- 选中态使用完整行 `--bg-selected`，当前会话标题用 `--accent`；不增加左侧彩条，避免与树导线冲突。
- 运行态：6px `--status-running` 静态圆点 + 右侧“1分 24秒”；未读态：6px `--status-unread` 圆点 + 无障碍文本。状态不可只靠颜色。
- 用户消息最大宽 86%，使用 `--user-bg` 和 1px 边框；助手消息不设容器背景。
- 工具卡圆角 9px、1px 边框；收起高度 38px，展开内容上方再加 1px 分割线。
- 输入框桌面最小 92px、手机最小 88px；聚焦时边框变为 `--focus` 并显示 3px 半透明 ring。
- 常驻按钮桌面最小 32×32px；移动端所有点击目标至少 44×44px。

### 动效

- 页面载入只做一次：侧栏、聊天、右栏依次以 30ms 间隔淡入；位移不超过 6px。
- 抽屉只动画 `transform` 与 `opacity`，不动画宽度；遮罩和抽屉同步进出。
- 会话运行点不呼吸、不闪烁；只在 idle → running 切换时做一次 150ms scale 反馈。
- `prefers-reduced-motion: reduce` 时取消位移、缩放与列表 stagger，仅保留即时状态变化。

### 对比与焦点

- 正文／背景、控件标签／surface 目标对比度 ≥ 4.5:1；边界不是信息唯一载体。
- 所有键盘焦点使用 2px `--focus` outline + 2px offset；不得用 `outline: none` 后不补替代。
- Git 增删、运行／未读、成功／错误均同时配图标或文字，不以红绿或蓝橙单独编码。
