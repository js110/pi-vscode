# Copilot Chat 消息内容渲染调研

调研对象：VS Code 内置 Copilot Chat 宿主渲染层（`microsoft/vscode`，`src/vs/workbench/contrib/chat/`）。
目的：弄清 Copilot 的消息回复如何支持各种内容格式（字符画、代码块、diff、图片、表格等），并对照 pi-vscode 的 webview 渲染找差距与可借鉴点。

## 1. 总体架构：四层管道

```
扩展 API 层        ChatResponsePart 家族（~12 种）
                   participant 通过 ChatResponseStream push：
                   markdown / filetree / anchor / progress / reference /
                   codeCitation / command / textEdit / notebookEdit /
                   warning / confirmation / imageGeneration …
                        │ vscode-copilot-chat（参与者侧）产出
                        ▼
模型层             IChatResponseProgress（~30 种 kind，含序列化变体：
                   toolInvocationSerialized、progressTaskSerialized…）
                        ▼
分发层             chatListRenderer.renderChatContentPart()
                   按 content.kind 分发到 ~50 个 *ContentPart 类
                   （widget/chatContentParts/*.ts，一种格式一个类）
                        ▼
子渲染器           ChatContentMarkdownRenderer（marked + DOMPurify）
                   CodeBlockPart（真 Monaco editor 实例）
                   DiffEditorPool / TreePool / chatContentCodePools（对象池复用）
                   chatIncrementalRendering（流式增量渲染 + astDiff 局部更新）
```

关键设计：

- **每种内容类型一个 `*ContentPart.ts`**（`widget/chatContentParts/` 目录，共 ~70 个文件），实现统一接口 `IChatContentPart { domNode, hasSameContent(other), layout(width), dispose() }`。分发器（`chatListRenderer.ts` ≈ 6200 行）只做路由。
- **对象池**：Monaco editor / diff editor / tree 是重对象，通过 `DiffEditorPool`、`TreePool`、`chatContentCodePools` 池化复用；流式重渲染时已完成的 part 走 `hasSameContent` 比对跳过。
- **流式友好**：marked 的 `fillInIncompleteTokens` 处理未闭合的 token（比如 ```` ``` ```` 还没收尾时的 code block）；未闭合的空 code block 渲染为 `display:none` 占位；代码块收尾检测 `codeblockHasClosingBackticks(raw)`。

## 2. Markdown 渲染层（`chatContentMarkdownRenderer.ts`）

`ChatContentMarkdownRenderer` 包装核心 `MarkdownRenderer`（marked + DOMPurify），chat 特有的策略：

| 策略 | 实现 |
|---|---|
| HTML 白名单 | `allowedChatMarkdownHtmlTags`：`b/blockquote/br/code/del/em/h1-h6/hr/i/ins/li/ol/p/pre/s/strong/sub/sup/table系列/ul/a/img` + `span/div`（codicons）+ `input`（仅 checkbox，强制 disabled）；白名单外标签**替换为纯文本**（`replaceWithPlaintext`），不报错 |
| 图片安全 | 远程图仅允许 GitHub 域名白名单（`raw.githubusercontent.com`、`avatars.githubusercontent.com`、`github.com/user-attachments/assets` 等）+ 强制 HTTPS + 无凭证/非默认端口；CSS `img { max-width: 100% }` |
| 链接安全 | scheme 白名单：`vscode:`、`copilot-skill:`、agent-host 内部 scheme 等 |
| 单换行折行 | marked `gfm: true, breaks: true`（与 pi-vscode 相同） |
| 单波浪线字面量 | marked 扩展：单个 `~` 不触发删除线（避免误伤含 `~` 的代码/路径文本），`~~` 仍生效 |
| 表格单元格换行 | marked 扩展：GFM 表格单元格内的 `<br>` 转成 br token（chat 不开 supportHtml） |
| plain-text 快路径 | 无任何 markdown 语法的短文本跳过整个 marked 解析，直接 `<p>`（10 万字符截断） |
| 顶层文本节点归一化 | 渲染结果里裸文本包进 `<p>`，保证 margin 生效 |

### markdown 内 code block 的特殊路由（`chatMarkdownContentPart.ts` 的 `codeBlockRendererSync` 回调）

marked 遇到 fenced code block 时按顺序尝试：

1. `languageId === 'diff'` 且形如 ` ```diff:<lang> ` → `MarkdownDiffBlockPart`：`parseUnifiedDiff()` 把统一 diff 拆成 before/after 两份文本，嵌入**真 diff editor**（见 §4）
2. `languageId === 'vscode-extensions'` → 扩展市场卡片列表
3. `chatOutputRendererService.hasCodeBlockRenderer(languageId)` → 扩展贡献的输出渲染器（MIME/Webview 渲染，issue #316138），允许第三方按语言自定义 code block 渲染
4. 普通代码 → `CodeBlockPart`（Monaco editor），同时：
   - `extractVulnerabilitiesFromText()`：从文本中提取漏洞标记 → 代码块下方的可折叠警告列表
   - `extractCodeblockUrisFromText()`：提取 `<vscode_codeblock_uri>` 协议标记 → codemapper"编辑 pill"（显示为可点击的文件编辑胶囊而非整块代码）
