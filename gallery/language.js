// The gallery also runs inside an opaque-origin Magpie frame, where localStorage
// is unavailable. Local management pages share a preference saved by the plugin.
const messages = JSON.parse(document.getElementById('translations').textContent);
const languageMenu = document.getElementById('language');
const preferenceMeta = document.querySelector('meta[name="local-language"]');
const preferenceKey = 'pelican-monitor.language';
const supported = new Set(Array.from(languageMenu.options, option => option.value));
function systemLanguage() {
  for (const tag of [...(navigator.languages || []), navigator.language]) {
    try {
      const locale = new Intl.Locale(tag);
      if (locale.language === 'zh') return locale.maximize().script === 'Hant' ? 'zh-TW' : 'zh-CN';
      if (supported.has(locale.language)) return locale.language;
    } catch { /* Ignore unavailable or malformed system preferences. */ }
  }
  return 'zh-CN';
}
function readPreference() {
  if (preferenceMeta) return preferenceMeta.content;
  try { return localStorage.getItem(preferenceKey); } catch { return null; }
}
let preference = readPreference();
if (!supported.has(preference)) preference = 'system';
let locale = preference === 'system' ? systemLanguage() : preference;
function t(key, values) {
  const text = (Object.hasOwn(messages, key) && messages[key][locale]) || key;
  return values ? text.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token) : text;
}
// Capture only the initial template, before inserting account names, prompts,
// artwork or model replies. Keep those values exactly as their authors wrote them.
const staticBindings = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) {
  const node = walker.currentNode;
  if (node.parentElement.closest('script,style')) continue;
  const key = node.data.trim();
  if (Object.hasOwn(messages, key)) {
    const original = node.data;
    staticBindings.push(() => { if (node.isConnected) node.data = original.replace(key, () => t(key)); });
  }
}
for (const el of document.querySelectorAll('[aria-label]')) {
  const key = el.getAttribute('aria-label');
  if (Object.hasOwn(messages, key)) staticBindings.push(() => el.setAttribute('aria-label', t(key)));
}
const guide = document.getElementById('user-guide');
function renderGuide() {
  if (!guide.open) return;
  const content = document.getElementById('guide-content');
  if (content.lang === locale) return;
  content.replaceChildren(document.getElementById('guide-' + locale).content.cloneNode(true));
  content.lang = locale;
  for (const link of content.querySelectorAll('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}
guide.addEventListener('toggle', renderGuide);
function translateTemplate() {
  document.documentElement.lang = locale;
  document.title = t('鹈鹕巡检');
  languageMenu.value = preference;
  for (const apply of staticBindings) apply();
  renderGuide();
}
translateTemplate();
