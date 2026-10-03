/**
 * CHECKOUT — "Pass freischalten" (PAYMENTS-SLICE-01, contract §2.1–2.3).
 *
 * BUYING IS A SERVER DECISION, NOT A SCREEN DECISION. This module renders states and asks the server
 * for them; it never decides what something costs, whether this learner already has it, or whether a
 * payment succeeded. Three consequences shape every line below, and they are the contract's §7 rather
 * than a style preference:
 *
 *   1. NO AMOUNT, CURRENCY, PRICE ID OR MARKET PRICE IS EVER SENT. The session POST carries the exam
 *      and the market and nothing else, because the server resolves the price from its own row. A
 *      client that could name an amount is a client that can be told to name a different one.
 *   2. THE PROVIDER RETURN IS NOT PROOF OF PAYMENT. A `success_url` says the browser came back, not
 *      that money moved: the learner can edit it, and the webhook may not have arrived yet. Every
 *      state after the redirect is read from `GET /api/v1/orders/:id`, and "pending" is rendered as
 *      "Zahlung wird geprüft" — never as a success.
 *   3. NO BROWSER STATE, AND NO MEMORY OF A PURCHASE EITHER. Which order is being watched comes only
 *      from the return URL the server itself was given, for that visit. This module deliberately does
 *      NOT remember the last order id: a reload after the provider redirect loses the module's memory
 *      anyway, so a remembered id could only ever resurface days later and hijack an ordinary visit
 *      with the state of a purchase the learner had long finished with. Losing the id costs one
 *      "Angebot neu laden"; keeping it could show a stranger's stale screen.
 *
 * `purchasable: false` and an unwired port (`503`) both mean THE SAME THING ON SCREEN: no button. A
 * buy control that would be refused is worse than no control, because it teaches the learner that the
 * screen lies.
 *
 * `api` returns `{ ok, status, data, error }` and never throws, so every branch here is a real state
 * rather than an exception handler. `esc` escapes every interpolated value; nothing from the server
 * reaches the DOM unescaped.
 */
