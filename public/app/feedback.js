/**
 * PILOT-FEEDBACK-01 (slice FB-C) — ONE "Problem melden" entry point for the whole app.
 *
 * Ron's decision: no button on individual questions. The same sheet is opened from the top bar and from
 * Werkzeuge, over whatever page the learner is on, and it also takes general notes — which is why the category
 * list ends in "Idee" and "Sonstiges" rather than only faults.
 *
 * THE TWO RULES THIS FILE EXISTS TO KEEP.
 *
 * 1. OPENING OR SENDING MUST NEVER NAVIGATE, RESET THE PAGE OR INTERRUPT AUDIO. That is the 5 October incident:
 *    a per-question form whose mount re-rendered the run and flushed the listening controller mid-recording.
 *    So this module touches NOTHING but its own dialog — it never changes `location`, never re-renders a view,
 *    never calls into the listening controller, and holds no reference to the run state. It is installed once,
 *    after boot, and thereafter only shows and hides one element it owns.
 *
 * 2. IT IS A SHELL AFFORDANCE, NOT A VIEW. There is no route and no `MODULE_VIEWS` entry: the sheet opens over
 *    the current page. Installing it on `boot()`'s success path is also what makes "on every signed-in view and
 *    on no public page" true — the public pages are separate documents that never load `app.js`.
 *
 * CONTEXT IS READ WITHOUT RE-RENDERING. A part exposes immutable exam/set ids; the visible item adds its id.
 * Views without this metadata still report their route. The server drops stale context without losing a report.
 * The context line names the view, and × removes both the route and captured ids from the request.
 */

import { capturePreview } from './screenshot.js';
export { renderSurvey } from './survey.js';

const CATEGORY_KEYS = Object.freeze([
  ['content_error', 'feedbackCatContent'],
  ['audio', 'feedbackCatAudio'],
  ['translation', 'feedbackCatTranslation'],
  ['bug', 'feedbackCatBug'],
  ['idea', 'feedbackCatIdea'],
  ['other', 'feedbackCatOther'],
]);

const BODY_MAX = 2000;
const FOCUSABLE = 'button:not([disabled]), select, textarea, input, a[href]';
/** Read immutable ids from the visible view without asking it to render or changing its state. */
export function visibleFeedbackContext(doc = document) {
  const node = [...doc.querySelectorAll('#main [data-feedback-context]')]
    .find(n => n.getBoundingClientRect().height > 0);
  if (!node) return {};
  let context;
  try { context = JSON.parse(node.dataset.feedbackContext); } catch { return {}; }
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  const result = {};
  for (const key of ['examId','setId','version','runId','guideId','sectionId']) {
    if (typeof context[key] === 'string') result[key] = context[key];
  }
  const item = [...node.querySelectorAll('[data-item-id]')].find(n => {
    const box = n.getBoundingClientRect(); return box.height > 0 && box.bottom > 0 && box.top < doc.defaultView.innerHeight;
  });
  if (item) result.itemId = item.dataset.itemId;
  return result;
}

/** The sheet's own element, built once. */
function buildSheet({ uiText, esc }) {
  const wrap = document.createElement('div');
  wrap.className = 'feedback-scrim';
  wrap.hidden = true;

  const options = CATEGORY_KEYS.map(([value, key]) =>
    `<label class="feedback-category"><input type="radio" name="feedback-category" value="${esc(value)}">`
    + `<span>${esc(uiText(key))}</span></label>`).join('');

  wrap.innerHTML =
    `<div class="feedback-sheet card" role="dialog" aria-modal="true" aria-labelledby="feedback-title">`
    + `<h2 id="feedback-title">${esc(uiText('feedbackOpen'))}</h2>`
    + `<form class="stack" id="feedback-form" novalidate>`
    + `<fieldset class="feedback-categories"><legend>${esc(uiText('feedbackCategory'))}</legend>${options}</fieldset>`
    + `<div class="field"><label for="feedback-body">${esc(uiText('feedbackDescription'))}</label>`
    + `<textarea class="input" id="feedback-body" rows="5" maxlength="${BODY_MAX}" `
    + `placeholder="${esc(uiText('feedbackDescriptionHint'))}"></textarea></div>`
    + `<p class="feedback-context small muted" id="feedback-context"></p>`
    + `<div id="feedback-screenshot" class="feedback-screenshot" hidden>`
    + `<img id="feedback-preview" alt="${esc(uiText('feedbackScreenshotPreview'))}">`
    + `<label><input id="feedback-attach" type="checkbox" checked> ${esc(uiText('feedbackAttachScreenshot'))}</label>`
    + `<p class="small muted">${esc(uiText('feedbackScreenshotPrivacy'))}</p>`
    + `<button type="button" class="btn btn-small" id="feedback-remove-screenshot">${esc(uiText('feedbackRemoveScreenshot'))}</button></div>`
    + `<p class="feedback-message" id="feedback-message" role="alert" hidden></p>`
    + `<div class="row feedback-actions"><button type="submit" class="btn btn-primary" id="feedback-send">`
    + `${esc(uiText('feedbackSend'))}</button>`
    + `<button type="button" class="btn" id="feedback-close">${esc(uiText('feedbackClose'))}</button></div>`
    + `</form></div>`;
  return wrap;
}