5. `enableMath` → KaTeX marked 扩展；`.katex-display` 块再包一层水平滚动容器

## 3. 代码块 = 一个真正的 Monaco Editor（`codeBlockPart.ts`，1179 行）

这是"字符画/代码显示好看"的根因：**每个代码块不是 `<pre><code>`，而是一个只读 Monaco editor 实例**。

- 字体/行高：读 `chat.editor.*` 设置（`fontFamily/fontSize/fontWeight/lineHeight/fontLigatures/bracketPairColorization`），默认值即编辑器等宽字体 → **字符画（ASCII art）天然对齐**
- 折行：`chat.editor.wordWrap`（默认关 → 多行字符画/长行不会被折断破坏，超出横向滚动）；`maxHeightInLines` 截断时自动启用可见纵向滚动条
- 语法高亮：Monaco 真实 tokenizer（按 languageId），未知语言回退 plaintext
- 工具栏（hover/键盘可达）：Copy（带 copied 动画）、Apply、Insert at cursor、在新编辑器打开等，菜单 id 可配置；screen reader 模式强制保留 toolbar DOM
- 流式期 hover 状态保护：detached/reattached 时用 `force-visibility` class 保住 toolbar（浏览器丢失 `:hover`）
- 布局协调：`postponeRendering=true` 批量延迟 layout，多个代码块同一帧渲染

行内 code 的 CSS（chat.css）：

```css
code {
  font-family: var(--monaco-monospace-font);
  font-size: var(--vscode-chat-font-size-body-xs);
  color: var(--vscode-textPreformat-foreground);
  background-color: var(--vscode-textPreformat-background);
  border-radius: var(--vscode-cornerRadius-small);
  white-space: pre-wrap;
}
```

## 4. Diff：四条通道

