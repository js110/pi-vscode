# pi-vscode 需求功能树（功能地图）

> 来源：`prd/PRD.md` v1.0 正式版（2026-09-14），对应 PRD 第 7 节功能清单（M06）与第 9 节功能详细说明（M09）
> 层级：页面 → 功能组 → 功能（原子功能 = 最小可测单元：单一操作 + 单一预期）
> 流程功能：以 `F-` 为前缀，平级归属页面下的"FLOW 入口"组；步骤以 `{##功能编号}` 引用已定义的原子功能，禁止循环引用
> 编号规则：`{页面缩写}-{功能组缩写}-{功能缩写}`，每段不超过 4 位大写英文，全局唯一、无数字
> 统计：8 个页面视图 · 23 个功能组 · 74 项原子功能 · 9 条流程功能；覆盖 PRD 5.1 节全部 17 项范围（对照表见文末附录）

- SB 侧边栏主面板（配置接入与会话入口） [活动栏 > Pi 侧边栏视图]
  - SB-CFG 配置接入
    - SB-CFG-DISC 配置自动发现：用户打开插件激活面板，系统只读读取 `~/.pi/agent` 的凭证/模型/技能/会话，显示"已从 Pi 读取 N provider / M 模型"统计
    - SB-CFG-ERRS 无配置错误态：未检测到 Pi 配置时呈现缺失说明 + 文档链接 + 重新检测按钮，不出现空白面板、不出现配置表单
    - SB-CFG-REDT 重新检测：用户在错误态点击"重新检测"，重走发现流程，成功后渲染主面板，无需重启 VS Code 且输入草稿保留
    - SB-CFG-ENVP 凭证环境提示：终端可发现 pi 而当前 VS Code 进程读不到同等凭证时，提示具体原因（凭证依赖的环境变量在当前进程不可见）
    - SB-CFG-PARS 配置解析容错：配置文件语法/字段错误时保留上一个可用列表并给出文件 + 行号级错误，多 provider 部分失效仅标注失效项、不整体失败
    - SB-CFG-AUTH 凭证异常提示：provider 凭证被拒（401/403）时区分于网络错误，流式内容保留并提示具体错误，修复后点重试即恢复、无需重启
  - SB-MSEL 模型选择
    - SB-MSEL-MODE 选择模型：用户从模型选择器选择模型，列表与终端 `/model` 一致（自定义条目按 pi 合并语义呈现），后续对话使用所选模型
    - SB-MSEL-RFSH 配置热刷新：用户打开模型选择器时重读 Pi 配置，外部修改配置无需重启即生效；正在使用的模型被删除时提示更换模型
  - SB-SESS 会话历史
    - SB-SESS-LIST 浏览会话列表：用户打开会话历史，按项目/时间列出 pi 会话目录中的会话并可搜索，500+ 条首屏加载不超过 1 秒
    - SB-SESS-LOAD 加载历史会话：用户选择会话加载，上下文与 token 用量与终端一致（终端 87K 插件同为 87K）；会话所用模型不可用时要求选替代模型而非拒载
    - SB-SESS-NEW 新建 Tab：用户新建 Tab 开始新对话，各 Tab 拥有独立会话与状态、互不共享
  - SB-FLOW 入口
    - F-PIBOOT 首次接入并发出首条消息
      - {##SB-CFG-DISC}：激活时自动发现 Pi 配置并渲染主面板，零配置操作
      - {##SB-MSEL-MODE}：从与终端一致的模型列表中选择模型
      - {##CIN-SEND-MSG}：发送第一条消息，全程不超过 30 秒
    - F-DUALSE 双端续聊
      - {##SB-SESS-LOAD}：加载终端 CLI 产生的会话，上下文与 token 用量两侧一致
      - {##CIN-SEND-MSG}：插件侧继续发送消息，会话每轮即时落盘为 pi 原生格式
      - {##TSK-SGL-TAKE}：会话被另一窗口/终端占用时按单写者语义处理，历史无覆盖丢失

- CIN 聊天输入区 [侧边栏视图 > 聊天输入区]
  - CIN-SEND 消息发送
    - CIN-SEND-MSG 发送消息：用户输入文本发送，消息进入当前 Tab 并触发流式回复，会话每轮即时落盘
  - CIN-IMG 图片输入
    - CIN-IMG-GATE 入口能力门控：图片入口按当前模型能力动态启用；模型不支持时置灰，点击与粘贴图片均有明确提示、不无声失败
    - CIN-IMG-PSTE 粘贴图片：用户粘贴图片到输入框，图片作为附件随消息发送并落盘为 pi 会话格式
    - CIN-IMG-PICK 按钮选择图片：用户点击图片按钮选择本地图片文件，随消息发送
    - CIN-IMG-DRAG 拖拽图片：用户拖拽图片文件进输入区，作为图片附件随消息发送
  - CIN-MENT @-mention
    - CIN-MENT-FILE 文件引用补全：用户输入 @ 后模糊匹配工作区文件，选中后作为上下文注入消息
    - CIN-MENT-SYMB 符号引用补全：用户输入 @ 后模糊匹配工作区符号并注入上下文；工作区无符号索引时降级为仅文件级补全
    - CIN-MENT-GONE 失效引用提示：被引用的文件在发送前被删除时提示用户
  - CIN-DRAG 拖拽引用
    - CIN-DRAG-FILE 拖拽文件引用：用户拖拽文件进对话区域，转为文件引用（与 @-mention 同一注入路径）
  - CIN-MODE 模式切换
    - CIN-MODE-SWTC 切换对话/Plan 模式：用户通过模式切换器在两档间切换，切到 Plan 后输入区标注当前模式
  - CIN-CMP 上下文压缩
    - CIN-CMP-PROM 阈值提示条：上下文用量超过阈值（默认 80%）时输入区上方出现提示条，说明摘要将覆盖的范围且计划/TODO 列入保留清单
    - CIN-CMP-EXEC 确认压缩：用户点击"压缩"，执行 Pi 原生压缩，压缩后计划/TODO 仍可见、上下文用量回落
    - CIN-CMP-DEFR 暂不压缩：用户点击"暂不"关闭提示条，同一阈值区间内不重复弹出
    - CIN-CMP-MANU 手动压缩：用户执行 `/compact` 命令直接触发压缩（保留手动入口）
    - CIN-CMP-FAIL 压缩失败兜底：压缩请求失败时保持原上下文不变并明确提示，可改用手动命令，执行不无声中断
  - CIN-FLOW 入口
    - F-CTXINJ 上下文注入发送
      - {##CIN-MENT-FILE}：以 @-mention（或右键菜单/拖拽文件）注入文件与符号上下文
      - {##CIN-SEND-MSG}：携带上下文发送消息，模型基于注入内容作答

- CMS 聊天消息流 [侧边栏视图 > 消息流区域]
  - CMS-CODE 代码块
    - CMS-CODE-HLGT 语法高亮渲染：代码块按语言语法高亮显示，长代码块可折叠
    - CMS-CODE-COPY 复制代码块：用户点击"复制"，复制代码块原文到剪贴板
    - CMS-CODE-APPL Apply 写入文件：用户点击 Apply，先显示目标文件与将被替换的 diff 预览，确认后写入并可一步撤销（纳入本 Tab checkpoint）；预览与确认之间文件被外部修改时阻止写入并提示重新预览
  - CMS-APM 工具审批与记忆
    - CMS-APM-CARD 审批卡片呈现：AI 发起工具调用且记忆未命中时弹出审批卡，展示工具名、参数摘要与危险标识
    - CMS-APM-ALOW 允许一次：用户点击"允许"，本次工具调用放行执行，改动进 diff + checkpoint
    - CMS-APM-RMBR 允许并记住：用户点击"允许并记住"并选择本会话/全局档位，按工具名写入记忆规则，后续同类调用自动放行
    - CMS-APM-DENY 拒绝调用：用户点击"拒绝"，工具不执行，拒绝结果回传 AI 继续对话
    - CMS-APM-AUTO 记忆命中自动放行：记忆命中且非危险工具时自动放行，消息流产生可展开的痕迹条目（放行来源=记忆），与手动批准视觉可区分
    - CMS-APM-DANG 危险工具例外：对危险工具（任意 shell 执行等），即使存在同类记忆规则仍弹审批卡，且禁止被"允许并记住"
  - CMS-PLAN Plan 模式与 TODO
    - CMS-PLAN-RO 只读边界：Plan 规划中仅允许只读工具（读文件/搜索等），任何写类工具调用被拒绝
    - CMS-PLAN-CARD 计划卡片：AI 产出分步计划以卡片结构化呈现，用户可调整顺序/删减步骤后再批准
    - CMS-PLAN-APRV 批准执行：用户批准计划后按步骤自动执行，TODO 实时勾选
    - CMS-PLAN-ESC 执行中断：执行中按 Esc 立即停止当前与后续步骤，已完成步骤的改动保留且界限清晰，未执行步骤标记取消，可调整计划重新批准
    - CMS-PLAN-RLBK 按步骤回滚：用户按步骤/轮次粒度回滚改动，不影响其他轮次的 redo 链
    - CMS-PLAN-TODO TODO 进度卡片：执行中步骤实时勾选、失败项标注；压缩后卡片与计划本体仍可见
  - CMS-CTRL 流式控制
    - CMS-CTRL-STRM 增量流式渲染：流式回复按 delta 仅增量更新受影响 DOM 块，2000+ token 长回复滚动无可感知卡顿、无整块重绘闪烁
    - CMS-CTRL-ESC 中断流式：流式中按 Esc 立即中断，已生成内容保留，可重试或继续追问
    - CMS-CTRL-QUEU FollowUp 队列：流式进行中发送的消息排队，本轮结束后依序发送
    - CMS-CTRL-NETW 网络异常恢复：网络断续时同一请求自动重试上限 3 次，失败后内容保留并提示手动重发，队列消息不重复发送
  - CMS-FLOW 入口
    - F-DEVLP 聊天协作修 bug 全循环
      - {##CIN-SEND-MSG}：描述问题发送消息
      - {##CMS-APM-ALOW}：AI 发起工具调用改文件，审批放行后改动进 diff + checkpoint
      - {##CMS-CODE-APPL}：审阅回复代码块并 Apply 落地，可一步撤销
      - {##TSK-TERM-READ}：让 AI 读取集成终端测试输出验证改动
      - {##SCM-CGEN-GENR}：基于当前 diff 生成 commit message 填入 SCM
    - F-APPMEM 工具审批与记忆闭环
      - {##CMS-APM-CARD}：工具首次被调用时弹出审批卡
      - {##CMS-APM-RMBR}：允许并记住（本会话/全局两档）
      - {##CMS-APM-AUTO}：后续同类调用记忆命中自动放行并留痕
      - {##STG-APM-RVOK}：设置页撤销规则后立即生效，下一次同类调用重新弹审批
    - F-COMPAC 上下文压缩闭环
      - {##CIN-CMP-PROM}：用量超阈值出现提示条并说明保留范围
      - {##CIN-CMP-EXEC}：确认后走 Pi 原生压缩，计划/TODO 保活
      - {##CIN-CMP-DEFR}：拒绝后同一阈值区间不再重复提示
    - F-PLANEX Plan 模式大改动
      - {##CIN-MODE-SWTC}：切换到 Plan 模式（只读规划）
      - {##CMS-PLAN-CARD}：AI 产出分步计划，用户调整后批准
      - {##CMS-PLAN-APRV}：批准后自动执行，TODO 实时勾选
      - {##CMS-PLAN-ESC}：Esc 随时中断，已完成步骤保留
      - {##CMS-PLAN-RLBK}：按步骤/轮次粒度回滚，已完成步骤可查变更清单

- EDT 编辑器内交互 [编辑器内浮层 / 编辑器右键菜单]
  - EDT-ICH 真 Inline Chat
    - EDT-ICH-OPEN 呼出行内输入：用户在编辑器选中代码后按快捷键呼出行内输入框，指令自动携带选区上下文
    - EDT-ICH-DIFF 行内 diff 预览：生成结果以行内 diff 呈现（未落盘），diff 过大时可折叠/跳转，不阻塞编辑器导航
    - EDT-ICH-APPD 追加指令：用户在行内输入框继续追加指令，基于前次结果多轮修改
    - EDT-ICH-ACPT 接受改动：用户点击"接受"，文件更新并纳入本 Tab 的 diff/checkpoint 体系（可回滚）
    - EDT-ICH-ABRT 放弃改动：用户点击"放弃"，文件保持原状不落盘；多轮追加修改后一次放弃回到最初状态
    - EDT-ICH-HAND 未保存手改冲突：文件存在未保存手改时，接受前先提示冲突，不静默混合
    - EDT-ICH-GCHG 生成期间冲突：生成中用户又编辑同一文件时，基于旧快照的结果在应用前提示"文件已变化"，由用户决定
  - EDT-RBTN 选区右键菜单
    - EDT-RBTN-SEND 发送到 Pi：用户右键"发送到 Pi"，选区代码 + 文件路径 + 行号发送到当前 Tab（无 Tab 时新建）
  - EDT-FLOW 入口
    - F-INLCHT 编辑器内局部重构
      - {##EDT-ICH-OPEN}：选中代码呼出行内输入
      - {##EDT-ICH-DIFF}：输入/追加指令后行内 diff 预览
      - {##EDT-ICH-ACPT}：接受落盘并纳入 checkpoint（或放弃不落盘）

- STG 设置页 [VS Code 扩展设置页]
  - STG-APM 审批记忆管理
    - STG-APM-LIST 查看规则列表：用户打开设置页，展示全部审批记忆规则（工具名、范围、创建时间）
    - STG-APM-RVOK 撤销规则：用户撤销某条规则，立即对所有 Tab 生效，下一次同类调用重新弹审批
    - STG-APM-CLR 一键清空：用户一键清空全部规则，清空立即生效
    - STG-APM-EXPT 导出私有数据：用户一键导出审批记忆/checkpoint 等扩展私有数据
    - STG-APM-INFO 数据边界说明：页面标注审批记忆/checkpoint 等私有数据存于扩展自有存储、不写入 `~/.pi/agent`，终端 pi 不受影响
  - STG-PREF 界面偏好
    - STG-PREF-LANG 语言切换：用户在中/英间切换，即时生效，全部文案（含动态拼接与变量替换）经文案集中层统一出口
    - STG-PREF-DMOD 默认模型：用户设置 VS Code 侧默认模型，显式标注归属、与 Pi 侧偏好不一致时可解释，永不回写 Pi 配置

- SCM SCM 集成 [源代码管理视图（SCM 输入框旁）]
  - SCM-CGEN commit message 生成
    - SCM-CGEN-GENR 生成 commit message：用户点击 SCM 输入框旁生成按钮，基于当前暂存/未暂存 diff 生成 message 填入输入框，只填入不自动提交
    - SCM-CGEN-RGEN 重新生成：用户再次点击生成，重新产出文案，可编辑后自行提交
  - SCM-FLOW 入口
    - F-SCMGIT 提交信息生成流
      - {##SCM-CGEN-GENR}：基于当前 diff 生成并填入 SCM 输入框
      - {##SCM-CGEN-RGEN}：用户编辑或重新生成后自行提交（始终不自动提交）

- TSK 终端与后台任务 [集成终端 / 后台任务面板]
  - TSK-TERM 终端集成
    - TSK-TERM-READ 终端输出引用：AI 可读取/引用集成终端输出作为对话上下文
    - TSK-TERM-PAST 终端内容入对话：用户复制终端内容粘贴进对话
  - TSK-BTSK 后台任务面板
    - TSK-BTSK-LIST 查看任务列表：用户打开后台任务面板，子代理/后台任务列表展示状态（运行中/完成/失败）
    - TSK-BTSK-CANC 取消任务：用户取消某个后台任务，任务停止
    - TSK-BTSK-STAT Tab 状态外显：每个 Tab 标题常驻状态图标（流式中/Plan 执行中/失败暂停）
    - TSK-BTSK-NOTI 后台失败通知：后台 Tab 失败时向用户发送通知
  - TSK-SGL 会话单写者
    - TSK-SGL-TAKE 单写者接管：同一会话被第二个窗口加载时提示"已在其他窗口打开"，强制只读或接管二选一

- GLO 全局界面底座（横切） [全部 UI + 扩展图标]
  - GLO-UIUX 界面与图标改版
    - GLO-UIUX-RLAY 界面整体重设计：聊天 Webview 整体视觉与布局重设计、布局可重排，承载全部新交互
    - GLO-UIUX-ICON 新图标资产：扩展与界面启用新图标，含 Marketplace 发布资产
    - GLO-UIUX-THEM 主题自适应：全部界面深浅色跟随 CSS 变量，主题 × 语言四组合无破版
    - GLO-UIUX-KBRD 键盘可达：发送、审批（通过/拒绝）、接受/放弃 diff、切 Tab、切模型、会话切换、聚焦输入框全部提供快捷键并有键位提示，可在 VS Code 键位设置自定义
  - GLO-LOC 界面多语言
    - GLO-LOC-DUAL 中英文案全覆盖：全部界面文案中/英覆盖（含动态拼接与变量替换），全部文案经文案集中层唯一出口，中文环境无英文残留

## 附录：PRD 5.1 节 17 项范围覆盖对照

| PRD # | 范围项 | 功能树节点 |
|-------|--------|-----------|
| 1 | Pi 配置零配置接入 | `SB-CFG-*`（6 项）、`SB-MSEL-*`、`SB-SESS-*` |
| 2 | 图片输入 | `CIN-IMG-*`（4 项） |
| 3 | 代码块语法高亮 + Apply | `CMS-CODE-*`（3 项） |
| 4 | 流式渲染性能优化 | `CMS-CTRL-STRM` |
| 5 | 工具审批按工具名记忆 | `CMS-APM-*`（6 项）+ `STG-APM-*`（5 项） |
| 6 | 阈值询问式自动压缩 | `CIN-CMP-*`（5 项） |
| 7 | 选区右键菜单 | `EDT-RBTN-SEND` |
| 8 | @-mention | `CIN-MENT-*`（3 项） |
| 9 | 拖拽文件进对话 | `CIN-DRAG-FILE`、`CIN-IMG-DRAG` |
| 10 | 真 Inline Chat | `EDT-ICH-*`（7 项） |
| 11 | Plan 模式 | `CIN-MODE-SWTC` + `CMS-PLAN-*`（6 项） |
| 12 | TODO 任务进度卡片 | `CMS-PLAN-TODO` |
| 13 | 终端集成 | `TSK-TERM-*`（2 项） |
| 14 | commit message 生成 | `SCM-CGEN-*`（2 项） |
| 15 | 子代理/后台任务面板 | `TSK-BTSK-*`（4 项） |
| 16 | 界面与图标整体重设计 | `GLO-UIUX-*`（4 项） |
| 17 | 界面多语言（中/英） | `GLO-LOC-DUAL` + `STG-PREF-LANG` |