/**
 * The sheet. `route()` returns the view id the learner is on; `api` is the client port.
 * Returns `{ open, close, isOpen, unmount }` — deliberately small, because everything else the caller wants
 * (focus, the context line, the error text) is the sheet's business, not the shell's.
 */
export function createFeedbackSheet({ api, uiText, esc, route, routeLabel = route, onSent = null, capture = capturePreview }) {
  let sheet = null;
  let invoker = null;
  let contextKept = true;
  let attachment = null;
  let savedReportId = null;
  let sourceRoute = null;
  let sourceLabel = null;
  let sourceContext = {};
  let opening = false;
  let openGeneration = 0;

  function ensure() {
    if (sheet && sheet.dataset.locale !== document.documentElement.lang) {
      document.removeEventListener('keydown', onKeydown);
      sheet.remove();
      sheet = null;
    }
    if (!sheet) {
      sheet = buildSheet({ uiText, esc });
      sheet.dataset.locale = document.documentElement.lang;
      document.body.append(sheet);
      sheet.querySelector('#feedback-close').addEventListener('click', () => close());
      sheet.querySelector('#feedback-form').addEventListener('submit', onSubmit);
      /*
       * ONE CLICK HANDLER, INSTALLED ONCE, that obeys the button's current MODE. The first version added a
       * `{ once: true }` close listener after a successful send — and if the learner closed the sheet with Escape
       * instead of clicking it, that listener SURVIVED INTO THE NEXT SESSION and closed the sheet on the first
       * click after sending. Mode is data on the button, not a listener that may or may not have fired.
       */
      sheet.querySelector('#feedback-send').addEventListener('click', (event) => {
        const mode = sheet.querySelector('#feedback-send').dataset.mode;
        if (!mode) return;
        event.preventDefault();
        if (mode === 'retry-upload') void finishSavedReport();
        else close();
      });
      sheet.querySelector('#feedback-remove-screenshot').addEventListener('click', () => {
        attachment = null;
        sheet.querySelector('#feedback-preview').removeAttribute('src');
        sheet.querySelector('#feedback-screenshot').hidden = true;
        if (savedReportId) void finishSavedReport();
      });
      sheet.addEventListener('mousedown', (event) => { if (event.target === sheet) close(); });
      document.addEventListener('keydown', onKeydown);
    }
    return sheet;
  }

  /** A modal dialog is not modal if Tab walks out of it; wrap within the sheet's own focusables. */
  function onKeydown(event) {
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function reset() {
    const form = sheet.querySelector('#feedback-form');
    form.reset();
    const message = sheet.querySelector('#feedback-message');
    message.hidden = true;
    message.textContent = '';
    const send = sheet.querySelector('#feedback-send');
    send.disabled = false;
    send.textContent = uiText('feedbackSend');
    /*
     * THE BUTTON MUST GO BACK TO BEING A SUBMIT BUTTON. After a successful send it is switched to
     * `type="button"` so a second click closes the sheet instead of filing the same report twice — and nothing
     * put it back, so a learner who had sent one report could never send another without reloading the page. A
     * `type="button"` does not submit its form, so `reset()` alone looked like it had restored the sheet.
     */
    send.type = 'submit';
    delete send.dataset.mode;
    contextKept = true;
    attachment = null;
    savedReportId = null;
    sheet.querySelector('#feedback-screenshot').hidden = true;
    sheet.querySelector('#feedback-preview').removeAttribute('src');
    form.querySelector('fieldset').disabled = false;
    sheet.querySelector('#feedback-remove-screenshot').disabled = false;
    sheet.querySelector('#feedback-attach').disabled = false;
    sheet.querySelector('#feedback-body').disabled = false;
    renderContext();
  }

  /**
   * The context line: what will be sent along with the report, and an × that removes it. It names the VIEW,
   * because that is what the shell knows — see the honest limit at the top of this file.
   */
  function renderContext() {
    const node = sheet.querySelector('#feedback-context');
    const view = sourceLabel || sourceRoute;
    if (!contextKept || !view) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false;
    node.innerHTML = `${esc(uiText('feedbackContext'))} <span class="feedback-context-value">${esc(view)}</span> `
      + `<button type="button" class="feedback-context-remove" id="feedback-context-remove" `
      + `aria-label="${esc(uiText('feedbackClose'))}">×</button>`;
    node.querySelector('#feedback-context-remove').addEventListener('click', () => {
      contextKept = false;
      renderContext();
      sheet.querySelector('#feedback-send').focus();
    });
  }

  function chosenCategory() {
    const picked = sheet.querySelector('input[name="feedback-category"]:checked');
    return picked ? picked.value : null;
  }

  async function onSubmit(event) {
    event.preventDefault();
    const ticket = openGeneration;
    if (savedReportId) return finishSavedReport();
    const message = sheet.querySelector('#feedback-message');
    const body = String(sheet.querySelector('#feedback-body').value || '').trim();
    const category = chosenCategory();
    if (!category || !body) {
      message.hidden = false;
      message.textContent = uiText('feedbackIncomplete');
      (category ? sheet.querySelector('#feedback-body') : sheet.querySelector('input[name="feedback-category"]')).focus();
      return;
    }
    const send = sheet.querySelector('#feedback-send');
    send.disabled = true;
    message.hidden = true;
    let answer;
    try { answer = await api.feedback.create({
      /*
       * THE × MUST ACTUALLY REMOVE SOMETHING. `contextKept` was a display flag only: the × hid the context line
       * and the submit still sent `route()`, so a learner who removed the context still filed a report naming the
       * view they were on. Removing it now sends `other`, which is the honest answer — the report is filed, and
       * the server is not told which page it came from.
       */
      category, body, route: (contextKept && sourceRoute) || 'other',
      context: contextKept ? sourceContext : {},
      /* The INTERFACE language, which only the browser knows (A8); the server validates and defaults it. */
      interfaceLanguage: document.documentElement.lang || 'de',
    }); } catch { answer = { ok: false }; }
    if (ticket !== openGeneration || !isOpen()) return;
    if (answer && answer.ok) {
      savedReportId = answer.data?.feedback_id;
      sheet.querySelector('fieldset').disabled = true;
      sheet.querySelector('#feedback-body').disabled = true;
      // The Konto list is behind the sheet, so refresh it rather than making the learner reload the page to see
      // the report they just sent.
      if (typeof onSent === 'function') onSent();
      return finishSavedReport();
    }
    send.disabled = false;
    message.hidden = false;
    message.textContent = uiText('feedbackFailed');
    message.focus?.();
  }

  async function finishSavedReport() {
    const ticket = openGeneration;
    const send = sheet.querySelector('#feedback-send');
    const message = sheet.querySelector('#feedback-message');
    send.disabled = true;
    let upload = null;
    const remove = sheet.querySelector('#feedback-remove-screenshot');
    const attach = sheet.querySelector('#feedback-attach');
    remove.disabled = true;
    attach.disabled = true;
    if (attachment && sheet.querySelector('#feedback-attach').checked) {
      try { upload = await api.feedback.uploadScreenshot(savedReportId, attachment.blob); }
      catch { upload = { ok: false }; }
    }
    if (ticket !== openGeneration || !isOpen()) return;
    message.hidden = false;
    send.disabled = false;
    send.type = 'button';
    if (upload && !upload.ok && upload.error !== 'screenshot_exists') {
      remove.disabled = false;
      attach.disabled = false;
      message.className = 'feedback-message';
      message.textContent = uiText('feedbackScreenshotFailed');
      send.textContent = uiText('feedbackRetryScreenshot');
      send.dataset.mode = 'retry-upload';
    } else {
      attachment = null;
      message.className = 'feedback-message feedback-thanks';
      message.textContent = uiText('feedbackThanks');
      send.textContent = uiText('feedbackClose');
      send.dataset.mode = 'close';
    }
  }

  function isOpen() { return Boolean(sheet && !sheet.hidden); }

  async function open(opener) {
    if (opening || isOpen()) return;
    opening = true;
    const ticket = ++openGeneration;
    ensure();
    invoker = opener || document.activeElement;
    sourceRoute = route();
    sourceLabel = routeLabel();
    sourceContext = visibleFeedbackContext();
    const captureLocale = document.documentElement.lang;
    reset();
    try { attachment = await capture(); } catch { attachment = null; }
    if (ticket !== openGeneration) return;
    if (captureLocale !== document.documentElement.lang || sourceRoute !== route()
      || JSON.stringify(sourceContext) !== JSON.stringify(visibleFeedbackContext())) {
      close();
      return;
    }
    opening = false;
    if (attachment) {
      sheet.querySelector('#feedback-preview').src = attachment.previewUrl;
      sheet.querySelector('#feedback-screenshot').hidden = false;
    } else {
      const message = sheet.querySelector('#feedback-message');
      message.hidden = false;
      message.textContent = uiText('feedbackCaptureFailed');
    }
    sheet.hidden = false;
    document.documentElement.classList.add('feedback-open');
    const first = sheet.querySelector('input[name="feedback-category"]');
    if (first) first.focus();
  }

  function close() {
    openGeneration++;
    opening = false;
    if (!sheet) return;
    sheet.hidden = true;
    document.documentElement.classList.remove('feedback-open');
    /* Focus RETURNS to the button that opened the sheet: a dialog that drops focus to the body loses a
       keyboard learner's place, and the contract asks for this explicitly. */
    if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) invoker.focus();
    invoker = null;
    attachment = null;
    sheet.querySelector('#feedback-preview').removeAttribute('src');
  }

  function unmount() {
    openGeneration++;
    opening = false;
    if (!sheet) return;
    document.removeEventListener('keydown', onKeydown);
    sheet.remove();
    sheet = null;
    document.documentElement.classList.remove('feedback-open');
  }

  return { open, close, isOpen, unmount };
}

