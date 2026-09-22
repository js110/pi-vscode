/**
 * Centralized i18n layer (PRD C12 / T1): the single exit point for all
 * webview-facing copy. The English dictionary defines the key set; the
 * Chinese dictionary is compile-checked against it, so a missing or extra
 * translation is a type error. Language is pushed from the extension host
 * via the `langChanged` message (resolved from the `pi-agent.displayLanguage`
 * setting, defaulting to the VS Code UI language) — it never round-trips
 * into ~/.pi/agent.
 */

import type { Lang } from './protocol';

export type { Lang };

const EN = {
    // Welcome
    'welcome.title': 'Pi Agent',
    'welcome.headline': 'Chat with Pi about your codebase',
    'welcome.subtitle': 'Pi reads, writes, and runs code in this workspace. Tell it what to build and it will show its work as it goes.',
    'welcome.hint': 'Type <kbd>/</kbd> for commands and skills',
    'welcome.hintShort': '<kbd>/</kbd> skills&nbsp;&nbsp;<kbd>@</kbd> mention&nbsp;&nbsp;<kbd>Ctrl</kbd>+<kbd>L</kbd> focus',
    'welcome.sug1.title': 'Debug an error',
    'welcome.sug1.desc': 'Paste an error or stack trace and I’ll root-cause it',
    'welcome.sug1.prompt': 'Debug this error — here is the message and where it appears:',
    'welcome.sug2.title': 'Review changes',
    'welcome.sug2.desc': 'Review the uncommitted workspace changes file-by-file',
    'welcome.sug2.prompt': 'Review my uncommitted changes',
    'welcome.sug3.title': 'Refactor code',
    'welcome.sug3.desc': 'Split or extract a module, show before/after',
    'welcome.sug3.prompt': 'Refactor the code in',
    'welcome.sug4.title': 'Explain selection',
    'welcome.sug4.desc': 'Select a piece of code and walk through it line by line',
    'welcome.sug4.prompt': 'Explain the selected code',

    // Header / tabs
    'header.ready': 'Ready',
    'header.readyTitle': 'Pi config detected — {providers} provider(s), {models} model(s)',
    'header.newAgent': 'New Agent',
    'header.sessions': 'Sessions',
    'header.settings': 'Settings',
    'header.closeTab': 'Close tab',
    'header.renameSession': 'Rename session',
    'header.scrollToBottom': 'Scroll to bottom',

    // Turn chrome (rail π markers)
    'msg.pi': 'Pi',
    'msg.me': 'Me',
    'msg.turn': 'Turn {n}',

    // Composer
    'input.ask': 'Ask Pi anything... (type / for commands)',
    'input.queue': 'Queue a message...',
    'input.send': 'Send',
    'input.queueSend': 'Queue',
    'input.stop': 'Stop',
    'input.steer': 'Steer',
    'input.contextTooltip': 'Context: {tokens} / {window} tokens ({percent}%)',
    'input.contextWindowTooltip': 'Context window: {window} tokens',

    // Streaming / placeholders
    'stream.preparing': 'Preparing next moves...',
    'stream.retrying': 'Retrying ({attempt}/{max}) after error: {error}',
    'stream.thinking': 'Thinking...',
    'stream.thought': 'Thought',
    'stream.thoughtForOne': 'Thought for {n} second',
    'stream.thoughtForMany': 'Thought for {n} seconds',
    'stream.steering': 'Steering...',

    // Queued messages
    'queue.count': '{n} queued',
    'queue.edit': 'Edit',
    'queue.remove': 'Remove',
    'queue.save': 'Save',
    'queue.cancel': 'Cancel',

    // Changed files
    'files.countOne': '{n} file',
    'files.countMany': '{n} files',
    'files.undo': 'Undo',
    'files.redo': 'Redo',
    'files.review': 'Review',
    'files.undoTitle': 'Undo last change',
    'files.redoTitle': 'Redo changes',
    'files.reviewTitle': 'Review all changes',
    'files.undoConfirm': 'Undo changes from the last turn?',
    'files.redoConfirm': 'Re-apply the rolled-back changes?',

    // Checkpoints
    'checkpoint.restore': 'Restore to this checkpoint',
    'checkpoint.restored': 'Restored {n} file(s) to checkpoint.',
    'checkpoint.discardConfirm': 'Discard all changes after this checkpoint?',

    // Tools
    'tool.result': 'Tool Result',
    'tool.noOutput': '(no output)',
    'tool.running': 'running',
    'tool.done': 'done',
    'tool.error': 'error',
    'tool.pending': 'pending',
    'tool.bashFallback': 'Execute command',
    'tool.readFallback': 'Read file',
    'tool.writeFallback': 'Write file',
    'tool.editFallback': 'Edit file',
    'tool.globFallback': 'Find files',
    'tool.grepFallback': 'Search files',
    'tool.read': 'Read {path}',
    'tool.write': 'Write {path}',
    'tool.edit': 'Edit {path}',
    'tool.glob': 'Glob {pattern}',
    'tool.grep': 'Grep {pattern}',

    // Tool footer meta
    'meta.tokensIn': '{n} in',
    'meta.tokensOut': '{n} out',
    'meta.inputTokens': '{n} input tokens',
    'meta.outputTokens': '{n} output tokens',

    // Approval
    'approval.awaiting': 'awaiting approval',
    'approval.approve': 'Approve',
    'approval.reject': 'Reject',
    'approval.remember': 'Remember ▾',
    'approval.rememberSession': 'This session only',
    'approval.rememberGlobal': 'All tabs (global)',
    'approval.memorySession': 'memory · session',
    'approval.memoryGlobal': 'memory · all tabs',

    // Config banner
    'config.notFound': 'Pi config not found at {dir} — install Pi or check the agent directory.',
    'config.stats': 'Read from Pi: {providers} · {models} · {skills}',
    'config.issue': 'Config issue ({source}): {message}',
    'config.issueFallback': 'Some Pi config sources could not be read.',
    'config.recheck': 'Re-check',
    'config.providerCountOne': '{n} provider',
    'config.providerCountMany': '{n} providers',
    'config.modelCountOne': '{n} model',
    'config.modelCountMany': '{n} models',
    'config.skillCountOne': '{n} skill',
    'config.skillCountMany': '{n} skills',
    'config.notFoundShort': 'No config',
    'config.partialShort': 'Partial',
    'config.discovering': 'Discovering config…',

    // Model picker
    'models.search': 'Search models...',
    'models.recent': 'Recent',
    'models.all': 'All Models',
    'models.thinking': 'Thinking:',
    'models.selectPlaceholder': 'Select a model',
    'models.noneAvailable': 'No models available. Check your Pi configuration.',

    // Sessions panel
    'sessions.title': 'Sessions',
    'sessions.empty': 'No previous sessions',
    'sessions.noMatch': 'No matching sessions',
    'sessions.search': 'Search sessions...',
    'sessions.close': 'Close',

    // Code block
    'code.copy': 'Copy',
    'code.copied': 'Copied!',
    'code.apply': 'Apply',
    'code.showMore': 'Show more',
    'code.showLess': 'Show less',

    // Apply preview card + host-side apply flow messages
    'apply.title': 'Apply to {path}',
    'apply.newFileBadge': 'New file',
    'apply.confirm': 'Write',
    'apply.cancel': 'Cancel',
    'apply.applied': 'Applied to {path}.',
    'apply.created': 'Created {path}.',
    'apply.conflict': 'File was modified externally. Please preview again.',
    'apply.expired': 'Preview expired. Please apply again.',
    'apply.exists': 'File already exists. Please preview again.',
    'apply.deleted': 'File was deleted since preview. Please preview again.',
    'apply.dirty': 'File has unsaved editor changes. Save it and preview again.',
    'apply.cancelled': 'Preview cancelled.',
    'apply.writeError': 'Failed to write file: {message}',
    'apply.noWorkspace': 'Open a workspace folder to apply code.',
    'apply.pickTarget': 'Choose a target file for this code block',

    // Compaction prompt flow
    'compact.bannerTitle': 'Context is {n}% full',
    'compact.bannerHint': 'Compaction summarizes earlier history and keeps queued messages.',
    'compact.accept': 'Compact now',
    'compact.dismiss': 'Not now',
    'compact.compacting': 'Compacting context…',
    'compact.failed': 'Compaction failed — context kept. You can retry with /compact.',
    'compact.nothingToCompact': 'Nothing to compact yet — the session is too small or was recently compacted, so recent history stays as-is.',
    'compact.done': 'Context compacted.',

    // Built-in slash commands
    'slash.unsupported': '"/{name}" is not available in the Pi panel yet.',
    'slash.blockedStreaming': '"/{name}" cannot run while a turn is in progress — wait for it to finish.',
    'slash.nameUsage': 'Usage: /name <new name>',
    'slash.copied': 'Last reply copied to the clipboard.',
    'slash.copyEmpty': 'No assistant reply to copy yet.',
    'slash.loginHint': 'Configure a provider API key in the settings panel.',
    'slash.sessionInfo': 'Session: {name}\nModel: {model}\nContext: {usage}\nFile: {path}',

    // Image input
    'image.attach': 'Attach files',
    'image.unsupported': 'The current model does not support image input',
    'image.tooLarge': 'Image is too large (over 25 MB, or could not be compressed below 5 MB)',
    'image.resized': '"{name}" was compressed automatically to fit the size limit',
    'image.tooMany': 'Too many images (max {n})',
    'image.invalid': 'Unsupported image data',
    'image.queueUnsupported': 'Images cannot be added while the agent is streaming',
    'image.remove': 'Remove image',

    // File attachments (non-image, text)
    'attach.binaryUnsupported': 'Could not attach "{name}" — binary files can\'t be inlined. Drag it from the Explorer to @-mention its path instead.',
    'attach.tooLarge': '"{name}" is too large to attach (max 5 MB)',
    'attach.streamingUnsupported': 'Files cannot be attached while the agent is streaming',

    // Selection context chip (Copilot-style auto-attach)
    'selection.detach': "Don't attach the selection",

    // Send to Pi (editor context menu)
    'sendToPi.intro': 'Here is a code selection from `{path}:{range}`:',
    'sendToPi.noSelection': 'Select some code in the editor first.',
    'sendToPi.tooLarge': 'The selection is too large to send (max {n} characters).',

    // @-mention
    'mention.deleted': 'Referenced file no longer exists: {path}',
    'mention.noResults': 'No matching files or symbols',
    'mention.groupFiles': 'Files',
    'mention.groupSymbols': 'Symbols',
    'mention.dropInvalid': 'Some dropped files cannot be referenced (must be files inside the workspace).',

    // Commit message generation
    'commit.generatingPlaceholder': 'Generating commit message…',
    'commit.inProgress': 'A commit message is already being generated.',
    'commit.noGit': 'The Git extension is not available.',
    'commit.noRepository': 'No Git repository found in this workspace.',
    'commit.noChanges': 'There are no staged or unstaged changes to describe.',
    'commit.noModel': 'No model available. Check your Pi configuration.',
    'commit.failed': 'Commit message generation failed:',

    // Humanized error copy (T17): what happened + impact + suggested action.
    'err.auth': 'Pi could not authenticate with the model provider, so nothing was answered. Check your API key in the settings panel, or run Pi login again.',
    'err.network': 'Pi could not reach the model provider, so this turn did not complete. Check your network or proxy connection, then try again.',
    'err.rateLimit': 'The model provider is rate-limiting requests, so this turn stopped early. Wait a moment and try again; if it persists, check your account quota.',
    'err.config': 'Pi configuration is missing or unreadable, so the request could not start. Open the settings panel to review the provider and model.',
    'err.unknown': 'Pi hit an unexpected error and stopped this turn — your context is kept. Try again; if it repeats, check the Pi Agent output channel. Detail: {message}',

    // Host command toasts / prompts (T17 leftover copy)
    'command.thinkingChanged': 'Thinking level: {level}',
    'common.yes': 'Yes',
    'init.failed': 'Pi Agent failed to initialize: {message}',

    // Prompt-cache warming footer chip (SDK 0.86+)
    'warm.state.inactive': 'warm off',
    'warm.state.scheduled': 'will warm',
    'warm.state.refreshing': 'warming…',
    'warm.savings': '~{amount} saved per cache refresh',
    'warm.scheduledAt': 'next warm at {time}',

    // One-click bug-report summary (SDK 0.86+)
    'diagnostic.generating': 'Generating diagnostic summary…',
    'diagnostic.busy': 'Pi is still working on the last turn — wait for it to finish first.',
    'diagnostic.failed': 'Failed to generate diagnostic summary: {message}',
    'diagnostic.cancelled': 'Diagnostic summary cancelled.',
    'diagnostic.empty': 'Pi produced no summary content.',
    'diagnostic.noSession': 'No active Pi session.',
    'diagnostic.unsupported': 'The installed Pi SDK does not support diagnostic summaries.',

    // Status bar open-panel entry (the secondary-sidebar container has no activity-bar icon)
    'statusBar.openPanel': 'Open Pi Agent panel',
    'occupancy.occupied': 'This session is open in another VS Code window. It is read-only here.',
    'occupancy.released': 'The other window released this session. You can resume editing.',
    'occupancy.lostLock': 'This session was taken over by another window. It is read-only here.',
    'occupancy.takeover': 'Take over',
    'occupancy.resume': 'Resume editing',
    'occupancy.readOnlyBlocked': 'This session is read-only: it is open in another window. Take over to continue.',

    // Inline chat (C13)
    'inline.busy': 'Pi is still processing. Wait for the current turn to finish.',
    'inline.active': 'An inline edit round is already in progress.',
    'inline.promptTitle': 'Edit with Pi (inline)',
    'inline.inputPlaceholder': 'Describe the change… (Esc to cancel)',
    'inline.dirtySave': 'This file has unsaved changes. Save it before invoking the inline edit?',
    'inline.conflictNotice': 'Manual edits detected while Pi is editing this file — the inline preview may conflict.',
    'inline.discardConfirm': 'Discard all changes from this inline round?',
    'inline.discardConflictConfirm': 'You edited this file manually. Discarding will also revert those edits. Continue?',
    'inline.accepted': 'Inline changes kept.',
    'inline.discarded': 'Inline changes reverted.',
    'inline.statusAccept': 'Accept',
    'inline.statusDiscard': 'Discard',
    'inline.statusTitle': 'Review the inline edit: keep or revert every change of this round',

    // Diff card
    'diff.new': 'NEW',

    // Settings panel
    'settings.title': 'Pi Agent Settings',
    'settings.section.api': 'API Connection',
    'settings.provider': 'Provider',
    'settings.autoDetect': 'Auto-detect',
    'settings.providerDesc': 'Select which AI provider to use. Leave on Auto-detect for automatic resolution.',
    'settings.section.model': 'Default Model & Thinking',
    'settings.defaultModel': 'Default Model',
    'settings.defaultModelDesc': 'Model ID to use when starting new sessions (e.g. claude-sonnet-4-20250514). Leave empty for automatic.',
    'settings.thinkingLevel': 'Default Thinking Level',
    'settings.think.off': 'Off',
    'settings.think.minimal': 'Minimal',
    'settings.think.low': 'Low',
    'settings.think.medium': 'Medium',
    'settings.think.high': 'High',
    'settings.thinkingLevelDesc': "How verbose the agent's chain-of-thought should be by default.",
    'settings.section.tools': 'Tool Execution',
    'settings.autoApprove': 'Auto-approve tool calls',
    'settings.autoApproveDesc': 'When enabled, the agent executes tools without asking for confirmation. When disabled, each tool call shows an inline approval card.',
    'settings.allowedTools': 'Allowed Tools',
    'settings.allowedToolsDesc': 'Comma-separated list of tool names to allow (e.g. read, grep, bash). Leave empty to allow all.',
    'settings.allowedToolsPlaceholder': 'e.g. read, grep, bash',
    'settings.section.approval': 'Approval Memory',
    'settings.approvalLoading': 'Loading approval rules...',
    'settings.approvalDesc': 'Tools you chose to "Remember" from approval cards, allowed in every tab. Shell tools are never remembered. Changes take effect immediately.',
    'settings.approvalEmpty': 'No global approval rules yet.',
    'settings.approvalSince': 'since {date}',
    'settings.revoke': 'Revoke',
    'settings.clearAll': 'Clear all ({n})',
    'settings.section.session': 'Session Behavior',
    'settings.autoSave': 'Auto-save sessions',
    'settings.autoSaveDesc': 'Automatically persist sessions after each turn.',
    'settings.sessionPath': 'Session Storage Path',
    'settings.sessionPathDesc': 'Custom path for session data. Leave empty for the default workspace .pi/ directory.',
    'settings.contextWarning': 'Context Usage Warning',
    'settings.contextWarningDesc': 'Warn when context usage exceeds {n}% of the context window.',
    'settings.cacheWarming': 'Cache warming mode',
    'settings.cacheWarmingDesc': 'Keep the prompt cache warm to cut latency and cost on long turns. Mirrors Pi\'s global cache-warming setting; applied only when explicitly set, so a mode configured through Pi\'s CLI is never overridden.',
    'settings.warm.off': 'Off',
    'settings.warm.streaming': 'Streaming',
    'settings.warm.idle': 'Idle',
    'settings.section.skills': 'Skills',
    'settings.skillsLoading': 'Loading skills...',
    'settings.skillsEmpty': 'No skills found. Place <code>SKILL.md</code> files in <code>~/.pi/agent/skills/</code> or <code>.pi/skills/</code> in your workspace.',
    'settings.manualOnly': 'manual only',
    'settings.apiKey': 'API Key',
    'settings.keyStored': 'Key stored',
    'settings.noKey': 'No key stored',
    'settings.change': 'Change',
    'settings.remove': 'Remove',
    'settings.keyStoredDesc': 'API key is securely stored and never written to settings files.',
    'settings.enterKey': 'Enter your API key',
    'settings.save': 'Save',
    'settings.keySecureDesc': 'Securely stored via VS Code SecretStorage. Never written to settings files.',
    'settings.authEnv': 'Authenticated via environment variable',
    'settings.authLogin': 'Authenticated via Pi CLI login (~/.pi/agent/)',
    'settings.authKey': 'Authenticated via stored API key',
    'settings.authNone': 'No credentials detected',
    'settings.toastSelectProvider': 'Select a provider first',
    'settings.toastEnterKey': 'Enter an API key',

    // Message actions (edit / regenerate)
    'msg.editTitle': 'Edit and resend from this turn',
    'msg.replayTitle': 'Roll back to this turn and resend',
    'edit.banner': 'Editing turn {n} — sending rolls the conversation back to here',
    'edit.cancelTitle': 'Cancel editing',
    'edit.blockedStreaming': 'Cannot resend while the agent is streaming. Stop it first.',

    // Session export
    'export.save': 'Export as Markdown',
    'export.success': 'Session exported to {path}',
    'export.empty': 'Nothing to export yet — send a message first.',
    'export.open': 'Open',
    'export.failed': 'Export failed: {message}',

    // Completion notification
    'notify.done': '"{name}" finished responding ({duration}).',
} as const;

