# Pidance 图标设计参考（Lucide React）

[设计稿索引](README.md) · [文档导航](../README.md)

## 适用范围

本文是设计阶段建议，不是已实现组件 API。当前业务组件直接使用 `lucide-react`，并有品牌/文件类型等专用图标；不要为了符合下方示例新增一次性 `Icon` 抽象。尺寸、状态与可访问性建议供评审参考，具体实现沿用项目现有路径。

下方 `Icon` 是历史示例，不表示仓库已经提供此组件。静态 HTML 稿中的 SVG 仅用于无依赖预览，不作为生产图标源码。

```tsx
import type { LucideIcon } from "lucide-react";

type IconSize = "xs" | "sm" | "md" | "lg";

type IconProps = {
  icon: LucideIcon;
  size?: IconSize;
  label?: string;
  className?: string;
};

const sizeClass: Record<IconSize, string> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
};

export function Icon({ icon: Glyph, size = "md", label, className }: IconProps) {
  return (
    <Glyph
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`${sizeClass[size]} shrink-0 ${className ?? ""}`}
      strokeWidth={1.75}
    />
  );
}
```

## 尺寸与描边

| 场景 | 图标 | 点击目标 | 描边 |
|---|---:|---:|---:|
| 会话树、路径、辅助状态 | 12–14px | 行本身可点击 | 1.75 |
| 桌面工具栏 | 16px | 32×32px | 1.75 |
| 手机顶栏／底栏 | 20px | ≥44×44px | 1.75 |
| 空态或引导 | 24–28px | 非交互 | 1.5 |

- 同一工具条只使用一个光学尺寸，不因图标本身看起来小就随意加粗。
- 图标默认 `currentColor`；颜色来自 `--text-muted / --accent / --status-*`。
- 选中态优先改容器底色与文字色，不使用 filled 图标和 outline 图标混搭。

## 推荐映射

| Pidance 语义 | Lucide 图标 |
|---|---|
| 新会话／添加 | `SquarePen` / `Plus` |
| 搜索／命令 | `Search` / `Command` |
| 展开／收起 | `ChevronRight` / `ChevronDown` |
| 项目／目录／文件 | `FolderGit2` / `Folder` / `File` |
| 工作树／分支 | `GitBranch` |
| 子代理 | `Bot`（必须同时显示“子代理”短标签） |
| 文件／Git／会话信息 | `Files` / `GitCompareArrows` / `Info` |
| 外观／模型／默认值 | `Palette` / `Boxes` / `SlidersHorizontal` |
| 技能／插件／信任 | `BookOpen` / `Plug` / `ShieldCheck` |
| 思考／工具 | `Brain` / `Wrench` |
| 发送／停止 | `ArrowUp` / `Square` |
| 成功／警告／失败 | `Check` / `TriangleAlert` / `CircleX` |

## 状态图标规则

1. **运行与未读不用 Lucide 图标**：使用 6px CSS 圆点，并配计时、文本或 `aria-label`；这是对 OpenChamber 最新静态圆点方案的适配。
2. **加载中**：只在无法显示进度或计时时使用 `LoaderCircle`，旋转仅作用于图标，且尊重 reduced motion。
3. **子代理**：`Bot` 只是辅助，旁边必须有“子代理”文字徽标，避免图标猜测。
4. **Git 增删**：使用 `Plus / Minus` 或 `A / M / D` 文本状态并配语义色，不能只靠绿／红。
5. **危险动作**：图标和文字同时使用 `--status-danger`，并与普通动作分组隔开。

## 可访问性

- 带可见文字的图标设 `aria-hidden="true"`；纯图标按钮在按钮上提供准确的 `aria-label` 和 `title`。
- 不把 tooltip 当作唯一名称；键盘和触屏均能获得动作名称。
- 焦点环画在按钮容器而不是 SVG 上，范围覆盖完整点击目标。
- RTL 界面中，表达物理方向的 `ChevronLeft/Right` 需要镜像；`Play`、`GitBranch` 等语义图标不镜像。

## 禁止项

- 不使用 emoji、字体图标、系统字符模拟图标。
- 不在业务组件直接写 SVG path；品牌标识例外，但需独立组件。
- 不混用 1px、2px、2.5px 描边，不通过 `fill` 制造“选中版”。
- 不给静态图标加发光、渐变或永久动画。
