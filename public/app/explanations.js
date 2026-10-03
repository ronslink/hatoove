import { getLocale } from '../assets/i18n/core.js';
import { pt, bindPracticeText, updatePracticeLocale } from '../assets/i18n/practice-messages.js';
/** Saved prose only. Language changes are reads; result facts belong to the parent view. */
export const EXPLANATION_LANGUAGES = ['de', 'en', 'uk', 'ar', 'tr'];
export const EXPLANATION_LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', uk: 'Українська', ar: 'العربية', tr: 'Türkçe' };
const states = ['original', 'translated', 'fallback', 'missing', 'not_assessed', 'blocked'];
const statuses = ['available', 'missing', 'pending', 'failed', 'blocked'];
const language = value => value === null || EXPLANATION_LANGUAGES.includes(value);
export function validExplanationView(value) {
  if (!value || value.schema !== 'explanation-view-v1' || !states.includes(value.state) || !statuses.includes(value.requested_status)
    || ![value.requested_language, value.original_language, value.displayed_language].every(language) || value.operation !== null) return false;
  if (value.state === 'not_assessed') return value.source === null && value.representation === null;
  if (value.state === 'blocked') return value.representation === null
    && (value.source === null || Boolean(value.source?.source_sha256))
    && (value.reason !== 'content_blocked' || value.source === null);
  if (value.representation === null) return value.state === 'missing';
  const blocks = value.representation?.payload?.blocks;
  return Boolean(value.source?.source_sha256 && value.representation.payload.schema === 'explanation-text-v1'
    && Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 44
    && blocks.every(row => typeof row.slot === 'string' && typeof row.text === 'string' && row.text.trim() && row.text.length <= 4000)
    && new Set(blocks.map(row => row.slot)).size === blocks.length);
}
const sourceKey = view => view?.source ? JSON.stringify(Object.entries(view.source).sort(([a], [b]) => a.localeCompare(b))) : null;

/** Pure generation boundary shared by every explanation card and exercised without a browser. */
export function createExplanationState({ view = null, requestedLanguage = null, read, isCurrent = () => true, onChange = () => {}, onConfirmed = () => {} }) {
  let confirmed = validExplanationView(view) ? view : null;
  let source = sourceKey(confirmed), wanted = requestedLanguage, epoch = 0, disposed = false, loading = false, error = false;
  const state = () => ({ view: confirmed, wanted, loading, error });
  const current = ticket => !disposed && ticket === epoch && isCurrent();
  const changed = () => { if (!disposed && isCurrent()) onChange(state()); };
  return { state,
    async select(next) {
      if (!language(next) || disposed || !isCurrent()) return false;
      wanted = next; const ticket = ++epoch; loading = true; error = false; changed();
      let response;
      try { response = await read(next); } catch { response = { ok: false }; }
      if (!current(ticket)) return false;
      loading = false;
      // A fresh authoritative parent refusal also redacts old result facts when its DTO has no item rows.
      if (response?.ok && response.parent?.blocked_reason) {
        confirmed = null;
        onConfirmed(response.parent);
        if (!current(ticket)) return false;
      }
      const candidate = response?.data, nextSource = sourceKey(candidate);
      if (!response?.ok || !validExplanationView(candidate) || (candidate.requested_language !== next && next !== null)
        || (source && nextSource && source !== nextSource)) { error = true; changed(); return false; }
      confirmed = candidate; source ||= nextSource; error = false;
      if (!response.parent?.blocked_reason) onConfirmed(response.parent);
      if (!current(ticket)) return false;
      changed(); return true;
    },
    dispose() { disposed = true; epoch++; },
  };
}

export function explanationStatus(view, locale = getLocale()) {
  const text = (key, parameters = {}) => pt(key, parameters, locale);
  if (!view) return text('expNotLoaded');
  if (view.state === 'blocked') return text('expBlocked');
  if (view.state === 'not_assessed') return text(view.reason === 'assessment_failed' ? 'expFailed' : 'expUnassessed');
  if (view.state === 'missing') return text('expMissing');
  const actual = EXPLANATION_LANGUAGE_NAMES[view.displayed_language] || text('unknownLanguage');
  const shown = text(view.state === 'translated' ? 'expTranslated' : 'expOriginal', {language: actual});
  if (view.state !== 'fallback') return shown;
  return text(({pending:'expPending',failed:'expTranslationFailed',blocked:'expTranslationBlocked',missing:'expTranslationMissing'})[view.requested_status] || 'expTranslationMissing') + ' ' + shown;
}
const reviewLabel = (name, review, locale = getLocale()) => pt(name,{},locale) + ': ' + pt(({approved:'approved',unreviewed:'pendingReview',rejected:'rejected',withdrawn:'withdrawnReview',unavailable:'unavailable'})[review?.review_status] || 'notSpecified',{},locale);
const reviewText = (value,locale=getLocale()) => reviewLabel('educationalReview',value.review?.educational,locale) + ' · ' + reviewLabel('nativeReview',value.review?.native_language,locale);

