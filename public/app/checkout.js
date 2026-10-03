/** Account-owned checkout: prices, payment status and balances come from the API. */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp('^' + UUID_SOURCE + '$', 'i');
const RETURN = new RegExp('^/app/#/checkout\\?order=(' + UUID_SOURCE + ')(?:&checkout=stub)?$', 'i');
const ORDER_STATES = ['pending', 'paid', 'failed', 'refunded', 'disputed'];
const copy = value => structuredClone(value);

/** A deliberately narrow return target shared by the shell and authentication entry. */
export function checkoutReturnPath(value) {
  if (typeof value !== 'string' || !RETURN.test(value)) return null;
  const match = /^\/app\/#\/checkout\?order=([^&]+)(?:&checkout=stub)?$/.exec(value);
  return match && UUID.test(match[1]) ? value : null;
}
export function checkoutAuthReturn(search, hash = '') {
  const values = new URLSearchParams(search).getAll('returnTo');
  return values.length ? values.length === 1 ? checkoutReturnPath(values[0]) || '/app/' : '/app/' : checkoutReturnPath('/app/' + hash) || '/app/';
}
export function checkoutRoute(hash) {
  if (hash === '#/checkout') return { isCheckout: true, orderId: null, invalid: false, path: '/app/#/checkout' };
  if (!String(hash).startsWith('#/checkout?')) return { isCheckout: false, orderId: null, invalid: false, path: null };
  const path = checkoutReturnPath('/app/' + hash);
  return { isCheckout: true, orderId: path ? new URLSearchParams(hash.split('?')[1]).get('order') : null, invalid: !path, path };
}
export function checkoutRedirect(raw, orderId, origin) {
  if (!UUID.test(orderId || '') || typeof raw !== 'string' || /[\s\\]/.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.port) return url.href;
  if (url.origin !== origin || !raw.startsWith(origin + '/app/#/checkout?')) return null;
  const path = checkoutReturnPath(raw.slice(origin.length));
  if (!path || new URLSearchParams(path.split('?')[1]).get('order') !== orderId) return null;
  return raw;
}
export function checkoutError(response, operation = 'read') {
  if (response?.status === 401 || ['account_changed', 'stale_session'].includes(response?.error)) return 'Bitte melde dich erneut an, um den Bestellstand zu prüfen.';
  const messages = {
    checkout_pending: 'Für diese Prüfung ist bereits eine Bestellung offen. Schließe sie zuerst ab oder prüfe ihren Stand. Beginne keine weitere Zahlung.',
    checkout_expired: 'Diese Zahlungsseite ist abgelaufen. Der Bestellstand bleibt gespeichert. Eine neue Zahlung kann hier derzeit nicht begonnen werden.',
    event_conflict: 'Diese Anfrage passt nicht mehr zur gespeicherten Bestellung. Prüfe den Bestellstand, bevor du erneut zahlst.',
    already_entitled: 'Für diese Prüfung ist bereits Guthaben verfügbar. Lade das Angebot erneut.',
    payments_unavailable: 'Das Freischalten eines Passes ist zurzeit nicht verfügbar.',
  };
  if (messages[response?.error]) return messages[response.error];
  if (operation === 'start') return 'Die Zahlungsseite konnte nicht bestätigt werden. Der Bestellstand ist unklar. Wiederhole dieselbe Anfrage, bevor du eine weitere Zahlung beginnst.';
  return response?.status === 404 ? 'Diese Bestellung oder dieses Angebot ist nicht verfügbar.' : 'Der Stand konnte nicht geladen werden. Bitte versuche es erneut.';
}

