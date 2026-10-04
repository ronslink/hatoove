/** Public interface language only: never account, exam, draft or session state. */
export const LOCALES = Object.freeze(['de', 'en', 'uk', 'ar', 'tr']);
export const LANGUAGE_NAMES = Object.freeze({ de: 'Deutsch', en: 'English', uk: 'Українська', ar: 'العربية', tr: 'Türkçe' });
export const LOCALE_STORAGE_KEY = 'hatoove.interface-language.v1';
export const validLocale = value => typeof value === 'string' && LOCALES.includes(value);
const unavailable = Object.freeze({ de: 'Übersetzung nicht verfügbar.', en: 'Translation unavailable.', uk: 'Переклад недоступний.', ar: 'الترجمة غير متاحة.', tr: 'Çeviri mevcut değil.' });
const attributes = Object.freeze({ 'data-i18n-title': 'title', 'data-i18n-placeholder': 'placeholder', 'data-i18n-aria-label': 'aria-label', 'data-i18n-alt': 'alt' });
const selector = ['[data-i18n]', ...Object.keys(attributes).map(name => `[${name}]`)].join(',');
const ownValue = (object, key) => {
  const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeKey = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(value)
  && !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
const placeholders = value => [...new Set([...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]))].sort();

/** Injected environment keeps privacy and denied-storage checks independent of a browser. */
export function createLocaleRuntime({ readStorage = () => globalThis.localStorage, readNavigator = () => globalThis.navigator, readDocument = () => globalThis.document } = {}) {
  const catalogues = new Map();
  const listeners = new Set();
  /**
   * The visitor's OWN stored choice, or null. It never guesses from the browser, so a caller can tell
   * "this person chose a language" apart from "nothing was chosen" — which is what the public front
   * door needs, because Googlebot reports `en-US` while the page it fetches is German. It exists so
   * that the storage read stays inside this runtime: `tools/public-locale-check.mjs` fails any public
   * shell that reaches storage on its own.
   */
  function storedLocale() {
    try {
      const saved = readStorage()?.getItem(LOCALE_STORAGE_KEY);
      return validLocale(saved) ? saved : null;
    } catch { /* Denied storage is not a language choice. */ }
    return null;
  }
  function initialLocale() {
    const saved = storedLocale();
    if (saved) return saved;
    try {
      const navigator = readNavigator();
      const preferred = Array.isArray(navigator?.languages) ? navigator.languages : [navigator?.language];
      for (const tag of preferred) {
        if (typeof tag !== 'string') continue;
        const language = tag.toLowerCase().split('-')[0];
        if (validLocale(language)) return language;
      }
    } catch { /* An unavailable browser preference is not a locale choice. */ }
    return 'de';
  }
  let locale = initialLocale();
  const getLocale = () => locale;
  function registerMessages(namespace, byLocale) {
    if (!safeKey(namespace) || namespace.includes('.') || !plain(byLocale)) throw new TypeError('invalid_locale_catalogue');
    if (catalogues.has(namespace)) throw new TypeError('duplicate_locale_namespace');
    if (Object.keys(byLocale).sort().join('|') !== [...LOCALES].sort().join('|')) throw new TypeError('incomplete_locale_catalogue');
    const german = ownValue(byLocale, 'de');
    if (!plain(german)) throw new TypeError('invalid_locale_catalogue');
    const keys = Object.keys(german).sort();
    if (!keys.length || keys.some(key => !safeKey(key))) throw new TypeError('invalid_locale_key');
    const copies = Object.create(null);
    for (const language of LOCALES) {
      const messages = ownValue(byLocale, language);
      if (!plain(messages) || Object.keys(messages).sort().join('|') !== keys.join('|')) throw new TypeError('incomplete_locale_catalogue');
      const copy = Object.create(null);
      for (const key of keys) {
        const message = ownValue(messages, key);
        const original = ownValue(german, key);
        if (typeof message !== 'string' || !message.trim() || typeof original !== 'string'
          || placeholders(message).join('|') !== placeholders(original).join('|')) throw new TypeError('invalid_locale_message');
        copy[key] = message;
      }
      copies[language] = Object.freeze(copy);
    }
    catalogues.set(namespace, Object.freeze(copies));
  }
  function t(key, params = {}, language = locale) {
    const selected = validLocale(language) ? language : locale;
    if (!safeKey(key) || !plain(params)) return unavailable[selected];
    const split = key.indexOf('.');
    const template = split > 0 ? catalogues.get(key.slice(0, split))?.[selected]?.[key.slice(split + 1)] : undefined;
    if (typeof template !== 'string') return unavailable[selected];
    const required = placeholders(template);
    if (Object.keys(params).sort().join('|') !== required.join('|')) return unavailable[selected];
    const values = Object.create(null);
    for (const name of required) {
      const value = ownValue(params, name);
      if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)
        || (typeof value === 'number' && !Number.isFinite(value))) return unavailable[selected];
      values[name] = String(value);
    }
    // Text only: HTML-template callers must escape this result.
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name) => values[name]);
  }
  function translateDom(root = readDocument()) {
    if (!root) return;
    const nodes = [];
    if (root.matches?.(selector)) nodes.push(root);
    for (const node of root.querySelectorAll?.(selector) || []) nodes.push(node);
    for (const node of nodes) {
      if (node.hasAttribute?.('data-i18n')) {
        // Isolated labels only: never replace a parent containing controls or icons.
        if (!node.children?.length && !['INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE'].includes(node.tagName)) {
          node.textContent = t(node.getAttribute('data-i18n'));
        }
      }
      for (const [binding, attribute] of Object.entries(attributes)) {
        if (node.hasAttribute?.(binding)) node.setAttribute(attribute, t(node.getAttribute(binding)));
      }
    }
  }
  function setLocale(next, { persist = false } = {}) {
    if (!validLocale(next)) throw new TypeError('invalid_interface_language');
    const previous = locale;
    locale = next;
    const doc = readDocument();
    if (doc?.documentElement) {
      doc.documentElement.lang = next;
      doc.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    }
    if (persist) {
      try { readStorage()?.setItem(LOCALE_STORAGE_KEY, next); } catch { /* The live selection still works. */ }
    }
    translateDom(doc);
    if (previous !== next) for (const listener of [...listeners]) listener(next, previous);
    return next;
  }
  function subscribeLocale(listener) {
    if (typeof listener !== 'function') throw new TypeError('invalid_locale_listener');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function formatNumber(value, options = {}, language = locale) {
    if ((typeof value !== 'number' && typeof value !== 'bigint') || (typeof value === 'number' && !Number.isFinite(value))) return '—';
    return new Intl.NumberFormat(validLocale(language) ? language : locale, options).format(value);
  }
  function formatDate(value, options = {}, language = locale) {
    if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return '—';
    if (typeof value === 'string' && !value.trim()) return '—';
    if (typeof value === 'number' && !Number.isFinite(value)) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat(validLocale(language) ? language : locale, options).format(date);
  }
  return Object.freeze({ initialLocale, storedLocale, getLocale, setLocale, subscribeLocale, registerMessages, t, translateDom, formatNumber, formatDate });
}
const runtime = createLocaleRuntime();
export const { initialLocale, storedLocale, getLocale, setLocale, subscribeLocale, registerMessages, t, translateDom, formatNumber, formatDate } = runtime;