export type TextKey = keyof typeof EN;
export const TEXT_KEYS: TextKey[] = Object.keys(EN) as TextKey[];

const ZH: Record<TextKey, string> = {
    'welcome.title': 'Pi Agent',
    'welcome.headline': '和 Pi 聊聊你的代码库',
    'welcome.subtitle': 'Pi 在这个工作区里读代码、写代码、跑代码。告诉它你想构建什么，它会边做边展示过程。',
    'welcome.hint': '输入 <kbd>/</kbd> 查看命令与技能',
    'welcome.hintShort': '<kbd>/</kbd> 技能&nbsp;&nbsp;<kbd>@</kbd> 引用&nbsp;&nbsp;<kbd>Ctrl</kbd>+<kbd>L</kbd> 聚焦',
    'welcome.sug1.title': '调试报错',
    'welcome.sug1.desc': '把报错或堆栈发给我，定位根因',
    'welcome.sug1.prompt': '帮我调试这个报错——以下是错误信息和出现位置：',
    'welcome.sug2.title': '审阅改动',
    'welcome.sug2.desc': '逐文件评审工作区未提交改动',
    'welcome.sug2.prompt': '审阅我的未提交改动',
    'welcome.sug3.title': '重构代码',
    'welcome.sug3.desc': '拆解或抽取模块，给出前后对比',
    'welcome.sug3.prompt': '重构这段代码：',
    'welcome.sug4.title': '解释选区',
    'welcome.sug4.desc': '选中一段代码，逐行讲解行为',
    'welcome.sug4.prompt': '解释选中的代码',

    'header.ready': '就绪',
    'header.readyTitle': '已检测到 Pi 配置——{providers} 个提供者，{models} 个模型',
    'header.newAgent': '新建代理',
    'header.sessions': '会话',
    'header.settings': '设置',
    'header.closeTab': '关闭标签页',
    'header.renameSession': '重命名会话',
    'header.scrollToBottom': '滚动到底部',

    // Turn chrome (rail π markers)
    'msg.pi': 'Pi',
    'msg.me': '我',
    'msg.turn': '第 {n} 轮',

    'input.ask': '向 Pi 提出任何请求...（输入 / 唤出命令）',
    'input.queue': '排队一条消息...',
    'input.send': '发送',
    'input.queueSend': '排队',
    'input.stop': '停止',
    'input.steer': '转向',
    'input.contextTooltip': '上下文：{tokens} / {window} tokens（{percent}%）',
    'input.contextWindowTooltip': '上下文窗口：{window} tokens',

    'stream.preparing': '正在准备下一步...',
    'stream.retrying': '出错后重试中（{attempt}/{max}）：{error}',
    'stream.thinking': '思考中...',
    'stream.thought': '已思考',
    'stream.thoughtForOne': '思考了 {n} 秒',
    'stream.thoughtForMany': '思考了 {n} 秒',
    'stream.steering': '转向中...',

    'queue.count': '排队 {n} 条',
    'queue.edit': '编辑',
    'queue.remove': '移除',
    'queue.save': '保存',
    'queue.cancel': '取消',

    'files.countOne': '{n} 个文件',
    'files.countMany': '{n} 个文件',
    'files.undo': '撤销',
    'files.redo': '重做',
    'files.review': '审查',
    'files.undoTitle': '撤销上次更改',
    'files.redoTitle': '重做更改',
    'files.reviewTitle': '审查全部更改',
    'files.undoConfirm': '撤销上一轮的更改？',
    'files.redoConfirm': '重新应用已回滚的更改？',

    'checkpoint.restore': '恢复到此检查点',
    'checkpoint.restored': '已将 {n} 个文件恢复到检查点。',
    'checkpoint.discardConfirm': '丢弃此检查点之后的全部更改？',

    'tool.result': '工具结果',
    'tool.noOutput': '（无输出）',
    'tool.running': '运行中',
    'tool.done': '完成',
    'tool.error': '错误',
    'tool.pending': '等待中',
    'tool.bashFallback': '执行命令',
    'tool.readFallback': '读取文件',
    'tool.writeFallback': '写入文件',
    'tool.editFallback': '编辑文件',
    'tool.globFallback': '查找文件',
    'tool.grepFallback': '搜索文件',
    'tool.read': '读取 {path}',
    'tool.write': '写入 {path}',
    'tool.edit': '编辑 {path}',
    'tool.glob': '查找 {pattern}',
    'tool.grep': '搜索 {pattern}',

    'meta.tokensIn': '输入 {n}',
    'meta.tokensOut': '输出 {n}',
    'meta.inputTokens': '{n} 输入 tokens',
    'meta.outputTokens': '{n} 输出 tokens',

    'approval.awaiting': '等待批准',
    'approval.approve': '批准',
    'approval.reject': '拒绝',
    'approval.remember': '记住 ▾',
    'approval.rememberSession': '仅本会话',
    'approval.rememberGlobal': '所有标签页（全局）',
    'approval.memorySession': '记忆 · 本会话',
    'approval.memoryGlobal': '记忆 · 全部标签页',

    'config.notFound': '未在 {dir} 找到 Pi 配置 — 请安装 Pi 或检查 agent 目录。',
    'config.stats': '已读取 Pi 配置：{providers} · {models} · {skills}',
    'config.issue': '配置问题（{source}）：{message}',
    'config.issueFallback': '部分 Pi 配置源无法读取。',
    'config.recheck': '重新检测',
    'config.providerCountOne': '{n} 个提供者',
    'config.providerCountMany': '{n} 个提供者',
    'config.modelCountOne': '{n} 个模型',
    'config.modelCountMany': '{n} 个模型',
    'config.skillCountOne': '{n} 个技能',
    'config.skillCountMany': '{n} 个技能',
    'config.notFoundShort': '未配置',
    'config.partialShort': '部分配置',
    'config.discovering': '正在检测配置…',

    'models.search': '搜索模型...',
    'models.recent': '最近使用',
    'models.all': '全部模型',
    'models.thinking': '思考：',
    'models.selectPlaceholder': '选择模型',
    'models.noneAvailable': '无可用模型。请检查 Pi 配置。',

    'sessions.title': '会话',
    'sessions.empty': '暂无历史会话',
    'sessions.noMatch': '没有匹配的会话',
    'sessions.search': '搜索会话...',
    'sessions.close': '关闭',

    'code.copy': '复制',
    'code.copied': '已复制！',
    'code.apply': '应用',
    'code.showMore': '展开',
    'code.showLess': '收起',

    'apply.title': '应用到 {path}',
    'apply.newFileBadge': '新文件',
    'apply.confirm': '写入',
    'apply.cancel': '取消',
    'apply.applied': '已应用到 {path}。',
    'apply.created': '已创建 {path}。',
    'apply.conflict': '文件已被外部修改，请重新预览。',
    'apply.expired': '预览已过期，请重新应用。',
    'apply.exists': '文件已存在，请重新预览。',
    'apply.deleted': '文件在预览后已被删除，请重新预览。',
    'apply.dirty': '文件在编辑器中有未保存的修改，请先保存后重新预览。',
    'apply.cancelled': '预览已取消。',
    'apply.writeError': '写入文件失败：{message}',
    'apply.noWorkspace': '请先打开工作区文件夹再应用代码。',
    'apply.pickTarget': '选择此代码块要应用到的文件',

    'compact.bannerTitle': '上下文已使用 {n}%',
    'compact.bannerHint': '压缩将摘要较早的对话历史，并保留队列中未发送的消息。',
    'compact.accept': '立即压缩',
    'compact.dismiss': '暂不',
    'compact.compacting': '正在压缩上下文…',
    'compact.failed': '压缩失败——已保留原上下文，可稍后用 /compact 重试。',
    'compact.nothingToCompact': '暂无可压缩的内容——会话还太小（或最近已压缩过），最近历史将原样保留。',
    'compact.done': '上下文压缩完成。',

    // Built-in slash commands
    'slash.unsupported': '“/{name}”在 Pi 面板中暂不可用。',
    'slash.blockedStreaming': '“/{name}”不能在生成进行中执行，请等当前轮次完成。',
    'slash.nameUsage': '用法：/name <新名称>',
    'slash.copied': '已将最后一条回复复制到剪贴板。',
    'slash.copyEmpty': '还没有可复制的回复。',
    'slash.loginHint': '请在设置面板配置 provider API 密钥。',
    'slash.sessionInfo': '会话：{name}\n模型：{model}\n上下文：{usage}\n文件：{path}',

    // Image input
    'image.attach': '添加文件',
    'image.unsupported': '当前模型不支持图片输入',
    'image.tooLarge': '图片过大（超过 25 MB，或压缩后仍超 5 MB）',
    'image.resized': '「{name}」已自动压缩以符合大小限制',
    'image.tooMany': '图片数量超限（最多 {n} 张）',
    'image.invalid': '无法识别的图片数据',
    'image.queueUnsupported': '智能体回复期间无法添加图片',
    'image.remove': '移除图片',

    // File attachments (non-image, text)
    'attach.binaryUnsupported': '无法附加「{name}」：二进制文件不能直接内联，可从文件资源管理器拖入以 @ 方式引用路径',
    'attach.tooLarge': '「{name}」过大（最多 5 MB）',
    'attach.streamingUnsupported': '智能体回复期间无法附加文件',

    // Selection context chip (Copilot-style auto-attach)
    'selection.detach': '不附加选中代码',

    // Send to Pi (editor context menu)
    'sendToPi.intro': '这是 `{path}:{range}` 处的选区代码：',
    'sendToPi.noSelection': '请先在编辑器中选中代码。',
    'sendToPi.tooLarge': '选区过大，无法发送（上限 {n} 字符）。',
    // @-mention
    'mention.deleted': '引用的文件已不存在：{path}',
    'mention.noResults': '没有匹配的文件或符号',
    'mention.groupFiles': '文件',
    'mention.groupSymbols': '符号',
    'mention.dropInvalid': '部分拖入的文件无法引用（需为工作区内的文件）。',

    // Commit message generation
    'commit.generatingPlaceholder': '正在生成 commit message…',
    'commit.inProgress': '正在生成 commit message，请稍候。',
    'commit.noGit': 'Git 扩展不可用。',
    'commit.noRepository': '工作区中未找到 Git 仓库。',
    'commit.noChanges': '没有暂存或未暂存的改动可以描述。',
    'commit.noModel': '无可用模型，请检查 Pi 配置。',
    'commit.failed': '生成 commit message 失败：',

    // 错误人话（T17）：发生了什么 + 影响 + 建议动作。
    'err.auth': 'Pi 无法通过模型提供者的身份验证，本轮没有产生回答。请在设置面板检查 API 密钥，或重新运行 Pi 登录。',
    'err.network': 'Pi 无法连接模型提供者，本轮未完成。请检查网络或代理连接后重试。',
    'err.rateLimit': '模型提供者正在限流，本轮提前停止。请稍候再试；若持续出现，请检查账户额度。',
    'err.config': 'Pi 配置缺失或无法读取，请求无法开始。请打开设置面板检查提供者与模型。',
    'err.unknown': 'Pi 遇到意外错误，本轮已停止——上下文已保留。可重试；若反复出现，请查看 Pi Agent 输出通道。详情：{message}',

// 宿主命令提示（T17 残留文案收口）
    'command.thinkingChanged': '思考级别：{level}',
    'common.yes': '是',
    'init.failed': 'Pi Agent 初始化失败：{message}',

    // 提示词缓存预热 footer 指示器（SDK 0.86+）
    'warm.state.inactive': '未预热',
    'warm.state.scheduled': '将预热',
    'warm.state.refreshing': '预热中…',
    'warm.savings': '每次缓存刷新节省 ~{amount}',
    'warm.scheduledAt': '下次预热 {time}',

    // 一键 Bug 诊断摘要（SDK 0.86+）
    'diagnostic.generating': '正在生成诊断摘要…',
    'diagnostic.busy': 'Pi 仍在处理上一轮任务，请先等待完成。',
    'diagnostic.failed': '生成诊断摘要失败：{message}',
    'diagnostic.cancelled': '已取消生成诊断摘要。',
    'diagnostic.empty': 'Pi 未生成摘要内容。',
    'diagnostic.noSession': '没有活跃的 Pi 会话。',
    'diagnostic.unsupported': '当前安装的 Pi SDK 不支持诊断摘要。',

    // 状态栏打开面板入口（次侧边栏容器没有活动栏图标）
    'statusBar.openPanel': '打开 Pi Agent 面板',
    'occupancy.occupied': '该会话已在其他 VS Code 窗口打开，此处为只读。',
    'occupancy.released': '其他窗口已释放该会话，可以恢复编辑。',
    'occupancy.lostLock': '该会话已被其他窗口接管，此处为只读。',
    'occupancy.takeover': '接管',
    'occupancy.resume': '恢复编辑',
    'occupancy.readOnlyBlocked': '会话只读：已在其他窗口打开。接管后才能继续。',

    'inline.busy': 'Pi 仍在处理中，请等当前轮次结束。',
    'inline.active': '已有进行中的行内编辑。',
    'inline.promptTitle': '让 Pi 编辑（行内）',
    'inline.inputPlaceholder': '描述修改内容…（Esc 取消）',
    'inline.dirtySave': '该文件有未保存修改。先保存再呼出行内编辑？',
    'inline.conflictNotice': '检测到 Pi 编辑期间的手动修改——行内预览可能冲突。',
    'inline.discardConfirm': '放弃本轮行内编辑的全部修改？',
    'inline.discardConflictConfirm': '你手动修改过该文件，放弃将一并回滚这些修改。继续？',
    'inline.accepted': '已保留行内修改。',
    'inline.discarded': '已回滚行内修改。',
    'inline.statusAccept': '接受',
    'inline.statusDiscard': '放弃',
    'inline.statusTitle': '评审行内编辑：保留或回滚本轮全部修改',

    'diff.new': '新建',

    'settings.title': 'Pi Agent 设置',
    'settings.section.api': 'API 连接',
    'settings.provider': '提供者',
    'settings.autoDetect': '自动检测',
    'settings.providerDesc': '选择要使用的 AI 提供者。保持"自动检测"可自动解析。',
    'settings.section.model': '默认模型与思考',
    'settings.defaultModel': '默认模型',
    'settings.defaultModelDesc': '新会话启动时使用的模型 ID（如 claude-sonnet-4-20250514）。留空则自动选择。',
    'settings.thinkingLevel': '默认思考级别',
    'settings.think.off': '关闭',
    'settings.think.minimal': '最少',
    'settings.think.low': '低',
    'settings.think.medium': '中',
    'settings.think.high': '高',
    'settings.thinkingLevelDesc': '默认情况下代理思维链的详细程度。',
    'settings.section.tools': '工具执行',
    'settings.autoApprove': '自动批准工具调用',
    'settings.autoApproveDesc': '启用后代理执行工具无需确认。禁用后每次工具调用都会显示内联审批卡。',
    'settings.allowedTools': '允许的工具',
    'settings.allowedToolsDesc': '以逗号分隔的工具名白名单（如 read, grep, bash）。留空允许全部。',
    'settings.allowedToolsPlaceholder': '如 read, grep, bash',
    'settings.section.approval': '审批记忆',
    'settings.approvalLoading': '正在加载审批规则...',
    'settings.approvalDesc': '你在审批卡中选择"记住"的工具，将在所有标签页中放行。Shell 类工具永远不会被记住。更改即时生效。',
    'settings.approvalEmpty': '暂无全局审批规则。',
    'settings.approvalSince': '添加于 {date}',
    'settings.revoke': '撤销',
    'settings.clearAll': '清空全部（{n}）',
    'settings.section.session': '会话行为',
    'settings.autoSave': '自动保存会话',
    'settings.autoSaveDesc': '每轮对话后自动持久化会话。',
    'settings.sessionPath': '会话存储路径',
    'settings.sessionPathDesc': '会话数据的自定义路径。留空使用工作区默认的 .pi/ 目录。',
    'settings.contextWarning': '上下文用量警告',
    'settings.contextWarningDesc': '当上下文用量超过上下文窗口的 {n}% 时发出警告。',
    'settings.cacheWarming': '缓存预热模式',
    'settings.cacheWarmingDesc': '保持提示词缓存预热，以降低长对话的延迟与成本。对应 Pi 的全局缓存预热设置；仅在显式设置时才生效，因此通过 Pi CLI 配置的模式不会被覆盖。',
    'settings.warm.off': '关闭',
    'settings.warm.streaming': '流式',
    'settings.warm.idle': '空闲',
    'settings.section.skills': '技能',
    'settings.skillsLoading': '正在加载技能...',
    'settings.skillsEmpty': '未找到技能。请将 <code>SKILL.md</code> 放在 <code>~/.pi/agent/skills/</code> 或工作区的 <code>.pi/skills/</code> 中。',
    'settings.manualOnly': '仅手动',
    'settings.apiKey': 'API 密钥',
    'settings.keyStored': '已存储密钥',
    'settings.noKey': '未存储密钥',
    'settings.change': '更改',
    'settings.remove': '移除',
    'settings.keyStoredDesc': 'API 密钥被安全存储，绝不写入设置文件。',
    'settings.enterKey': '输入你的 API 密钥',
    'settings.save': '保存',
    'settings.keySecureDesc': '通过 VS Code SecretStorage 安全存储。绝不写入设置文件。',
    'settings.authEnv': '已通过环境变量认证',
    'settings.authLogin': '已通过 Pi CLI 登录认证（~/.pi/agent/）',
    'settings.authKey': '已通过存储的 API 密钥认证',
    'settings.authNone': '未检测到凭据',
    'settings.toastSelectProvider': '请先选择提供者',
    'settings.toastEnterKey': '请输入 API 密钥',

    // Message actions (edit / regenerate)
    'msg.editTitle': '编辑并从此轮重发',
    'msg.replayTitle': '回滚到此轮并重发',
    'edit.banner': '正在编辑第 {n} 轮——发送后对话将回滚到此处',
    'edit.cancelTitle': '取消编辑',
    'edit.blockedStreaming': 'Agent 正在回复，无法重发。请先停止。',

    // Session export
    'export.save': '导出为 Markdown',
    'export.success': '会话已导出到 {path}',
    'export.empty': '暂无可导出的内容——请先发送一条消息。',
    'export.open': '打开',
    'export.failed': '导出失败：{message}',

    // Completion notification
    'notify.done': '“{name}”已完成回复（用时 {duration}）。',
} as const;

let currentLang: Lang = 'en';

export function setLang(lang: Lang): void {
    currentLang = lang === 'zh' ? 'zh' : 'en';
}

export function getLang(): Lang {
    return currentLang;
}

/** Translate `key`, interpolating `{name}` params. Unknown params stay visible. */
export function t(key: TextKey, params?: Record<string, string | number>): string {
    const template = currentLang === 'zh' ? ZH[key] : EN[key];
    const text = template ?? String(key);
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name];
        return value === undefined ? match : String(value);
    });
}

/** Translated label for a thinking level id (off/minimal/low/medium/high). */
export function thinkingLevelLabel(level: string): string {
    const key = `settings.think.${level}` as TextKey;
    return key in EN ? t(key) : level;
}

/** Interpolation parameter names a key uses in `lang` (translation guard). */
export function textParams(lang: Lang, key: TextKey): string[] {
    const template = lang === 'zh' ? ZH[key] : EN[key];
    return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}
