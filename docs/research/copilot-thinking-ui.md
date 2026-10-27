# Copilot Thinking（AI 思考过程）展示效果调研

调研对象：`microsoft/vscode` 的 `chatThinkingContentPart.ts`（3261 行）+ `chatThinkingStyleContentPart.ts`（基类）+ `chatThinkingContent.css`（902 行）+ `chat.css` shimmer 部分。
目的：对照 pi-vscode 现有 thinking-block，找出 Copilot 效果好看的具体手法。

## 1. Copilot 的结构分层

```
ChatThinkingStyleContentPart (基类, 继承 ChatCollapsibleContentPart)
  └─ .chat-thinking-box            容器；.chat-thinking-active 状态类
      ├─ .chat-used-context-label  折叠头（monaco icon button：图标 + 标题 + hover chevron）
      └─ .chat-thinking-collapsible 内容列表
          ├─ .chat-thinking-item   每行：chain 圆点图标 + markdown 正文
          └─ .chat-thinking-spinner-item  spinner 行：圆点 + shimmer 标签
```

展示模式由设置 `chat.agent.thinkingStyle` 控制（`ThinkingDisplayMode.Collapsed` / `CollapsedPreview` / conversation / tool-chain 变体）；只读会话和手机布局强制 CollapsedPreview。

## 2. 图标语言（与 pi 差异最大的点）

| 状态 | Copilot | pi 现状 |
|---|---|---|
| 进行中（头） | `codicon-circle-filled-compact` 实心小圆点 | 橙色点 `pulse-dot` 呼吸动画 |
| 完成（头） | **`codicon-check-compact` 对勾**（语义化"已完成"） | 静止绿点 |
| 内容每行 | **`codicon-circle-filled` chain 圆点**，绝对定位于行首、按 `--chat-chain-icon-top` 与正文行高中点对齐，形成"思维链"竖列 | 无行级图标 |
| chevron | hover 显现，展开旋转（同 pi） | 同 |

图标全部用 compact 尺寸（`--vscode-codiconFontSize-compact`），图标切换随 `expanded`/`thinkingActive` 状态用 autorun 响应式更新（`setThinkingActive()` 里同步换 icon）。

## 3. Shimmer 文字动画（精确参数）

```css
background: linear-gradient(90deg,
    var(--vscode-descriptionForeground) 0%,  30%,
    var(--vscode-chat-thinkingShimmer)      50%,   /* 主题专用高亮色 */
    var(--vscode-descriptionForeground) 70%, 100%);
background-size: 400% 100%;
background-clip: text; -webkit-background-clip: text;
-webkit-text-fill-color: transparent;
animation: chat-thinking-shimmer 2s **steps(60, end)** infinite;

@keyframes chat-thinking-shimmer { 0% {background-position: 120% 0} 100% {background-position: -120% 0} }
```

三个关键细节（pi 目前缺）：
1. **`steps(60, end)` 而非 `linear`**——60 步离散推进，视觉上"匀速扫过"但避免了 linear 插值在部分帧率下的细碎抖动，这是 VS Code 调过的参数
2. **`--vscode-chat-thinkingShimmer` 专用主题变量**（默认 #32e9d6 之类的青色高光）——不是 accent/focusBorder，扫过的高光色与正文 descriptionForeground 形成"暗-亮-暗"三段
3. keyframes 起点是 **120% → -120%**（不是 100%→-100%），保证光带完全离开文字后才折返

配套状态：
- `.chat-progress-shimmer-paused` → `animation-play-state: paused`（流式暂停/重连时冻结光带）
- `.monaco-reduce-motion` → 关闭动画（无障碍）
- `will-change: background-position`（pi 已有 ✓）

## 4. 标题文案系统

- **进行中动词轮换**（`defaultThinkingMessages`）：Thinking / Reasoning / Considering / Analyzing / Evaluating / Working（6 个通用）+ Executing/Running/Processing（终端）+ Preparing/Loading 等（工具）
- **完成态**：`"Finished thinking after {0}"`（`formatElapsedTime`，不足 1s 记 1s）；折叠标题带时长：`"Thinking - 12s"`（`{title} - {duration}`）
- 标题旁可挂 `.chat-thinking-title-detail` 副标题（markdown 小字）

pi 已有 "Thought for Ns"（GitHub 风格），语义等价；缺动词轮换。

## 5. "思维链"轨道视觉（rail / 挂钩线）

展开时，折叠头与缩进内容之间有一条 **L 形挂钩线**（不是 pi 的横 hairline）：

```css
.chat-thinking-box:not(.chat-used-context-collapsed) > .chat-used-context-label::after {
    content: ""; box-sizing: border-box;
    left: var(--chat-persistent-rail-left);
    width: var(--chat-persistent-hook-width);
    height: calc(nested-gap + font-size * 0.75 + stroke/2);
    border-width: var(--vscode-strokeThickness);
    border-bottom-left-radius: var(--vscode-cornerRadius-medium);
    pointer-events: none;
}
```

配合内容列表 `margin-left: nested-indent` + 每行 chain 圆点，形成"标题 → 弯钩 → 圆点链"的树形轨道，是 Copilot thinking 视觉质感的最大来源。圆点绝对定位（`position: absolute; left: …; top: …`）保证多行内容圆点严格竖向对齐。

## 6. 交互细节

- 进行中自动展开、完成自动收起（pi 已有 ✓）；手动展开后不被后续刷新折叠（pi `thinkingWasActive` 同思路 ✓）
- 流式期间 DOM detach 会丢 `:hover`——Copilot 用显式 hover 状态类保 toolbar（pi 无此问题，无按钮）
- aria：thinking 开始/结束 `alert()` 播报；折叠头是 button，可 Tab
- 内容行字号比正文小一档（`body-s` vs `body-m`），行距按 `font-size * 0.75` 精调

## 7. 对照 pi 现状：已具备 / 差距 / 可借鉴清单

**已具备**（messages.ts `buildThinkingBlock`/`updateStreamingThinking` + main.css）：
details/summary 折叠、shimmer 标签（已借鉴但参数不同）、hover chevron、完成自动折叠、"Thought for Ns"、内容区小字+滚动。

**差距（按视觉收益排序）——1-4 已复刻（messages.ts + i18n.ts + main.css，动词轮换/对勾图标有测试锁定），5-6 暂缓**：

1. **完成态图标换对勾**：`codicon-check` 替代静止绿点——一行 CSS/DOM 改动，语义立刻清晰
2. **shimmer 参数对齐**：`steps(60, end)` 替换 `linear`；高光色改用 `--vscode-chat-thinkingShimmer`（带 fallback 到 accent）；keyframes 用 ±120%
3. **思维链轨道**：展开内容的 L 形挂钩线 + 每行 chain 圆点（`codicon-circle-filled`，绝对定位对齐）——改动集中在 thinking-content 渲染 + 少量 CSS，是"变好看"的核心
4. **reduce-motion**：`@media (prefers-reduced-motion: reduce)` 关闭 shimmer/pulse
5. **动词轮换**（可选）：Thinking/Reasoning/Analyzing… 定时轮换标题，弱化"卡住"感
6. **暂停态冻结**（可选）：pi 暂无 shimmer-paused 等价状态，流式暂停时可直接停 animation

**不建议复刻**：三种 thinkingStyle 展示模式设置、conversation/tool-chain 变体（VS Code 把工具调用也塞进 thinking 区，pi 的工具卡片体系已独立）；aria alert 播报可后置。
