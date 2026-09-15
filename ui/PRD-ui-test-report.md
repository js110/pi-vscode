# pi-vscode UI 原型 QA 评审报告（Phase 3 · 第 2 次评审 / 修复后复评）

| 项 | 值 |
|----|-----|
| 评审性质 | **第 2 次评审（修复后复评）**——第 1 次评审 48/60 未通过，主 agent 完成 6 major + 7 minor 修复后复评 |
| 评审对象 | `ui/` 目录：PRD-ui.html（索引）+ 10 页面 + assets（tokens/shared.css/shared.js）+ icon（5 个 SVG） |
| 评审基准 | prd/PRD.md v1.4 —— §9.1-9.8、§11 异常与边界、§13.3 兼容性（主题×语言四组合）、AC-FN-29 |
| 评审方式 | 静态源码审读 + 脚本化检查：data-i18n 与 PI_PAGE 字典逐键双向核对、U+FFFD 乱码扫描、外部资源依赖、shared.css 写死色值、emoji/符号清单（node 扫描）、SVG 文件合法性、PRD 章节覆盖度、操作闭环归宿、跨页一致性 |
| 评审日期 | 2026-09-15 |
| 评审人 | 独立 QA（未参与设计与修复） |

---

## 一、总分表

| # | 维度 | 第 1 次 | 第 2 次 | 变化 |
|---|------|--------|--------|------|
| 1 | 覆盖度（PRD 功能界面 vs 原型） | 8 | **9 / 10** | +1（Steer/队列态、终端集成、接管、拖拽提示补齐） |
| 2 | 操作闭环 | 8 | **9 / 10** | +1（失败暂停三出路、队列恢复、接管动作齐备） |
| 3 | 表格/布局精度（结构合理性） | 9 | **9 / 10** | 持平（无回归） |
| 4 | 设计规范（VS Code 原生变量） | 8 | **10 / 10** | +2（shared.css 写死色值清零，100% token 驱动） |
| 5 | 交互完整性（弹层/状态变体） | 8 | **9 / 10** | +1（remember-menu、长代码折叠、i18n-val 接入） |
| 6 | 视觉一致性（跨页统一 / i18n / 乱码） | 7 | **9 / 10** | +2（emoji 清零、标题统一 Pi、proto-note 全接 i18n） |
| — | **综合** | **48 / 60** | **55 / 60（91.7%）** | **+7** |

**结论：通过（门槛 ≥54 且无单项 ≤4；本次 55/60，无单项 ≤4）。**

> 剩余问题 0 critical / 0 major / 8 minor（全部为打磨项，不阻塞进入下一阶段）。

---

## 二、第 1 轮问题逐条核验（修复确认）

### Major（6/6 全部修复）

| # | 第 1 轮问题 | 核验结果 | 证据（文件:行） |
|---|------------|---------|----------------|
| ① | 页 02 remember-menu 未默认隐藏，页面加载即露出浮层 | **已修复** | ui_chat_main_normal.html:180 `hidden` 属性 + shared.css:284 `.remember-menu[hidden]{display:none}` + JS 点击切换/外点收起（:406-415） |
| ② | 页 06 执行中泳道 TODO 步骤 2 重复、步骤 4 缺失 | **已修复** | ui_plan_mode.html:116-119 四步骤唯一（1 done / 2 done / 3 running / 4 pending），进度 2/4 与三处泳道一致 |
| ③ | 页 06 plan-step input 未接 i18n（value 硬编码中文） | **已修复** | ui_plan_mode.html:76-79 `data-i18n-val="p2.step1..4"`；zh/en 字典均含键；shared.js:41-44 支持 `-val` 通道 |
| ④ | 页 02 缺 Steer 显式入口，send-btn 队列变体无页面使用 | **已修复** | ui_chat_main_normal.html:297 Steer 按钮（含双语 title）；:298 `send-btn queue` 变体 + aria 说明；:277-280 流式入队提示条；shared.css:425 队列态配色（次级按钮色，与主发送视觉区分） |
| ⑤ | 单写者占用行缺"接管/恢复可写"动作呈现 | **已修复** | ui_sessions_skills.html:88 占用行内"接管"按钮（双语 title 语义完整）；:90 注明"占用解除后可一键『恢复可写』"，符合 9.8 呈现层要求 |
| ⑥ | 终端集成（9.8 / AC-FN-23）11 页中无界面 | **已修复** | ui_misc_panels.html:234-254 新增 E 区：终端 mock（会话就绪 · Turn 12 · 54K tokens）、"引用终端选区 → Pi"、"在集成终端中打开 pi"、同源同 token 口径与单写者互斥说明 |

