import assert from 'node:assert/strict';
import { createLocaleRuntime, LOCALES, LANGUAGE_NAMES, LOCALE_STORAGE_KEY, validLocale } from '../public/assets/i18n/core.js';
import { commonMessages } from '../public/assets/i18n/common.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const make = (extra = {}) => createLocaleRuntime({ readStorage: () => null, readNavigator: () => null, readDocument: () => null, ...extra });
const dictionary = () => Object.fromEntries(LOCALES.map(locale => [locale, { label: `${locale} label`, count: `${locale} {count}`, unsafe: `${locale} {text}` }]));

check('exact supported enum and native labels', () => {
  assert.deepEqual(Object.keys(LANGUAGE_NAMES), [...LOCALES]);
  for (const locale of LOCALES) assert.equal(validLocale(locale), true);
  for (const value of ['DE', 'ar-EG', '', null, {}, ['de'], '__proto__']) assert.equal(validLocale(value), false);
});
check('only the guest locale scalar is read, and explicit selection alone writes it', () => {
  const reads = [], writes = [], navigator = { languages: ['fr-FR', 'UK-UA'] };
  let saved = 'en';
  const runtime = make({ readStorage: () => ({ getItem: key => { reads.push(key); return saved; }, setItem: (...args) => writes.push(args) }), readNavigator: () => navigator });
  assert.equal(runtime.getLocale(), 'en'); assert.deepEqual(writes, []);
  runtime.setLocale('ar'); assert.deepEqual(writes, []);
  runtime.setLocale('tr', { persist: true }); assert.deepEqual(writes, [[LOCALE_STORAGE_KEY, 'tr']]);
  assert.ok(reads.every(key => key === LOCALE_STORAGE_KEY));
  saved = '{"owner":"private","language":"de"}';
  assert.equal(runtime.initialLocale(), 'uk');
  assert.equal(runtime.getLocale(), 'tr', 'reading a candidate does not override the live confirmed preference');
});
check('denied or malformed storage and unsupported browser languages retain a usable default', () => {
  const unavailable = () => { throw new Error('denied'); };
  const runtime = make({ readStorage: unavailable, readNavigator: () => ({ languages: ['fr'] }) });
  assert.equal(runtime.getLocale(), 'de');
  assert.doesNotThrow(() => runtime.setLocale('uk', { persist: true }));
  assert.equal(runtime.getLocale(), 'uk');
  assert.equal(make({ readNavigator: unavailable }).getLocale(), 'de');
  assert.throws(() => runtime.setLocale('en-GB'), /invalid_interface_language/);
  assert.equal(runtime.getLocale(), 'uk');
});
check('catalogues are complete immutable snapshots with exact placeholder parity', () => {
  const runtime = make(), messages = dictionary();
  runtime.registerMessages('demo', messages);
  messages.en.label = 'changed';
  assert.equal(runtime.t('demo.label', {}, 'en'), 'en label');
  assert.equal(runtime.t('demo.count', { count: 0 }, 'tr'), 'tr 0');
  assert.throws(() => runtime.registerMessages('demo', dictionary()), /duplicate_locale_namespace/);
  const missing = dictionary(); delete missing.uk.label;
  assert.throws(() => make().registerMessages('demo', missing), /incomplete_locale_catalogue/);
  const renamed = dictionary(); renamed.ar.count = '{different}';
  assert.throws(() => make().registerMessages('demo', renamed), /invalid_locale_message/);
  const extra = dictionary(); extra.fr = extra.en;
  assert.throws(() => make().registerMessages('demo', extra), /incomplete_locale_catalogue/);
});
check('unsafe keys, getters, object conversion and missing parameters never become executable text', () => {
  const runtime = make(); runtime.registerMessages('demo', dictionary());
  const fallback = runtime.t('missing.key');
  for (const key of ['__proto__.label', 'demo.constructor', 'demo.label<script>', 'demo']) assert.equal(runtime.t(key), fallback);
  let calls = 0;
  const accessor = {}; Object.defineProperty(accessor, 'text', { enumerable: true, get() { calls++; return 'secret'; } });
  assert.equal(runtime.t('demo.unsafe', accessor), fallback);
  assert.equal(runtime.t('demo.unsafe', { text: { toString() { calls++; return 'secret'; } } }), fallback);
  assert.equal(runtime.t('demo.count', { count: Infinity }), fallback);
  assert.equal(runtime.t('demo.count', {}), fallback);
  assert.equal(runtime.t('demo.label', { extra: 'private' }), fallback);
  assert.equal(calls, 0);
  assert.equal(runtime.t('demo.unsafe', { text: '<img onerror=evil()>' }), 'de <img onerror=evil()>', 'lookup returns text, not interpreted markup');
  const catalogue = dictionary(); Object.defineProperty(catalogue.de, 'label', { enumerable: true, get() { calls++; return 'secret'; } });
  assert.throws(() => make().registerMessages('demo', catalogue), /invalid_locale_message/);
  assert.equal(calls, 0);
});