/** Pure transport boundary: an obsolete response cannot navigate or replace another context. */
export function createCheckoutState({ api, changed = () => {}, eventId = () => crypto.randomUUID(), navigate = url => window.location.assign(url), origin = () => window.location.origin, beforeRedirect = async () => true, canContinue = () => true, onPaid = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let state = null, epoch = 0, timer = null, request = 0;
  const current = (s, ticket) => state === s && epoch === ticket;
  const publish = () => changed();
  const stopTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const snapshot = () => state ? copy(state) : null;
  const invoke = async action => { try { return await action(); } catch { return { ok: false, status: 0, error: 'network' }; } };
  function fail(s, response, operation = 'read') { s.mode = 'error'; s.error = checkoutError(response, operation); s.retry = operation; s.busy = false; publish(); }
  async function loadOffer(market = state?.market || null) {
    const s = state, ticket = epoch;
    if (!s || s.busy || s.operation) return false;
    if (market && !s.markets.some(row => row.market === market)) return false;
    const serial = ++request;
    s.market = market; s.mode = 'loading'; s.busy = true; s.offer = null; s.error = ''; publish();
    const response = await invoke(() => api.payments.offer(s.examId, market));
    if (!current(s, ticket) || serial !== request) return false;
    s.busy = false;
    if (!response?.ok) {
      if ([404, 503].includes(response?.status)) { s.mode = response.status === 404 ? 'missing' : 'unavailable'; s.error = checkoutError(response); publish(); return false; }
      fail(s, response); return false;
    }
    const data = response.data, rows = data?.markets;
    if (!Array.isArray(rows) || rows.some(row => !/^[A-Z]{2}$/.test(row.market) || !/^[A-Z]{3}$/.test(row.currency)) || new Set(rows.map(row => row.market)).size !== rows.length) { fail(s, null); return false; }
    s.markets = rows; s.testMode = data.testMode === true || data.offer?.testMode === true;
    if (!market && data.offer === null) { s.mode = rows.length ? 'market' : 'missing'; publish(); return true; }
    const offer = data.offer;
    if (!offer || offer.examId !== s.examId || offer.market !== market || offer.testMode !== true || !Number.isInteger(offer.amountMinor) || offer.amountMinor < 0 || typeof offer.displayPrice !== 'string' || !offer.displayPrice.trim() || !Number.isInteger(offer.allowance) || offer.allowance < 1 || !Number.isInteger(offer.termDays) || offer.termDays < 1 || !rows.some(row => row.market === market && row.currency === offer.currency)) { fail(s, null); return false; }
    s.offer = offer; s.mode = offer.purchasable === true ? 'ready' : offer.purchasable === false && offer.existing ? 'existing' : 'missing'; publish(); return true;
  }
  async function start() {
    const s = state, ticket = epoch;
    if (!s || s.busy || !canContinue() || (!s.operation && (s.mode !== 'ready' || s.offer?.testMode !== true))) return false;
    s.operation ||= { examId: s.examId, market: s.market, eventId: eventId() };
    s.busy = true; s.mode = 'starting'; s.error = ''; publish();
    const response = await invoke(() => api.payments.startSession(copy(s.operation)));
    if (!current(s, ticket)) return false;
    s.busy = false;
    if (!canContinue()) { fail(s, null, 'start'); return false; }
    if (!response?.ok) {
      if (response?.error === 'already_entitled') { s.operation = null; return loadOffer(s.market); }
      fail(s, response, 'start'); return false;
    }
    const value = response.data;
    if (UUID.test(value?.orderId || '')) s.orderId = value.orderId;
    if (s.orderId && value?.testMode === true && ['paid', 'failed', 'refunded', 'disputed'].includes(value.status)) return checkOrder();
    const destination = value?.testMode === true ? checkoutRedirect(value.checkoutUrl, value.orderId, origin()) : null;
    if (!destination) { s.error = 'Die Zahlungsseite konnte nicht sicher geöffnet werden. Prüfe den Bestellstand, bevor du erneut zahlst.'; s.mode = 'error'; s.retry = s.orderId ? 'order' : 'start'; publish(); return false; }
    s.busy = true;
    let saved = false;
    try { saved = await beforeRedirect(); } catch { /* Preserve the pending order and the draft. */ }
    if (!current(s, ticket)) return false;
    s.busy = false;
    if (!canContinue()) { fail(s, null, 'start'); return false; }
    if (!saved) { s.error = 'Dein Entwurf konnte noch nicht gespeichert werden. Die Weiterleitung wurde angehalten. Speichere deinen Text und versuche es erneut.'; s.mode = 'error'; s.retry = 'start'; publish(); return false; }
    navigate(destination); return true;
  }
  async function checkOrder(automatic = false) {
    const s = state, ticket = epoch;
    if (!s?.orderId || s.busy || !canContinue()) return false;
    stopTimer(); s.busy = true; if (!automatic) { s.mode = 'loading'; publish(); }
    const response = await invoke(() => api.payments.order(s.orderId));
    if (!current(s, ticket)) return false;
    s.busy = false;
    const order = response?.data?.order;
    if (!response?.ok || !order || order.id !== s.orderId || !ORDER_STATES.includes(order.status) || order.testMode !== true) { fail(s, response, 'order'); return false; }
    s.order = order; s.testMode = true; s.mode = order.status; s.error = '';
    if (order.status === 'pending' && s.autoChecks < 5) { s.autoChecks++; timer = schedule(() => { timer = null; void checkOrder(true); }, 4000); }
    publish();
    if (order.status === 'paid') onPaid(order);
    return true;
  }
  function dispose() { stopTimer(); epoch++; request++; state = null; }
  async function open(options = {}) {
    dispose();
    state = { examId: options.examId || null, examLabel: options.examLabel || options.examId || '', market: null, markets: [], offer: null, order: null, orderId: options.orderId || null, operation: null, mode: 'loading', error: '', busy: false, testMode: false, retry: 'read', autoChecks: 0 };
    if (options.invalid || (options.orderId && !UUID.test(options.orderId))) { state.mode = 'invalid'; publish(); return false; }
    if (state.orderId) return checkOrder();
    if (!state.examId) { state.mode = 'no_exam'; publish(); return false; }
    return loadOffer();
  }
  return { snapshot, open, dispose, loadOffer, start, checkOrder, retry: () => state?.retry === 'start' ? start() : state?.orderId ? checkOrder() : loadOffer(), get busy() { return Boolean(state?.busy); } };
}

const whole = value => Number.isInteger(value) && value >= 0 ? value : null;
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('de-DE') : null;
export function checkoutBalance(entry, esc) {
  if (!entry) return '';
  const allowance = whole(entry.allowance), used = whole(entry.used), reserved = whole(entry.reserved);
  const expired = Boolean(date(entry.expiresAt) && Date.parse(entry.expiresAt) <= Date.now());
  const available = expired ? 0 : [allowance, used, reserved].every(value => value !== null) ? Math.max(0, allowance - used - reserved) : null;
  const expiry = entry.expiresAt === null ? 'Ohne festes Ablaufdatum.' : date(entry.expiresAt) ? (expired ? 'Abgelaufen am ' : 'Gültig bis ') + date(entry.expiresAt) + '.' : 'Gültigkeit derzeit unbekannt.';
  return '<dl class="checkout-balance">' + [['freigeschaltet', allowance], ['verwendet', used], ['reserviert', reserved], ['verfügbar', available]].map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + esc(value ?? 'unbekannt') + '</dd></div>').join('') + '</dl><p class="small muted">' + esc(expiry) + '</p>';
}
export function checkoutMarkup(s, esc) {
  const button = (id, label, primary = false) => `<button type="button" class="btn${primary ? ' btn-primary' : ''}" id="${id}"${s.busy ? ' disabled' : ''}>${label}</button>`;
  const heading = (title, body) => '<h3 id="checkout-title" tabindex="-1">' + title + '</h3>' + body;
  const refresh = button('checkout-refresh', s.orderId ? 'Stand erneut prüfen' : 'Angebot erneut laden');
  let body = '';
  if (s.mode === 'loading') body = heading('Wird geladen …', '<p>Der aktuelle Stand wird geladen.</p>');
  else if (s.mode === 'market') body = heading('Land für deinen Kauf wählen', '<p>Wähle das Land, in dem du den Pass kaufen möchtest.</p>');
  else if (s.mode === 'ready') body = heading('Pass für ' + esc(s.examLabel), `<dl class="checkout-offer"><div><dt>Preis</dt><dd class="checkout-price">${esc(s.offer.displayPrice)}</dd></div><div><dt>Laufzeit</dt><dd>${esc(s.offer.termDays)} Tage</dd></div><div><dt>Enthalten</dt><dd>${esc(s.offer.allowance)} Schreib-Rückmeldungen</dd></div></dl><div class="row">${button('checkout-buy', 'Testzahlung fortsetzen', true)}${refresh}</div>`);
  else if (s.mode === 'existing') body = heading('Dein Pass ist noch gültig', '<p>Für diese Prüfung ist bereits Guthaben verfügbar. Ein weiterer Kauf ist derzeit nicht nötig.</p>' + checkoutBalance(s.offer.existing, esc) + refresh);
  else if (s.mode === 'starting') body = heading('Zahlungsseite wird vorbereitet', '<p>Bitte warte auf die Weiterleitung.</p>');
  else if (s.mode === 'pending') body = heading('Zahlung wird geprüft', '<p>Die Zahlung ist noch nicht bestätigt. Bitte beginne keine weitere Zahlung für diese Prüfung.</p>' + refresh + '<p id="checkout-note" class="small muted">' + (s.autoChecks >= 5 ? 'Prüfe den Stand bei Bedarf erneut.' : 'Der Stand wird noch einige Male automatisch geprüft.') + '</p>');
  else if (s.mode === 'paid') body = heading('Pass freigeschaltet', '<p>Die Zahlung wurde bestätigt. Dein Guthaben ist gespeichert.</p>' + checkoutBalance(s.order.entitlement, esc) + refresh);
  else if (s.mode === 'refunded') body = heading('Zahlung zurückerstattet', '<p>Für diese Bestellung wurde eine Rückerstattung gemeldet.</p>' + checkoutBalance(s.order.entitlement, esc) + refresh);
  else if (s.mode === 'disputed') body = heading('Zahlung wird geklärt', '<p>Zu dieser Bestellung wurde ein Einspruch gemeldet.</p>' + checkoutBalance(s.order.entitlement, esc) + refresh);
  else if (s.mode === 'failed') body = heading('Zahlung nicht abgeschlossen', '<p>Diese Bestellung wurde als fehlgeschlagen gemeldet. Deine gespeicherten Übungen und Texte bleiben erhalten.</p>' + refresh);
  else if (s.mode === 'unavailable') body = heading('Freischalten zurzeit nicht verfügbar', '<p>Bitte versuche es später erneut. Deine gespeicherten Übungen und Texte bleiben erhalten.</p>' + refresh);
  else if (s.mode === 'missing') body = heading('Zurzeit kein Angebot', '<p>Für diese Prüfung und das gewählte Land ist derzeit kein Angebot verfügbar.</p>' + refresh);
  else if (s.mode === 'no_exam') body = heading('Keine Prüfung ausgewählt', '<p>Wähle eine Prüfungsvorbereitung, um die verfügbaren Angebote anzusehen.</p>');
  else if (s.mode === 'invalid') body = heading('Bestelllink nicht gültig', '<p>Dieser Link kann nicht geöffnet werden. Verwende den ursprünglichen Link zu deiner Bestellung.</p>');
  else body = heading('Stand noch nicht bestätigt', `<p class="err" role="alert">${esc(s.error)}</p><div class="row">${button('checkout-retry', 'Erneut prüfen', true)}${s.orderId && s.retry !== 'order' ? button('checkout-order', 'Bestellstand ansehen') : ''}</div>`);
  const chooser = !s.orderId && !s.operation && s.markets.length ? '<label class="field-label" for="checkout-market">Land des Kaufs</label><select class="select" id="checkout-market"' + (s.busy ? ' disabled' : '') + '><option value="">Bitte ausdrücklich wählen</option>' + s.markets.map(row => '<option value="' + esc(row.market) + '"' + (s.market === row.market ? ' selected' : '') + '>' + esc(row.market + ' · ' + row.currency) + '</option>').join('') + '</select>' : '';
  return '<article class="card stack checkout-card" data-checkout-state="' + esc(s.mode) + '" aria-labelledby="checkout-title" aria-busy="' + s.busy + '">' + (s.testMode ? '<p class="chip" id="checkout-test-mode">Testmodus · keine echte Zahlung</p>' : '') + body + chooser + (s.order ? '<p class="small muted checkout-order-reference">Bestellung ' + esc(s.order.id) + ' · ' + esc(s.order.examId) + '</p>' : '') + '</article>';
}

