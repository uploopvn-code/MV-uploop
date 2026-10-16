import { $ } from './core.js';

let locale = localStorage.getItem('mv-locale') || 'vi';
let messages = {};

export async function setLocale(next) {
  locale = ['vi', 'en', 'zh', 'ja', 'ko'].includes(next) ? next : 'vi';
  try {
    const r = await fetch('/locales/' + locale + '.json', { cache: 'no-store' });
    messages = r.ok ? await r.json() : {};
  } catch { messages = {}; }
  localStorage.setItem('mv-locale', locale);
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (messages[el.dataset.i18n]) el.textContent = messages[el.dataset.i18n];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    if (messages[el.dataset.i18nPlaceholder]) el.placeholder = messages[el.dataset.i18nPlaceholder];
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    if (messages[el.dataset.i18nTitle]) el.title = messages[el.dataset.i18nTitle];
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    if (messages[el.dataset.i18nAria]) el.setAttribute('aria-label', messages[el.dataset.i18nAria]);
  });
  for (const [id, key] of Object.entries({
    queueProvider: 'queue.providerFilterAria',
    queueAccount: 'queue.accountFilterAria',
    queueProject: 'queue.projectFilterAria',
    queueStatus: 'queue.statusFilterAria',
  })) {
    const el = document.getElementById(id);
    if (el && messages[key]) el.setAttribute('aria-label', messages[key]);
  }
  const select = $('#languageSelect');
  if (select) select.value = locale;
  document.dispatchEvent(new CustomEvent('localechange', { detail: locale }));
}

export const t = key => messages[key] || key;
export const getLocale = () => locale;
// Non-UI modules that are intentionally kept dependency-light (canvas bootstrap/tests) can
// still request a translated label without importing this module and creating a cycle.
globalThis.mvT = t;
export const initI18n = () => {
  const select = $('#languageSelect');
  if (select) select.onchange = () => setLocale(select.value);
  return setLocale(locale).then(() => {
    globalThis.mvT = t;
  });
};