### Minor（7/7 全部修复）

| # | 第 1 轮问题 | 核验结果 | 证据 |
|---|------------|---------|------|
| m1 | shared.css 写死色值 | **已修复（清零）** | 脚本扫描 `#[0-9a-fA-F]{3,8}` 于 shared.css 命中 0；全部引用 `--vscode-*` / `--proto-*`（图标展示页固定底色为豁免项：白/深底是测试背景本身） |
| m2 | 跨页图标风格混用（emoji vs SVG）、页 04 标题 "PI ASSISTANT" vs "Pi" | **已修复** | node emoji 扫描：10 个产品页面 0 个彩色 emoji（shared.js 工具条 🌗/🌐 为原型演示 chrome，非产品界面）；图标统一 SVG + 单色文本符号；页 02/03/04/08 标题统一 "Pi" |
| m3 | 页 04 统计缺技能数、缺费率未知态 | **已修复** | ui_model_selector.html:117 "已从 Pi 读取 3 provider / 12 模型 / 5 技能"（对齐 AC-FN-01 三元口径）；:160-167 Local 组 ollama 行"费率未知"（对齐 11.1：不显示 0） |
| m4 | 拖拽提示与长代码折叠未演示 | **已修复** | ui_chat_main_normal.html:273 拖拽转引用提示（drop-hint）；:145/149 collapsible 代码块 + "展开全部（+5 行）/收起" 双态 JS 切换（:416-425，且切换文案随当前语言取字典） |
| m5 | 六页 proto-note 未接 i18n | **已修复** | 11/11 页 proto-note 均有 `data-i18n`，逐页核对 zh/en 字典键齐全（脚本双向核对通过） |
| m6 | Ctrl+Shift+P 快捷键误导（那是命令面板） | **已修复** | ui_inline_chat_editor.html:182 `Alt+P` |
| m7 | 页 10 任务行标题 ✓✗ 与状态列重复 | **已修复** | ui_misc_panels.html:146/152/158 标题纯文本，✓/✗ 仅存在于状态列 |

---

## 三、各维度得分依据（第 2 次）

### 1. 覆盖度 —— 9/10
- §9.1-9.8 全部建立页面映射（同第 1 轮已确认部分不再展开）。本轮新增补齐：Steer/队列发送态（9.2/M06）、终端集成（9.8/AC-FN-23）、接管与恢复可写（9.8）、拖拽转引用提示（9.2/AC-FN-21）、长代码折叠（9.3）、费率未知（11.1）、K 技能统计（AC-FN-01）。
- AC-FN-29 图标资产齐备：5 个 SVG 均为合法完整文件（脚本校验通过），3 彩色提案 + currentColor 单色 + 36×36 灰阶 + 规格表与推荐结论。
- 剩余弱覆盖（扣 1 分）：@-mention 补全浮层未以展开态演示（仅有入口按钮与结果 chips）；11.4"上下文已满，无法继续发送"与 AC-FN-26"压缩失败"两个末端异常态未呈现（压缩提示条主流程已覆盖）。

### 2. 操作闭环 —— 9/10
- 逐状态核对出口动作：错误态→重新检测（含"无需重启/草稿保留"归宿说明）；审批卡→允许一次/记住（会话·全局二级菜单）/拒绝→痕迹条→设置页撤销即生效；失败暂停→续跑/调整/放弃三出路（对齐 6.3 状态机）；已中断→按步骤回滚/调整重批/继续对话；生成中断→重试/查看 pending diff/丢弃；写冲突→仍要写入/取消；Apply→确认/取消/一步撤销注记；队列→逐条发送/一键清空/移除单条 + 关闭确认说明；占用→接管。
- 扣 1 分：页 02 "@ 引用" 按钮的补全浮层无对应目标演示（技能菜单 `/`、模型选择器、设置页均有归宿，唯 @ 弹层缺）。

### 3. 表格/布局精度 —— 9/10
- 本设计体系为 VS Code 原生 HTML（非 1112px 定宽表格体系），按结构合理性评审：面板 480px 定宽一致；页 04 浮层 450px 收于 460px 内容区无溢出；页 05 双面板 + 页 06 五泳道均有 overflow-x 兜底；页 07 diff 行与普通行同几何（负 margin 全宽出血）、行内组件 760px 收敛；icon 展示 spec-table 边框合并、对齐正常。无破版风险点。