1. **markdown 内联 diff**：AI 输出 ` ```diff:ts ` 代码块 → `MarkdownDiffBlockPart`，统一 diff 解析后嵌入 Monaco diff editor（`parseUnifiedDiff`，original/modified 双模型）
2. **edit 工具（textEditGroup）**：`ChatTextEditContentPart` → `DiffEditorPool` 池化的 CompareCodeBlock：original = 磁盘文件的 text model 引用，modified = 基于 original 快照新建的 `vscodeChatCodeBlock` scheme 内存模型
3. **multi-diff（agent 多文件）**：`multiDiffData` → `ChatMultiDiffContentPart`，跳转 VS Code 原生 multi-diff editor（一个视图看全部改动文件）
4. **editor 内 inline diff + files changed bar（agent 模式）**：`chatEditing/` 子系统——文件以红绿 inline diff 叠加在编辑器里（keep/discard 前保持 pending 状态，checkpoint timeline 可回滚）；chat 输入框上方"files changed"pill（`chatTurnPills` / `chatEditStatsButton` / `chatChangesSummaryPart`）列出本轮触达的文件，点击打开对应 diff；另有 Accessible Diff Viewer（统一 patch 文本视图）

## 5. 其他内容格式的实现速览

| 格式 | ContentPart | 要点 |
|---|---|---|
| 文件/目录引用 chip | `chatInlineAnchorWidget` + `chatMarkdownDecorationsRenderer` | markdown 里的 anchor/@file 渲染成可点击 chip，hover 预览，点击打开编辑器 |
| file tree | `chatTreeContentPart` | `WorkbenchAsyncDataTree`，懒加载、可折叠、路径压缩 |
| AI 生成图片 | `chatImageGenerationBatchPart` | 缩略图网格（失败/取消/排队状态图标）+ 选中大图预览 + 加载占位动画 + 拖拽，缩略图 lazy `<img draggable=false>` |
| 表格 | `chatMarkdownTableScrolling` | GFM 表格外包水平滚动容器，避免撑破气泡 |
| 数学公式 | KaTeX marked 扩展 | display 公式水平滚动，ResizeObserver 参与布局 |
| 终端命令 | `chatTerminalToolProgressPart` 等 toolInvocationParts（~30 个文件） | 可展开卡片：命令 + ANSI 输出 + "在终端运行"按钮；`terminal-command-request` 类消息整条用 monospace 字体 |
| thinking | `chatThinkingContentPart` / `chatThinkingStyleContentPart` | 流式折叠推理过程，完成即收起 |
| 工具调用 | `chatToolInvocationPart` + 子 part 矩阵 | 按工具类型（MCP/内置/终端/沙箱）选择子渲染器；确认类（`chatToolConfirmationSubPart`）带 Approve/Reject 按钮 |
| 进度 | `chatProgressContentPart` / working | spinner / shimmer，可嵌入 markdown 内容 |
| 引用文献 | `chatReferencesContentPart` | 顶部折叠"Used N references" |
| 公共代码引用 | `chatCodeCitationPart` | 折叠列表显示匹配的公开仓库 license 引用 |
| 命令按钮 | `chatCommandContentPart` | `ChatResponseCommandButtonPart` 渲染成可点按钮 |
| todo/plan | `chatTodoListWidget` / `chatPlanReviewPart` | 任务清单、计划审批卡 |
| 撒花动画 | `ClickAnimation.Confetti` 等四种 | 彩蛋级 |

## 6. 对照 pi-vscode：现状与可借鉴点

pi-vscode 现状（`src/webview/render/markdown.ts` + `main.css`）：
- marked + highlight.js（common 子集）、GFM + breaks:true（与 VS Code 一致）✅
- 代码块已有：语言标签、Copy/Apply 按钮、>20 行折叠展开 ✅
- CSS 已用 `--vscode-editor-font-family`、`white-space: pre`、`overflow-x: auto`、`tab-size: 4`、line-height 1.55 ✅ —— 字符画基础已具备

差距与可借鉴（按性价比排序）——**状态：1-5 及 KaTeX 已复刻实现（见 `src/webview/render/markdown.ts` + `main.css`，测试 `src/test/unit/webview/markdown.test.ts`；KaTeX 字体/CSS 由 esbuild 拷贝到 `out/webview/`，tokenizer 移植自 VS Code `markedKatexExtension.ts`），仅 anchor chip 与流式增量 diff 暂缓**：

1. **字符画细节**：字符画对齐的敌人是折行。当前 `.code-block-pre` 是 `white-space: pre` + 横向滚动，正确；但行内 code 是普通渲染，且 `line-height: 1.55` 偏"疏"，VS Code 用 editor 的固定行高更紧凑。可选：对无语言/text 代码块禁用 hljs 高亮（已做）并考虑 `font-variant-ligatures: none`（连字字体会破坏字符画）。
2. **` ```diff:lang ` 内联 diff**：pi 已有 Myers diff（`src/utils/diff.ts`）与 diff provider；可让 chat 里的 diff 代码块走双栏/红绿渲染（解析 unified diff 或按行染色），替代现在的纯文本代码块。
3. **表格横向滚动**：`.message-body table` 包 overflow 容器（VS Code 同款问题）。
4. **HTML/图片策略**：当前 `renderer.html` 全转义（安全但 AI 发不了图）。VS Code 方案 = 白名单标签 + 域名白名单远程图 + `max-width:100%`，可以照抄一个保守子集。
5. **单波浪线保护**：marked 扩展让 `~` 字面量不触发删除线（VS Code 刚修的坑 #323199），pi 直接用 marked 同样会踩。
6. **KaTeX**（可选）：marked-katex 扩展 + 滚动容器，数学密集场景才值得。
7. **流式 code block**：未闭合 ``` 时 pi 每次 reconcile 重建整个代码块；VS Code 的 `codeblockHasClosingBacktags` + `fillInIncompleteTokens` + astDiff 增量更新是更彻底的方案（pi 的 streaming reconciler 思路已经接近）。
8. **anchor chip**：让 AI 输出里的文件路径渲染成可点击 chip（openFile 消息已有能力），近似 `chatInlineAnchorWidget`。

不适用（webview 无 Monaco / 非目标）：
- 每个代码块嵌 Monaco editor、diff editor 池、multi-diff editor —— webview 是无框架浏览器环境，pi 的 hljs + DOM 方案是对的选择；对齐质量靠 CSS 变量（`--vscode-editor-font-family` 等）逼近。
- 漏洞检测、codemapper `<vscode_codeblock_uri>` 协议 —— 依赖 VS Code 内部服务。
