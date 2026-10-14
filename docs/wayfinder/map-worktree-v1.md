# Wayfinder Map: Worktree 并行 Agent v1 落地

labels: wayfinder:map
status: open

## Destination

Worktree 并行 Agent 工作流 v1 在 pi-vscode 落地：全部产品决策锁定、实现合入 main、`npm run check` 全绿、F5 冒烟通过（创建/隔离/清理全链路）。地图含执行票（task），覆盖 wayfinder 默认的"只规划不执行"。

## Notes

- 工作语言中文；决策票（grilling）一次一问，答案记在票的 resolution comment 后关闭。
- 追踪器：本仓库无外部 tracker，用 local-markdown tracker——本文件为地图，`tickets/T*.md` 为子票；frontmatter 记 `status / type / assignee / blocked-by`；票被 `blocked-by` 中所有票关闭后进入 frontier。
- 无子代理可用：research 类票由会话内直接解决。
- 背景资产：Copilot 与 Kilo 源码调研、v1 PRD 均在 2026-10-14 会话中完成（PRD 四个决策点对应 T01–T04）。
- 冻结的探索代码：`src/utils/git-worktree.ts` + `src/test/unit/utils/git-worktree.test.ts`（已写未提交，处置由 T04 裁决；已知问题：路径拼接未用 `path.join`，Windows 不兼容）。
- Skills：决策票用 grilling；冒烟问题用 diagnose。
- SDK 事实（建图时已核查）：SessionManager 每实例绑定 cwd，无单例约束，多实例为设计内行为（`dist/core/session-manager.d.ts`）。

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [T01 命名约定](tickets/T01-naming-convention.md) — 定稿 `.pi/worktrees/<slug>` + `pi/<slug>`，v1 硬编码，冲突加 8 位随机后缀
- [T02 清理策略](tickets/T02-cleanup-policy.md) — 定稿 Copilot 式：关 tab 即 auto-commit → 删 worktree → 留分支；cleanWorktrees 命令保留作孤儿清扫；会话存全局删 worktree 不丢历史
- [T03 关 tab 清理语义](tickets/T03-completion-semantics.md) — 流式关闭 = abort 后清理；提交信息 AI 生成（CommitMessageManager）+ 失败回退 `pi: <任务名>`；链路异步、完成通知带分支名
- [T04 探索代码处置](tickets/T04-exploration-code-disposition.md) — 冻结稿修正后沿用（path.join、porcelain 规范化、清 void stat、过 check），T08 以其为底不重写
- [T05 审阅流](tickets/T05-review-merge-ux.md) — 最小审阅：Changed Files 快照 diff 即 vs 基线（零新代码）+ Open Folder + README 合并指引；不做显式基线对比/merge 按钮
- [T06 会话可见性](tickets/T06-session-visibility-restore.md) — v1 接受：对话随关 tab 封存于全局（同名 slug 重建可找回），成果在分支；不做会话树多 cwd 列出

## Not yet specified

- F5 冒烟若暴露多 SessionManager 并行流问题（事件串扰/性能/锁），降级或回滚策略——形状未知，冒烟后浮现，可能毕业为新票。

## Out of scope

（PRD 非目标，已在 PRD 定稿时排除；不随地图推进毕业）
- auto-commit on complete（Copilot 式**每轮请求完成**即自动提交；关 tab 时的一次性 auto-commit 已凭 T02 入域）
- checkpoint git ref 链、PR 创建与状态跟踪
- worktree 池预热、LFS、husky 容错（Kilo 式深度工程）
- base branch 的 upstream 自动解析
- worktree tab 跨 VS Code 重启恢复
- 会话树多 cwd 列出（T06 升级路径 b，v1 接受限制）
- 竞品移植的其它功能（终端集成、通知升级、对话搜索等）——将来另开地图