/** One manager owns speech/disposal; each card owns its own request generation and immutable source. */
export function createExplanationManager({ readAloud = null, getLanguage = () => null, getContext = () => '', doc = globalThis.document } = {}) {
  const cards = new Set(); let sequence = 0;
  function dispose(container = null) {
    for (const card of [...cards]) if (!container || !card.host.isConnected || container === card.host || container.contains(card.host)) {
      card.model.dispose(); readAloud?.clear(card.host); card.host.replaceChildren(); cards.delete(card);
    }
  }
  function mount(host, { view = null, read, labels = {}, isCurrent = () => true, onConfirmed = () => {} }) {
    if (!host) return null;
    dispose(host); const context = getContext(), id = 'explanation-language-' + (++sequence);
    const card = { host, model: null, status: null, review: null };
    const current = () => host.isConnected && getContext() === context && isCurrent();
    const node = (tag, text, className) => { const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
    const ui = (tag,key,className) => { const value = node(tag,undefined,className); bindPracticeText(value,key); return value; };
    function render(snapshot) {
      if (!current()) return;
      const keepFocus = host.contains(doc.activeElement) && doc.activeElement?.hasAttribute('data-explanation-language');
      readAloud?.clear(host); host.replaceChildren(); host.className = 'explanation-view stack'; host.lang = getLocale(); host.dir = getLocale() === 'ar' ? 'rtl' : 'ltr';
      host.dataset.explanationState = snapshot.view?.state || 'loading'; host.dataset.displayedLanguage = snapshot.view?.displayed_language || '';
      const controls = node('div', undefined, 'explanation-controls'), label = ui('label', 'expLanguage', 'field-label'), select = node('select', undefined, 'select');
      label.htmlFor = id; select.id = id; select.dataset.explanationLanguage = '';
      for (const lang of EXPLANATION_LANGUAGES) { const option = node('option', EXPLANATION_LANGUAGE_NAMES[lang]); option.value = lang; option.lang = lang; option.dir = lang === 'ar' ? 'rtl' : 'ltr'; select.append(option); }
      select.value = snapshot.wanted || snapshot.view?.displayed_language || 'de'; select.onchange = () => { readAloud?.stop(); void card.model.select(select.value); };
      controls.append(label, select); host.append(controls);
      if (keepFocus) select.focus({ preventScroll: true });
      const status = node('p', explanationStatus(snapshot.view), 'small muted explanation-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); host.append(status); card.status = status; card.review = null;
      if (snapshot.loading) host.append(ui('p', 'expLoading', 'small muted'));
      if (snapshot.error) {
        host.append(ui('p', 'expReadFailed', 'err'));
        const retry = ui('button', 'expRetry', 'btn btn-small'); retry.type = 'button'; retry.dataset.explanationRetry = ''; retry.onclick = () => { readAloud?.stop(); void card.model.select(card.model.state().wanted); }; host.append(retry);
      }
      const value = snapshot.view;
      if (value?.representation) {
        if (value.representation.provenance_kind === 'builtin-simulation-dictionary') host.append(ui('p', 'simulation', 'hint'));
        card.review = node('p',reviewText(value),'small muted'); host.append(card.review);
        for (const block of value.representation.payload.blocks) {
          const section = node('div', undefined, 'explanation-block'), headingKey = block.slot.startsWith('correction/') ? 'correctionHint' : 'explanation', heading = labels[block.slot] || pt(headingKey);
          const title = labels[block.slot] ? node('p',heading,'explanation-block-label') : ui('p',headingKey,'explanation-block-label');
          if (labels[block.slot]) { title.lang = 'de'; title.dir = 'ltr'; }
          section.append(title);
          const prose = node('p', block.text, 'explanation-prose'); prose.dataset.explanationSlot = block.slot; prose.lang = value.displayed_language || ''; prose.dir = value.displayed_language === 'ar' ? 'rtl' : 'ltr'; section.append(prose); host.append(section);
          if (value.displayed_language) readAloud?.mount(prose, { label: heading, labelKey: labels[block.slot] ? null : headingKey, language: value.displayed_language });
        }
        if (!value.displayed_language) host.append(ui('p', 'unknownSpeech', 'small muted'));
      }
    }
    card.model = createExplanationState({ view, requestedLanguage: getLanguage(), read, isCurrent: current, onChange: render, onConfirmed });
    cards.add(card); render(card.model.state());
    if (!validExplanationView(view) || view.requested_language !== getLanguage()) void card.model.select(getLanguage());
    return card.model;
  }
  function updateLocale(locale = getLocale()) {
    for (const card of cards) {
      if (!card.host.isConnected) continue;
      card.host.lang = locale; card.host.dir = locale === 'ar' ? 'rtl' : 'ltr';
      updatePracticeLocale(card.host,locale);
      const value = card.model.state().view;
      if (card.status?.isConnected) card.status.textContent = explanationStatus(value,locale);
      if (card.review?.isConnected && value) card.review.textContent = reviewText(value,locale);
    }
  }
  return { mount, dispose, updateLocale, refresh(language = getLanguage()) { readAloud?.stop(); for (const card of [...cards]) { if (!card.host.isConnected) dispose(card.host); else void card.model.select(language); } } };
}
