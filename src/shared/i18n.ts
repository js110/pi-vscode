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
    'welcome.subtitle': 'Pi reads, writes, and runs code in this workspace. Tell it what to build and it will show its work as it goes.',
    'welcome.hint': 'Type <kbd>/</kbd> for commands and skills',

    // Header / tabs
    'header.newAgent': 'New Agent',
    'header.sessions': 'Sessions',
    'header.settings': 'Settings',
    'header.closeTab': 'Close tab',
    'header.renameSession': 'Rename session',
    'header.scrollToBottom': 'Scroll to bottom',

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
    'stream.thoughtFor': 'Thought for {n} second{s}',
    'stream.steering': 'Steering...',

    // Queued messages
    'queue.count': '{n} queued',
    'queue.edit': 'Edit',
    'queue.remove': 'Remove',
    'queue.save': 'Save',
    'queue.cancel': 'Cancel',

    // Changed files
    'files.count': '{n} file{s}',
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
    'config.providerCount': '{n} provider{s}',
    'config.modelCount': '{n} model{s}',
    'config.skillCount': '{n} skill{s}',

    // Model picker
    'models.search': 'Search models...',
    'models.recent': 'Recent',
    'models.all': 'All Models',
    'models.thinking': 'Thinking:',

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

    // Image input
    'image.attach': 'Attach image',
    'image.unsupported': 'The current model does not support image input',
    'image.tooLarge': 'Image is too large (max 5 MB)',
    'image.tooMany': 'Too many images (max {n})',
    'image.invalid': 'Unsupported image data',
    'image.queueUnsupported': 'Images cannot be added while the agent is streaming',
    'image.remove': 'Remove image',

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
    'settings.section.skills': 'Skills',
    'settings.skillsLoading': 'Loading skills...',
    'settings.skillsEmpty': 'No skills found. Place <code>SKILL.md</code> files in <code>~/.pi/agent/skills/</code> or <code>.pi/skills/</code> in your workspace.',
    'settings.manualOnly': 'manual only',
    'settings.section.credits': 'Credits',
    'settings.credits': 'Icons by <a href="https://www.flaticon.com/authors/royyan-wijaya">Royyan Wijaya</a> on Flaticon.',
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
} as const;

export type TextKey = keyof typeof EN;
export const TEXT_KEYS: TextKey[] = Object.keys(EN) as TextKey[];

const ZH: Record<TextKey, string> = {
    'welcome.title': 'Pi Agent',
    'welcome.subtitle': 'Pi 在这个工作区里读代码、写代码、跑代码。告诉它你想构建什么，它会边做边展示过程。',
    'welcome.hint': '输入 <kbd>/</kbd> 查看命令与技能',

    'header.newAgent': '新建代理',
    'header.sessions': '会话',
    'header.settings': '设置',
    'header.closeTab': '关闭标签页',
    'header.renameSession': '重命名会话',
    'header.scrollToBottom': '滚动到底部',

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
    'stream.thoughtFor': '思考了 {n} 秒',
    'stream.steering': '转向中...',

    'queue.count': '排队 {n} 条',
    'queue.edit': '编辑',
    'queue.remove': '移除',
    'queue.save': '保存',
    'queue.cancel': '取消',

    'files.count': '{n} 个文件',
    'files.undo': '撤销',
    'files.redo': '重做',
    'files.review': '审查',
    'files.undoTitle': '撤销上次更改',
    'files.redoTitle': '重做更改',
    'files.reviewTitle': '审查全部更改',
    'files.undoConfirm': '撤销上一轮的更改？',
    'files.redoConfirm': '重新应用已回滚的更改？',

    'checkpoint.restore': '恢复到此检查点',
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
    'config.providerCount': '{n} 个提供者',
    'config.modelCount': '{n} 个模型',
    'config.skillCount': '{n} 个技能',

    'models.search': '搜索模型...',
    'models.recent': '最近使用',
    'models.all': '全部模型',
    'models.thinking': '思考：',

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
    'apply.writeError': '写入文件失败：{message}',
    'apply.noWorkspace': '请先打开工作区文件夹再应用代码。',
    'apply.pickTarget': '选择此代码块要应用到的文件',

    'compact.bannerTitle': '上下文已使用 {n}%',
    'compact.bannerHint': '压缩将摘要较早的对话历史，并保留队列中未发送的消息。',
    'compact.accept': '立即压缩',
    'compact.dismiss': '暂不',
    'compact.compacting': '正在压缩上下文…',
    'compact.failed': '压缩失败——已保留原上下文，可稍后用 /compact 重试。',

    // Image input
    'image.attach': '添加图片',
    'image.unsupported': '当前模型不支持图片输入',
    'image.tooLarge': '图片过大（上限 5 MB）',
    'image.tooMany': '图片数量超限（最多 {n} 张）',
    'image.invalid': '无法识别的图片数据',
    'image.queueUnsupported': '智能体回复期间无法添加图片',
    'image.remove': '移除图片',

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
    'settings.section.skills': '技能',
    'settings.skillsLoading': '正在加载技能...',
    'settings.skillsEmpty': '未找到技能。请将 <code>SKILL.md</code> 放在 <code>~/.pi/agent/skills/</code> 或工作区的 <code>.pi/skills/</code> 中。',
    'settings.manualOnly': '仅手动',
    'settings.section.credits': '致谢',
    'settings.credits': '图标由 Flaticon 上的 <a href="https://www.flaticon.com/authors/royyan-wijaya">Royyan Wijaya</a> 提供。',
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
};

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