export function createCheckoutController({ api, esc, onChange = () => {} }) {
  let active = null;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const AUTO_CHECKS = 5, AUTO_DELAY = 4000;
  const ORDER_STATUSES = ['pending', 'paid', 'failed', 'refunded', 'disputed'];
  const current = (s) => active === s && Boolean(s.host) && s.host.isConnected;
  const asInt = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const failure = (r) => r?.status === 0 ? 'Keine Verbindung zum Server.' : 'Fehler ' + (r?.status ?? 0) + (r?.error ? ' (' + r.error + ')' : '');
  const button = (id, text, primary = false) => `<button type="button" class="btn${primary ? ' btn-primary' : ''}" id="${id}">${text}</button>`;

  /** A date the learner can act on, or a plain statement that there is none. */
  function day(value) {
    if (!value) return 'unbekannt';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? 'unbekannt' : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  /** A term in days, said in weeks when it divides evenly — nothing is inferred beyond that. */
  function term(days) {
    const value = asInt(days);
    if (value === null) return 'unbekannt';
    return value % 7 === 0 ? (value / 7) + ' Wochen' : value + ' Tage';
  }
  /** One figure and its label. `value` is escaped here, so callers pass raw numbers or text. */
  const stat = (label, value) => `<div class="stat"><span class="num">${esc(value)}</span><span>${esc(label)}</span></div>`;
  /** The pass balance. Every figure is the server's; a missing one is said to be unknown. */
  const LEDGER_KEYS = { existing: ['allowance', 'used', 'reserved', 'expiresAt'], entitlement: ['allowance', 'used', 'reserved', 'expiresAt'] };
  const ledger = (entry, context) => {
    const keys = LEDGER_KEYS[context] || [];
    if (!keys.length || !entry) return '';
    const allowance = asInt(entry.allowance), used = asInt(entry.used), reserved = asInt(entry.reserved);
    const left = allowance !== null && used !== null ? allowance - used - (reserved ?? 0) : null;
    const label = context === 'existing' ? 'Dein Guthaben' : 'Freigeschaltetes Guthaben';
    return `<p class="field-label">${esc(label)}</p><div class="stat-row">`
      + stat('freigeschaltet', allowance === null ? 'unbekannt' : allowance)
      + stat('verwendet', used === null ? 'unbekannt' : used)
      + stat('reserviert', reserved === null ? 'unbekannt' : reserved)
      + stat('verfügbar', left === null ? 'unbekannt' : Math.max(0, left))
      + `</div><p class="small muted">Gültig bis ${esc(day(entry.expiresAt))}.</p>`;
  };

  function dispose() {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.host.replaceChildren();
    active.host.hidden = true;
    active = null;
    // The shell re-reads its own credit line: a pass this view just granted is what that line shows,
    // and it is never written down anywhere in the browser.
    onChange();
  }

  function render(s) {
    if (!current(s)) return;
    const m = s.mode, o = s.offer || {}, e = o.existing || null, order = s.order || {}, ent = order.entitlement || null;
    let html = '';
    if (m === 'loading') {
      html = `<div class="card"><h3>Wird geladen …</h3><p class="muted">Wir fragen den Server nach dem Angebot für diese Prüfung.</p></div>`;
    } else if (m === 'unavailable') {
      // Calm, and deliberately without the error treatment: the pilot has no payments port yet, which
      // is a fact about the installation rather than a mistake the learner made.
      html = `<div class="card" role="status"><div class="card-head"><h3>Im Pilot noch nicht verfügbar</h3><span class="chip">Hinweis</span></div>`
        + `<p>Das Freischalten eines Passes ist in diesem Pilot noch nicht eingerichtet. Es ist nichts kaputt und du musst nichts tun.</p>`
        + `<p class="small muted">Deine Übungen, Texte und Rückmeldungen sind davon nicht betroffen.</p></div>`;
    } else if (m === 'missing') {
      html = `<div class="card" role="status"><div class="card-head"><h3>Zurzeit kein Angebot</h3><span class="chip">Hinweis</span></div>`
        + `<p>Für diese Prüfung ist in diesem Markt kein Preis hinterlegt. Deshalb wird hier nichts zum Kauf angeboten.</p>`
        + `<p class="small muted">Das ist keine Störung. Sobald ein Preis hinterlegt ist, erscheint das Angebot hier.</p></div>`;
    } else if (m === 'existing') {
      html = `<div class="card" role="status"><div class="card-head"><h3>Dein Pass ist noch gültig</h3><span class="chip">Aktiv</span></div>`
        + `<p>Für diese Prüfung ist bereits ein Pass freigeschaltet. Ein zweiter Kauf ist nicht nötig.</p>`
        + ledger(e, 'existing')
        + `<p class="small muted">Diese Zahlen kommen aus deinem Konto auf dem Server.</p>`
        + `<div class="row">${button('checkout-refresh', 'Stand erneut laden')}</div></div>`;
    } else if (m === 'ready') {
      const exam = esc(o.examId || s.examId || 'diese Prüfung');
      html = `<div class="card"><div class="card-head"><h3>Pass für ${exam}</h3><span class="chip">Angebot</span></div>`
        + `<div class="spread"><span class="muted">Preis</span><strong class="checkout-price">${esc(o.displayPrice || 'Preis wird auf dem Server ermittelt')}</strong></div>`
        + `<div class="spread"><span class="muted">Laufzeit</span><strong>${esc(term(o.termDays))}</strong></div>`
        + `<div class="spread"><span class="muted">Enthalten</span><strong>${esc(asInt(o.allowance) === null ? 'unbekannt' : asInt(o.allowance))} Schreib-Rückmeldungen</strong></div>`
        + `<p class="small muted">Der Preis wird auf dem Server zu dieser Prüfung und diesem Markt gesucht. Diese Seite sendet keinen Betrag.</p>`
        + `<div class="row">${button('checkout-buy', 'Pass freischalten', true)}${button('checkout-refresh', 'Angebot neu laden')}</div></div>`;
    } else if (m === 'starting') {
      // The redirect is already being prepared: the button stays where it is and says what is happening,
      // so a second press is impossible rather than merely ignored.
      html = `<div class="card"><div class="card-head"><h3>Weiterleitung zum Anbieter</h3><span class="chip">Bitte warten</span></div>`
        + `<p>Die Zahlungsseite wird vorbereitet. Dieses Fenster wird gleich weitergeleitet.</p>`
        + `<div class="row"><button type="button" class="btn btn-primary" id="checkout-buy" disabled>Weiterleitung läuft …</button></div></div>`;
    } else if (m === 'pending') {
      html = `<div class="card" role="status"><div class="card-head"><h3>Zahlung wird geprüft</h3><span class="chip">Offen</span></div>`
        + `<p>Wir haben deine Rückkehr vom Anbieter erhalten und warten auf die Bestätigung des Zahlungsdienstes.</p>`
        + `<p class="small muted">Das ist noch <strong>kein</strong> Nachweis, dass die Zahlung angekommen ist. Der Stand kommt aus der Bestellung auf dem Server, nicht aus der Adresse in deinem Browser.</p>`
        + `<p class="small muted">Bestellung ${esc(order.id || s.orderId || '')} · angelegt am ${esc(day(order.createdAt))}.</p>`
        + `<div class="row">${button('checkout-refresh', 'Stand erneut prüfen', true)}</div>`
        + `<p class="small muted" id="checkout-note" role="status" aria-live="polite">${s.autoChecks >= AUTO_CHECKS ? 'Automatische Prüfung beendet. Prüfe den Stand selbst noch einmal.' : 'Wir prüfen den Stand noch einige Male automatisch.'}</p></div>`;
    } else if (m === 'paid') {
      html = `<div class="card" role="status"><div class="card-head"><h3>Pass freigeschaltet</h3><span class="chip">Bezahlt</span></div>`
        + `<p>Die Zahlung ist bestätigt und der Pass ist deinem Konto gutgeschrieben.</p>`
        + (ent ? ledger(ent, 'entitlement') : `<p class="small muted">Die Höhe des Guthabens meldet der Server mit dem nächsten Aufruf.</p>`)
        + `<p class="small muted" id="checkout-note" role="status" aria-live="polite"></p>`
        + `<div class="row">${button('checkout-refresh', 'Stand erneut laden')}</div></div>`;
    } else if (m === 'failed') {
      // A failed, refunded or disputed order grants nothing. The text is explicit that the learner's
      // own records were never at risk, because the entitlement is what a purchase adds — not a
      // condition for the work already saved.
      const reason = order.status === 'refunded' ? 'Die Zahlung wurde zurückerstattet.'
        : order.status === 'disputed' ? 'Zu dieser Zahlung läuft ein Einspruch.'
        : 'Die Zahlung ist fehlgeschlagen oder wurde abgebrochen.';
      html = `<div class="card"><div class="card-head"><h3>Pass nicht freigeschaltet</h3><span class="chip">Nicht aktiv</span></div>`
        + `<p class="err">${esc(reason)}</p>`
        + `<p>Es wurde nichts freigeschaltet. Deine Texte, Entwürfe und Rückmeldungen sind unverändert und bleiben gespeichert.</p>`
        + `<div class="row">${button('checkout-refresh', 'Stand erneut laden', true)}</div></div>`;
    } else {
      // `broken`: no usable answer from the server — a dropped connection, an unexpected status, or a
      // body that is not the shape the contract promises. Never rendered as one of the other states.
      html = `<div class="card"><div class="card-head"><h3>Das hat nicht geklappt</h3><span class="chip">Fehler</span></div>`
        + `<p class="err">${esc(s.error || 'Die Anfrage konnte nicht abgeschlossen werden.')}</p>`
        + `<p class="small muted">Es wurde nichts gebucht und nichts freigeschaltet.</p>`
        + `<div class="row">${button('checkout-retry', 'Erneut versuchen')}</div></div>`;
    }
    s.host.innerHTML = html;
    const bind = (id, handler) => { const node = s.host.querySelector('#' + id); if (node) node.onclick = handler; };
    // "Erneut versuchen" always repeats the call the learner was waiting for: the order they started,
    // or the offer they had not been able to read.
    if (m === 'pending' || m === 'paid' || m === 'failed') bind('checkout-refresh', () => checkOrder(s));
    if (m === 'existing' || m === 'ready') bind('checkout-refresh', () => loadOffer(s));
    if (m === 'ready') bind('checkout-buy', () => startSession(s));
    if (m === 'broken') bind('checkout-retry', () => (s.orderId ? checkOrder(s) : loadOffer(s)));
  }

  /** Read the offer, and answer with a state for each documented refusal — never with a raw status. */
  async function loadOffer(s) {
    s.mode = 'loading'; s.offer = null; s.error = null;
    render(s);
    const res = await api.payments.offer(s.examId);
    if (!current(s)) return;
    if (res?.ok && res.data?.offer) { s.offer = res.data.offer; return showOffer(s); }
    if (res?.ok) { s.error = 'Der Server hat kein Angebot geliefert.'; s.mode = 'broken'; render(s); return; }
    if (res?.status === 503) { s.mode = 'unavailable'; render(s); return; }
    if (res?.status === 404) { s.mode = 'missing'; render(s); return; }
    s.error = failure(res); s.mode = 'broken'; render(s);
  }

  /**
   * Which shape the offer has is the SERVER's answer, not a client guess: `purchasable: true` is the
   * only shape that may render a buy button, and the contract's §7 says so in as many words.
   */
  function showOffer(s) {
    const o = s.offer || {};
    // Taken from the offer the server just resolved for this learner — never defaulted by the client.
    if (typeof o.market === 'string' && o.market) s.market = o.market;
    if (o.purchasable === true) s.mode = 'ready';
    else if (o.existing) s.mode = 'existing';
    else { s.mode = 'missing'; }
    render(s);
  }

  /**
   * Start a checkout session — the ONLY request this view makes, and the only one it may make.
   *
   * The body is `{ examId, market }` and nothing else. No amount, no currency, no price id: the
   * contract puts the price on the server, and a client that sent one could set its own.
   */
  async function startSession(s) {
    if (s.busy) return;
    s.busy = true; s.mode = 'starting'; s.error = null;
    render(s);
    const res = await api.payments.startSession({ examId: s.examId, market: s.market });
    s.busy = false;
    if (!current(s)) return;
    if (res?.ok && typeof res.data?.orderId === 'string' && UUID.test(res.data.orderId)) {
      s.orderId = res.data.orderId;
      const url = res.data?.checkoutUrl;
      if (typeof url === 'string' && url) { window.location.assign(url); return; }
      // A session without a URL cannot be paid. Say so rather than leaving a dead button on screen.
      s.error = 'Die Zahlungsseite konnte nicht geöffnet werden.'; s.mode = 'broken'; render(s); return;
    }
    if (res?.ok) { s.error = 'Die Zahlungsseite konnte nicht geöffnet werden.'; s.mode = 'broken'; render(s); return; }
    if (res?.status === 503) { s.mode = 'unavailable'; render(s); return; }
    if (res?.status === 409 && res.error === 'already_entitled') {
      // Someone else's tab — or this learner's earlier purchase — granted the pass first. Re-ask rather
      // than showing a buy button the server has just refused.
      await loadOffer(s); return;
    }
    if (res?.status === 502) { s.error = 'Der Zahlungsdienst ist gerade nicht erreichbar. Es wurde nichts gebucht.'; s.mode = 'broken'; render(s); return; }
    if (res?.status === 422) { s.error = 'Die Anfrage wurde vom Server abgelehnt. Es wurde nichts gebucht.'; s.mode = 'broken'; render(s); return; }
    s.error = failure(res); s.mode = 'broken'; render(s);
  }

  /**
   * THE ORDER IS THE ONLY SOURCE OF TRUTH. This is what makes the provider's return URL harmless: the
   * browser coming back proves nothing, and the status below is read from the server every time.
   */
  async function checkOrder(s, extra = 0) {
    if (!s.orderId || s.busy) return;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.busy = true;
    const res = await api.payments.order(s.orderId);
    s.busy = false;
    if (!current(s)) return;
    const order = res?.data?.order;
    if (!res?.ok) {
      if (res?.status === 404) { s.error = 'Diese Bestellung ist nicht mehr auffindbar.'; s.mode = 'broken'; render(s); return; }
      s.error = failure(res); s.mode = 'broken'; render(s); return;
    }
    if (!order || typeof order !== 'object' || !ORDER_STATUSES.includes(order.status)) {
      s.error = 'Der Server hat einen unbekannten Bestellstand geliefert.'; s.mode = 'broken'; render(s); return;
    }
    s.order = order;
    if (order.status === 'paid') { s.mode = 'paid'; render(s); return; }
    if (order.status === 'failed' || order.status === 'refunded' || order.status === 'disputed') { s.mode = 'failed'; render(s); return; }
    s.mode = 'pending'; render(s);
    // A slow confirmation is polled a few times and then left to the learner's own button. Nothing is
    // claimed in the meantime, and the schedule is bounded so a closed tab is not hammering the server.
    const attempt = s.autoChecks + extra;
    if (attempt < AUTO_CHECKS && current(s)) {
      s.autoChecks = attempt + 1;
      s.timer = setTimeout(() => checkOrder(s), AUTO_DELAY);
    }
  }

  /**
   * Open the checkout for one exam on one host. `options.orderId` is the order the server put in its
   * return URL; with no id, the screen simply shows what is on sale.
   */
  async function open(host, options = {}) {
    dispose();
    if (!host) return false;
    const matching = (value) => { const m = UUID.exec(String(value || '')); return m ? m[0] : null; };
    const examId = typeof options.examId === 'string' && options.examId ? options.examId : null;
    const market = typeof options.market === 'string' && options.market ? options.market : 'DE';
    const orderId = matching(options.orderId) || matching(options.returnUrl);
    if (!examId) { host.hidden = false; host.innerHTML = `<div class="card"><h3>Kein Angebot für diese Ansicht</h3><p class="small muted">Wähle zuerst eine Prüfungsvorbereitung.</p></div>`; return false; }
    const s = { host, examId, market, mode: 'loading', offer: null, order: null, orderId, error: null, busy: false, autoChecks: 0, timer: null };
    active = s;
    host.hidden = false;
    if (orderId) { render(s); await checkOrder(s, 0); return true; }
    await loadOffer(s);
    return true;
  }

  return { open, dispose, get active() { return active; } };
}