function node(tagName, bindings, children = []) {
  const attributes = new Map(Object.entries(bindings));
  return { tagName, children, textContent: 'original', value: 'unsaved draft', matches: () => true,
    hasAttribute: key => attributes.has(key), getAttribute: key => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value), querySelectorAll: () => [], attributes };
}
check('explicit DOM bindings preserve live controls, nested icons and unbound exam text', () => {
  const label = node('SPAN', { 'data-i18n': 'demo.label' });
  const icon = node('SVG', {}), parent = node('BUTTON', { 'data-i18n': 'demo.label', 'data-i18n-aria-label': 'demo.label' }, [icon]);
  const input = node('INPUT', { 'data-i18n': 'demo.label', 'data-i18n-placeholder': 'demo.label' });
  const textarea = node('TEXTAREA', { 'data-i18n': 'demo.label' });
  const option = node('OPTION', { 'data-i18n': 'demo.label' });
  const exam = node('P', {});
  const doc = { documentElement: {}, querySelectorAll: () => [label, parent, input, textarea, option] };
  const runtime = make({ readDocument: () => doc }); runtime.registerMessages('demo', dictionary());
  runtime.setLocale('ar');
  assert.deepEqual(doc.documentElement, { lang: 'ar', dir: 'rtl' });
  assert.equal(label.textContent, 'ar label'); assert.equal(option.textContent, 'ar label');
  assert.equal(parent.textContent, 'original'); assert.equal(parent.children[0], icon);
  assert.equal(parent.attributes.get('aria-label'), 'ar label');
  assert.equal(input.value, 'unsaved draft'); assert.equal(input.textContent, 'original');
  assert.equal(input.attributes.get('placeholder'), 'ar label');
  assert.equal(textarea.value, 'unsaved draft'); assert.equal(textarea.textContent, 'original');
  assert.equal(exam.textContent, 'original');
  runtime.setLocale('de'); assert.equal(doc.documentElement.dir, 'ltr');
});
check('locale subscriptions are deduplicated, removable and silent for identical selections', () => {
  const runtime = make(), seen = [], listener = (...args) => seen.push(args);
  const remove = runtime.subscribeLocale(listener); runtime.subscribeLocale(listener);
  runtime.setLocale('en'); runtime.setLocale('en');
  assert.deepEqual(seen, [['en', 'de']]);
  remove(); runtime.setLocale('ar'); assert.equal(seen.length, 1);
});
check('date and number formatting use the requested locale without inventing unknown values', () => {
  const runtime = make();
  for (const locale of LOCALES) {
    assert.equal(runtime.formatNumber(1234.5, {}, locale), new Intl.NumberFormat(locale).format(1234.5));
    assert.equal(runtime.formatDate('2026-10-03T12:00:00Z', { timeZone: 'UTC' }, locale), new Intl.DateTimeFormat(locale, { timeZone: 'UTC' }).format(new Date('2026-10-03T12:00:00Z')));
  }
  for (const value of [null, undefined, {}, '', 'not a date', NaN]) assert.equal(runtime.formatDate(value), '—');
  for (const value of [null, undefined, '12', NaN, Infinity]) assert.equal(runtime.formatNumber(value), '—');
});
check('all shared strings have five-language key and parameter coverage', () => {
  const runtime = make(); runtime.registerMessages('common', commonMessages);
  for (const locale of LOCALES) for (const key of Object.keys(commonMessages.de)) assert.equal(runtime.t(`common.${key}`, {}, locale), commonMessages[locale][key]);
});
console.log(`Interface locale core: ${passed} checks passed.`);