/** The UI word for each stored status. A status the client does not know falls back to "new" rather than blank. */
const STATUS_KEYS = Object.freeze({
  new: 'feedbackStatusNew',
  triaged: 'feedbackStatusInProgress',
  fixed: 'feedbackStatusFixed',
  wontfix: 'feedbackStatusWontfix',
});

/**
 * "Meine Meldungen" — the learner's own reports with a status chip, in Konto.
 *
 * THE BODY IS RENDERED AS TEXT, through `esc`, and never as HTML. The learner wrote it, so it is the one string
 * in this feature that must be treated as hostile: a report containing `<img onerror=...>` is data about a
 * problem, not markup.
 */
export async function renderMyReports({ api, uiText, esc }) {
  const host = document.getElementById('feedback-mine');
  if (!host) return false;
  const answer = await api.feedback.list();
  if (!answer || !answer.ok) {
    host.textContent = uiText('feedbackMineFailed');
    return false;
  }
  const rows = (answer.data && answer.data.feedback) || [];
  if (!rows.length) {
    host.textContent = uiText('feedbackMineEmpty');
    return true;
  }
  host.innerHTML = '<ul class="feedback-list">' + rows.map((row) =>
    '<li class="feedback-item">'
    + '<p class="feedback-item-head">'
    + `<span class="feedback-chip" data-status="${esc(row.status)}">`
    + `${esc(uiText(STATUS_KEYS[row.status] || 'feedbackStatusNew'))}</span>`
    + `<span class="small muted">${esc(String(row.created_at || '').slice(0, 10))}</span></p>`
    + `<p class="feedback-item-body">${esc(row.body)}</p>`
    + '</li>').join('') + '</ul>';
  return true;
}

/**
 * Wire the two openers and the Konto list. Called once, after boot; a missing element is not fatal, so a shell
 * change can never take the whole app down through this feature.
 */
export function installFeedbackEntryPoints(ctx) {
  /* A rejected refresh would otherwise surface as an unhandled rejection on the shell's own boot path. */
  const refresh = () => { renderMyReports(ctx).catch(() => {}); };
  const sheet = createFeedbackSheet({ ...ctx, onSent: refresh });
  const wire = (id) => {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', (event) => { event.preventDefault(); void sheet.open(node); });
    return Boolean(node);
  };
  const topBar = wire('feedback-open');
  const sidebar = wire('feedback-open-side');
  refresh();
  return { sheet, topBar, sidebar, refresh };
}