### 4. 设计规范 —— 10/10
- 脚本验证 shared.css 写死色值 0 处；tokens.css 完整提供 Dark/Light Modern 双套 VS Code 变量 + 语义补充层（diff/warn/info/error/mask 等），组件层零越界。页面级补充样式均只做布局（宽度/间距），颜色一律引用变量（含页 04 tab 状态的 inline `var(--vscode-testing-iconPassed)`）。图标展示页的 #ffffff/#181818 为豁免项（图标测试背景本身）。

### 5. 交互完整性 —— 9/10
- 三处 JS 交互实现且正确：remember-menu 开合（stopPropagation + 外点收起）、代码块折叠（文案随语言取字典）、shared.js 工具条（主题 + 语言）。`data-i18n` / `-ph` / `-val` 三通道齐备，页 04 浮层、页 05 双面板、页 06 计划卡 input、页 07 行内输入 value 均接入。按钮均有 title/aria 或说明条交代去向。
- 扣 1 分：同操作闭环（@ 补全浮层）；另页 02 展开态下切换语言时折叠按钮文案会短暂回到"展开"键位（data-i18n 属性仍指向 cb.expand），属演示脚本边角，不影响验收。

### 6. 视觉一致性 —— 9/10
- 面板骨架（Header → Tab 条 → 消息流 → 输入区 → Footer）11 页统一；符号体系统一为单色文本符号（⚠×11、✕ 关闭、−/+ diff、①-⑤ 泳道序号）；Tab 状态四态图标（spinner/紫/橙/红）跨页一致；"Pi" 标题统一；proto-note 与工具条全页一致。
- 扣 1 分：两处同义符号分裂——信息提示 ⓘ(U+24D8, 4 处) vs ℹ(U+2139, 3 处)；失败标记 ⨯(U+2A2F, 页 07) vs ✗(U+2717, 页 10)。见问题清单 N4/N5。

---

## 四、脚本化检查结果汇总

