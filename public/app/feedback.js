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
 * HONEST LIMIT, so a reviewer is not left to find it. The report carries `route` (the view the learner was on)
 * because the shell knows that for free. The richer context the contract describes — the open part or run, and
 * the question in view — is NOT captured yet: it needs the shell to expose the current item, which no view does
 * today. The server accepts an absent context and the report is unaffected, and its drop rule means a stale
 * value can never cost the learner their report. The context line still names the view, and × removes it.
 */

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
export function createFeedbackSheet({ api, uiText, esc, route }) {
  let sheet = null;
  let invoker = null;
  let contextKept = true;

  function ensure() {
    if (!sheet) {
      sheet = buildSheet({ uiText, esc });
      document.body.append(sheet);
      sheet.querySelector('#feedback-close').addEventListener('click', () => close());
      sheet.querySelector('#feedback-form').addEventListener('submit', onSubmit);
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
    contextKept = true;
    renderContext();
  }

  /**
   * The context line: what will be sent along with the report, and an × that removes it. It names the VIEW,
   * because that is what the shell knows — see the honest limit at the top of this file.
   */
  function renderContext() {
    const node = sheet.querySelector('#feedback-context');
    const view = route();
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
    const answer = await api.feedback.create({
      category, body, route: route() || 'other',
      /* The INTERFACE language, which only the browser knows (A8); the server validates and defaults it. */
      interfaceLanguage: document.documentElement.lang || 'de',
    });
    if (answer && answer.ok) {
      message.hidden = false;
      message.className = 'feedback-message feedback-thanks';
      message.textContent = uiText('feedbackThanks');
      send.textContent = uiText('feedbackClose');
      send.disabled = false;
      send.type = 'button';
      send.addEventListener('click', () => close(), { once: true });
      return;
    }
    send.disabled = false;
    message.hidden = false;
    message.textContent = uiText('feedbackFailed');
    message.focus?.();
  }

  function isOpen() { return Boolean(sheet && !sheet.hidden); }

  function open(opener) {
    ensure();
    invoker = opener || document.activeElement;
    reset();
    sheet.hidden = false;
    document.documentElement.classList.add('feedback-open');
    const first = sheet.querySelector('input[name="feedback-category"]');
    if (first) first.focus();
  }

  function close() {
    if (!sheet) return;
    sheet.hidden = true;
    document.documentElement.classList.remove('feedback-open');
    /* Focus RETURNS to the button that opened the sheet: a dialog that drops focus to the body loses a
       keyboard learner's place, and the contract asks for this explicitly. */
    if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) invoker.focus();
    invoker = null;
  }

  function unmount() {
    if (!sheet) return;
    document.removeEventListener('keydown', onKeydown);
    sheet.remove();
    sheet = null;
    document.documentElement.classList.remove('feedback-open');
  }

  return { open, close, isOpen, unmount };
}

/**
 * Wire the two openers. Called once, after boot; a missing element is not fatal, so a shell change can never
 * take the whole app down through this feature.
 */
export function installFeedbackEntryPoints(ctx) {
  const sheet = createFeedbackSheet(ctx);
  const wire = (id) => {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', (event) => { event.preventDefault(); sheet.open(node); });
    return Boolean(node);
  };
  const topBar = wire('feedback-open');
  const sidebar = wire('feedback-open-side');
  return { sheet, topBar, sidebar };
}
