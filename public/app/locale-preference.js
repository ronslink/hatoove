import { t, getLocale, validLocale, translateDom } from '../assets/i18n/core.js';
import { shellMessages } from '../assets/i18n/shell-messages.js';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const knownMessages = new Map();
for (const messages of Object.values(shellMessages)) for (const [key, value] of Object.entries(messages)) knownMessages.set(value, key);
export const s = (key, parameters = {}, locale = getLocale()) => t('shell.' + key, parameters, locale);
/** Only explicitly supplied UI copy participates; authored content is never looked up. */
export function messageMarkup(keyOrText, parameters = {}) {
  const key = Object.hasOwn(shellMessages.de, keyOrText) ? keyOrText : knownMessages.get(keyOrText);
  if (!key) return escapeText(keyOrText);
  return '<span lang="' + getLocale() + '" dir="' + (getLocale() === 'ar' ? 'rtl' : 'ltr') + '" data-shell-message="' + key + '" data-shell-parameters="' + escapeText(JSON.stringify(parameters)) + '">' + escapeText(s(key, parameters)) + '</span>';
}

const textBindings = new Map();
/** State changes may replace a label; locale changes update its one declared Text node only. */
export function bindShellText(node, read) {
  if (!node) return;
  const value = String(read() ?? '');
  node.removeAttribute?.('data-i18n');
  node.textContent = value;
  textBindings.set(node, { text: node.firstChild, read });
  return value;
}
export function updateShellMessages(root = globalThis.document) {
  if (!root) return;
  translateDom(root);
  for (const node of root.querySelectorAll('[data-i18n], [data-shell-message]')) {
    node.lang = getLocale(); node.dir = getLocale() === 'ar' ? 'rtl' : 'ltr';
  }
  for (const node of root.querySelectorAll('[data-shell-message]')) {
    try { node.textContent = s(node.dataset.shellMessage, JSON.parse(node.dataset.shellParameters || '{}')); }
    catch { /* Invalid metadata cannot change or reveal content. */ }
  }
  for (const [node, binding] of textBindings) {
    if (!node.isConnected || !binding.text || binding.text.parentNode !== node) { textBindings.delete(node); continue; }
    if (root !== globalThis.document && node !== root && !root.contains?.(node)) continue;
    binding.text.data = String(binding.read() ?? '');
  }
  for (const node of root.querySelectorAll('[data-authored-alternative]')) node.hidden = node.dataset.authoredAlternative !== getLocale();
}
export function setShellHTML(node, markup) {
  if (!node) return;
  textBindings.delete(node);
  node.innerHTML = markup;
  updateShellMessages(node);
}

/** One owner-bound CAS, followed only by a read when the response is uncertain or conflicts. */
export function createLocalePreference({ read, write, context, confirmed, accept, changed = () => {} }) {
  let busy = false, unresolved = false, sequence = 0, status = 'idle';
  const current = (ticket, serial) => ticket === context() && serial === sequence;
  const valid = result => result?.ok && Number.isInteger(result.data?.revision) && result.data.revision >= (confirmed()?.revision ?? 0) && validLocale(result.data.settings?.language);
  const publish = state => { status = state; changed({ state, busy, unresolved }); };
  async function reconcile(ticket = context(), serial = ++sequence, cause = 'unknown') {
    busy = true; publish('reconciling');
    let result;
    try { result = await read(); } catch { result = null; }
    if (!current(ticket, serial)) return false;
    busy = false;
    if (!valid(result)) { unresolved = true; publish('unresolved'); return false; }
    unresolved = false; accept(result.data, { persist: false }); publish(cause === 'conflict' ? 'conflict' : 'reconciled');
    return true;
  }
  return {
    get busy() { return busy; }, get unresolved() { return unresolved; }, get status() { return status; },
    cancel() { sequence++; busy = false; unresolved = false; },
    suspend() { sequence++; busy = false; unresolved = true; publish('unresolved'); },
    reconcile() { if (busy) return Promise.resolve(false); return reconcile(); },
    async save(language) {
      if (busy || unresolved || !validLocale(language)) return false;
      const value = confirmed(), ticket = context(), serial = ++sequence;
      if (!value || !Number.isInteger(value.revision)) return false;
      if (value.settings?.language === language) { publish('saved'); return true; }
      busy = true; publish('saving');
      let result;
      try { result = await write(value.revision, { language }); } catch { result = { status: 0 }; }
      if (!current(ticket, serial)) return false;
      if (valid(result)) { busy = false; unresolved = false; accept(result.data, { persist: true }); publish('saved'); return true; }
      if (result?.ok || result?.status === 409 || !result || result.status === 0 || result.status >= 500) {
        await reconcile(ticket, serial, result?.status === 409 ? 'conflict' : 'unknown');
        return false;
      }
      busy = false; publish('failed'); return false;
    },
  };
}
