/* pi-vscode UI Prototype — 共享脚本
 * 1) 注入右上角工具条：深/浅主题切换 + 中/英切换（演示 AC-OP-02 四组合）
 * 2) i18n：页面定义 window.PI_PAGE = { zh: {key:文本}, en: {...} }，
 *    元素用 data-i18n="key"（textContent）/ data-i18n-ph="key"（placeholder）/
 *    data-i18n-val="key"（input value）
 * 3) title 工具提示：集中词典 PI_TIPS（中文原文为键，QA N3 文案集中层方案），
 *    applyLang 时全量切换；未收录的 title 保持原文
 */
(function () {
  "use strict";

  var PI_TIPS = {
    "设置": "Settings",
    "设置（配置错误态下禁用）": "Settings (disabled in config-error state)",
    "打开 diff": "Open diff",
    "随 Tab 关闭自动清除": "Auto-cleared when the tab closes",
    "移除该条消息": "Remove this message",
    "添加图片（当前模型支持）": "Add image (supported by current model)",
    "新建 Tab": "New Tab",
    "已中断": "Aborted",
    "对所有 Tab 生效": "Applies to all tabs",
    "发送": "Send",
    "会话历史": "Session history",
    "历史会话": "Session history",
    "Plan 执行中": "Plan running",
    "Plan 待批准": "Plan awaiting approval",
    "@ 引用文件/符号": "@ Reference files/symbols",
    "@ 引用文件或符号": "@ Reference files or symbols",
    "返回": "Back",
    "点击展开放行详情": "Click to expand auto-allow details",
    "模型选择器": "Model picker",
    "未保存": "Unsaved",
    "放弃（Esc）": "Discard (Esc)",
    "放弃": "Discard",
    "控制台报错截图": "Console error screenshot",
    "接管：本端转为可写，原占用端自动转只读 / Take over: this side becomes writable, the other side turns read-only": "Take over: this side becomes writable, the other side turns read-only",
    "接受（Enter）": "Accept (Enter)",
    "接受": "Accept",
    "技能菜单": "Skills menu",
    "打开 Pi 配置文档": "Open Pi config docs",
    "当前模型不支持图片输入 / Image input not supported by current model": "Image input not supported by current model",
    "失败暂停": "Failed & paused",
    "发送（流式中：加入队列，本轮结束后依序发送） / Send (streaming: queued until this turn ends)": "Send (streaming: queued until this turn ends)",
    "发送到 Pi": "Send to Pi",
    "切换深浅主题": "Toggle light/dark theme",
    "切换模型": "Switch model",
    "切换中/英": "Toggle Chinese/English",
    "关闭": "Close",
    "产出计划中": "Drafting plan",
    "正在流式生成": "Streaming",
    "上下文用量": "Context usage",
    "auth.ts（未保存修改）": "auth.ts (unsaved changes)",
    "Steer：打断当前生成，以输入内容作为新指令转向 / Steer: interrupt the current turn and redirect with the input": "Steer: interrupt the current turn and redirect with the input"
  };

  var toolbar = document.createElement("div");
  toolbar.className = "proto-toolbar";
  toolbar.innerHTML =
    '<button id="proto-theme" title="切换深浅主题">🌗 主题</button>' +
    '<button id="proto-lang" title="切换中/英">🌐 EN</button>';
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(toolbar);
    document.getElementById("proto-theme").addEventListener("click", function () {
      var root = document.documentElement;
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      this.textContent = next === "dark" ? "🌗 主题" : "🌗 Theme";
    });
    document.getElementById("proto-lang").addEventListener("click", function () {
      var next = window.__protoLang === "zh" ? "en" : "zh";
      applyLang(next);
      this.textContent = next === "zh" ? "🌐 EN" : "🌐 中文";
    });
    applyLang("zh");
  });

  function applyTips(lang) {
    document.querySelectorAll("[title]").forEach(function (el) {
      if (el.__tipZh === undefined) el.__tipZh = el.getAttribute("title");
      var en = PI_TIPS[el.__tipZh];
      if (en !== undefined) el.setAttribute("title", lang === "en" ? en : el.__tipZh);
    });
  }

  function applyLang(lang) {
    window.__protoLang = lang;
    var dict = (window.PI_PAGE && window.PI_PAGE[lang]) || {};
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) el.textContent = dict[key];
    });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-ph");
      if (dict[key] !== undefined) el.setAttribute("placeholder", dict[key]);
    });
    document.querySelectorAll("[data-i18n-val]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-val");
      if (dict[key] !== undefined) el.value = dict[key];
    });
    applyTips(lang);
  }
})();