| 检查项 | 结果 |
|--------|------|
| data-i18n ↔ PI_PAGE zh/en 双向核对 | 10/11 页全通过；页 04 存在 1 处键名错位（见 N1） |
| U+FFFD 乱码 | 0 处（全部 html/css/js/svg） |
| 外部资源依赖（http/https 引用） | 0 处（可完全离线打开；earendil 字样仅为代码 mock 文本） |
| shared.css 写死色值 | 0 处 |
| 产品页彩色 emoji | 0 处（shared.js 工具条 🌗/🌐 为原型演示 chrome，豁免） |
| icon/*.svg 合法性 | 5/5 完整闭合、含尺寸声明 |
| 共享资产接入 | 11/11 页引入 tokens.css + shared.css + shared.js |

---

## 五、问题清单（本轮剩余，均为 Minor）

| # | 优先级 | 问题描述 | 位置 | 建议修复方案 |
|---|--------|---------|------|------------|
| N1 | minor | i18n 键错位：DOM 使用 `panel.title`，字典定义 `panelTitle`，键永不相等（因两语言值同为 "Pi" 暂无视觉影响，但属死键、后续改标题即暴露） | ui_model_selector.html:50（DOM）vs :198/:225（字典） | 将字典键 `panelTitle` 更名为 `panel.title`（zh/en 两处） |
| N2 | minor | 页 04 用户头像 "你" 未接 i18n；EN 模式下头像残留中文（页 02 同位置已双接 `data-i18n="user.name"`，页内不一致） | ui_model_selector.html:72 | 头像 span 补 `data-i18n="youL"` |
| N3 | minor | 42 处 `title` 工具提示含中文且不可切换（shared.js 仅支持 textContent/placeholder/value 三通道）；EN 模式下提示语残留中文 | 全部页面 title 属性 | 实现期在文案集中层补 `data-i18n-title` 通道；原型阶段可注明已知限制 |
| N4 | minor | 信息提示符号分裂：ⓘ（4 处）vs ℹ（3 处） | ui_plan_mode.html:43,216；ui_inline_chat_editor.html:191 | 统一为 ⓘ |
| N5 | minor | 失败/错误标记分裂：⨯（页 07 生成中断）vs ✗（页 10 任务失败） | ui_inline_chat_editor.html:159；ui_misc_panels.html:157 | 统一为 ✗（与 ✓/✗ 状态对齐） |
| N6 | minor | 页 02 流式叙事下 Tab 条无流式中 spinner（active Tab 无状态图标，与页脚"正在流式生成"提示不同步；页 06① 已演示 spinner 形态） | ui_chat_main_normal.html:83-86 | active Tab 补 `<span class="tab-status"><span class="tab-spinner"></span></span>` |
| N7 | minor | @-mention 补全浮层未以展开态演示（入口与结果 chips 已有，弹层形态缺失，@ 按钮暂无目标归宿） | ui_chat_main_normal.html:288 | 增补一个展开态浮层（文件+符号两组、含"无符号索引降级仅文件"提示，对齐 9.2/AC-FN-09） |
| N8 | minor | 11.4"上下文已满，无法继续发送"与 AC-FN-26"压缩失败，已保留完整上下文"两个末端异常态未呈现（shared.css 已备 `.ctx-pct.danger`/error 提示条形态） | ui_chat_main_normal.html（压缩条区） | 可在压缩提示条旁补一条 error 变体示例，或在报告中注明实现期覆盖 |

---

## 六、通过判定

| 规则 | 结果 |
|------|------|
| 综合评分 ≥ 54/60（90%） | 55/60（91.7%）✅ |
| 无单项 ≤ 4 分 | 最低单项 9 分 ✅ |
| critical = 0 | ✅ |
| major = 0 | ✅ |

**判定：通过。建议放行进入下一阶段；N1-N8 作为打磨清单随实现带入（不阻塞）。**

---

## 七、N1–N8 打磨修复记录（第 2 次评审后 · 2026-09-15）

| # | 修复结果 | 证据 |
|---|---------|------|
| N1 | **核实为已达标**：当前源码字典键即为 `panel.title`（zh/en 各一处），DOM 与字典一致；复评引用的 `panelTitle` 系旧版行号，无需修改 | ui_model_selector.html（PI_PAGE zh/en） |
| N2 | 已修复：页 04 用户头像补 `data-i18n="youL"`，EN 模式头像随语言切换 | ui_model_selector.html:72 |
| N3 | 已修复（文案集中层方案）：shared.js 新增 `PI_TIPS` 集中词典（40 组唯一中文 title + 新增 1 组 = 41 组 → EN），`applyLang` 全量切换 `[title]`，未收录保持原文；避免 10 页 × 字典散改 | assets/shared.js（PI_TIPS + applyTips） |
| N4 | 已修复：3 处 ℹ(U+2139) 统一为 ⓘ(U+24D8)，信息提示符号单一化 | ui_plan_mode.html:43/216 · ui_inline_chat_editor.html:191 |
| N5 | 已修复：⨯(U+2A2F) 统一为 ✗(U+2717)，与 ✓/✗ 状态体系对齐 | ui_inline_chat_editor.html:159 |
| N6 | 已修复：页 02 active Tab 补流式 spinner（与页 06① 同形制），title「正在流式生成」入 PI_TIPS | ui_chat_main_normal.html（tab-strip active） |
| N7 | 已修复：页 02 新增 @-mention 补全浮层（点击 @ 展开 / 外点收起）：文件组 3 行（含"本会话已引用"选中态）+ 符号组 2 行 + 「无符号索引降级仅文件」提示（9.2 / AC-FN-09），@ 按钮获得操作归宿 | ui_chat_main_normal.html（#mention-popover + JS） |
| N8 | 已修复：页 02 压缩提示条旁补两条 error 变体——「压缩失败，已保留完整上下文」（重试压缩/继续对话，AC-FN-26）与「上下文已满（100%），无法继续发送」（压缩后继续/新建 Tab，11.4） | ui_chat_main_normal.html（nb.fail.* / nb.full.*） |

修复后脚本化自检（.cache/check-ui-polish.js）：11 页 data-i18n ↔ PI_PAGE 双向核对通过 · U+FFFD 0 · ℹ/⨯ 残留 0 · 中文 title 全部入 PI_TIPS · shared.css 写死色值 0；headless Edge 渲染后 DOM 确认 spinner / mention-popover（默认 hidden）/ 两条 error 变体与工具条注入齐全。

---

*评审提示词版本：v2.0 · 第 2 次评审（修复后复评） · 2026-09-15*
