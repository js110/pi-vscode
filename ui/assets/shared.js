/* pi-vscode UI Prototype — 共享脚本
 * 1) 注入右上角工具条：深/浅主题切换 + 中/英切换（演示 AC-OP-02 四组合）
 * 2) i18n：页面定义 window.PI_PAGE = { zh: {key:文本}, en: {...} }，
 *    元素用 data-i18n="key"（textContent）/ data-i18n-ph="key"（placeholder）
 */
(function () {
  "use strict";

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
  }
})();