export function createCheckoutController({ api, esc, onChange = () => {}, beforeRedirect, canContinue = () => true }) {
  let host = null, restoreFocus = null;
  const session = createCheckoutState({ api, beforeRedirect, canContinue: () => Boolean(host?.isConnected) && canContinue(), onPaid: onChange, changed: () => {
    const state = session.snapshot();
    if (!host?.isConnected || !state) return;
    const active = document.activeElement;
    if (host.contains(active)) restoreFocus = active.id || 'checkout-title';
    // Replacement can leave focus on the document. A deliberate move to another live control
    // cancels the pending restoration, including while an offer request is still in flight.
    else if (active?.isConnected && active !== document.body && active !== document.documentElement && active !== document) restoreFocus = null;
    host.dataset.state = state.mode; host.innerHTML = checkoutMarkup(state, esc);
    const bind = (id, action) => { const node = host.querySelector('#' + id); if (node) node.onclick = action; };
    bind('checkout-buy', () => void session.start()); bind('checkout-refresh', () => void (state.orderId ? session.checkOrder() : session.loadOffer()));
    bind('checkout-retry', () => void session.retry()); bind('checkout-order', () => void session.checkOrder());
    const picker = host.querySelector('#checkout-market'); if (picker) picker.onchange = event => void session.loadOffer(event.target.value || null);
    if (restoreFocus && !state.busy) { (host.querySelector('#' + restoreFocus) || host.querySelector('#checkout-title'))?.focus({ preventScroll: true }); restoreFocus = null; }
  } });
  return {
    async open(target, options) { if (host && host !== target) { host.replaceChildren(); host.hidden = true; } host = target; host.hidden = false; return session.open(options); },
    dispose() { session.dispose(); if (host) { host.replaceChildren(); host.hidden = true; } host = null; restoreFocus = null; },
    get active() { return session.snapshot(); },
  };
}
