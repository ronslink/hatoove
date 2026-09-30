/**
 * Shared DOM shell: escaping, small helpers, toasts, the busy overlay and the
 * view registry that app.js drives.
 *
 * Views build HTML strings and hand them to the container. Every value that comes
 * from a model, the network or stored state goes through esc() first.
 */

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function on(el, event, handler, opts) {
  if (el) el.addEventListener(event, handler, opts);
}

/** Delegated listener: matches on a selector inside a container. */
export function delegate(container, event, selector, handler) {
  if (!container) return;
  container.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && container.contains(target)) handler(e, target);
  });
}

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/* --------------------------------------------------------------- overlay */

let overlayEl = null;
let overlayTimer = null;
let overlayStarted = 0;

export function busy(title, sub = '') {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.className = 'busy-overlay';
  paintOverlay(title, sub);
  document.getElementById('overlay-host').appendChild(overlayEl);
  startOverlayClock();
}

function paintOverlay(title, sub) {
  overlayEl.innerHTML = `
    <div class="busy-box">
      <div class="spinner" style="width:26px;height:26px;border-width:3px;margin-bottom:12px"></div>
      <h3>${esc(title)}</h3>
      ${sub ? `<p>${esc(sub)}</p>` : ''}
      <p class="dim small" data-elapsed style="margin:8px 0 0"></p>
    </div>`;
}

function startOverlayClock() {
  overlayStarted = Date.now();
  if (overlayTimer) clearInterval(overlayTimer);
  overlayTimer = setInterval(() => {
    const el = overlayEl?.querySelector('[data-elapsed]');
    if (!el) return;
    const s = Math.round((Date.now() - overlayStarted) / 1000);
    // A model call can stall; showing the elapsed time makes that obvious instead
    // of looking like a frozen app.
    el.textContent = s >= 3 ? `${s} Sekunden…` : '';
  }, 1000);
}

export function busyUpdate(title, sub = '') {
  if (!overlayEl) return;
  paintOverlay(title, sub);
}

export function unbusy() {
  if (overlayTimer) {
    clearInterval(overlayTimer);
    overlayTimer = null;
  }
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

/**
 * Fill a host element with a spinner that also counts elapsed seconds.
 * Returns a stop() function; call it when the work finishes.
 */
export function spinnerWithTimer(host, label) {
  if (!host) return () => {};
  const started = Date.now();
  const paint = () => {
    const s = Math.round((Date.now() - started) / 1000);
    host.innerHTML = `<div class="btn-row"><span class="spinner"></span><span class="muted">${esc(label)}${s >= 3 ? ` ${s}s` : ''}</span></div>`;
  };
  paint();
  const id = setInterval(paint, 1000);
  return () => clearInterval(id);
}

/* --------------------------------------------------------------- registry */

const routes = new Map();
let currentRoute = null;
let currentCleanup = null;
let navigator = null;

export function registerView(id, def) {
  routes.set(id, def);
}

export function setNavigator(fn) {
  navigator = fn;
}

export function navigate(id, params = {}) {
  if (navigator) navigator(id, params);
}

export function currentViewId() {
  return currentRoute;
}

/**
 * Render a registered view into the shell.
 * A view may return a cleanup function, which runs before the next render.
 */
export async function renderRoute(id, params = {}) {
  const def = routes.get(id);
  if (!def) {
    toast(`Unbekannte Ansicht: ${id}`, 'bad');
    return;
  }
  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch {
      /* a broken cleanup must not block navigation */
    }
    currentCleanup = null;
  }

  currentRoute = id;
  const titleEl = document.getElementById('view-title');
  const actionsEl = document.getElementById('view-actions');
  const viewEl = document.getElementById('view');
  if (titleEl) titleEl.textContent = def.title || '';
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.dataset.view = id;
  document.title = `${def.title || 'Prüfungstraining'} · Certa`;
  // Remember where the learner came from, so opening something from the plan or the
  // reference index always offers a way straight back to it.
  returnTarget = RETURN_TARGETS[params?.from] || null;
  if (actionsEl) actionsEl.innerHTML = backButtonHtml();
  wireBackButton();
  if (viewEl) {
    viewEl.setAttribute('aria-busy', 'true');
    viewEl.innerHTML = '<div class="empty"><div class="spinner" role="status" aria-label="Ansicht wird geladen"></div></div>';
  }

  markActiveNav(id);

  try {
    currentCleanup = await def.render(viewEl, params, actionsEl);
  } catch (err) {
    console.error(err);
    if (viewEl) {
      viewEl.innerHTML = `<div class="card"><h3>Da ist etwas schiefgelaufen</h3>
        <p class="muted">${esc(err.message)}</p>
        <button class="primary" data-retry>Noch einmal versuchen</button></div>`;
      const retry = viewEl.querySelector('[data-retry]');
      if (retry) retry.addEventListener('click', () => renderRoute(id, params));
    }
  } finally {
    if (viewEl) viewEl.setAttribute('aria-busy', 'false');
  }
}

export function markActiveNav(id) {
  const parentViews = {
    vocabdrill: 'vocab',
    speakingguide: 'reference',
    writingguide: 'reference',
    casesguide: 'reference',
    nounsguide: 'reference',
    grammarguide: 'reference',
    sentenceguide: 'reference',
  };
  const activeId = parentViews[id] || id;
  $$('#nav .nav-item').forEach((btn) => {
    const active = btn.dataset.view === activeId;
    btn.classList.toggle('active', active);
    if (active) {
      btn.setAttribute('aria-current', 'page');
      const sectionEl = document.getElementById('view-section');
      if (sectionEl) sectionEl.textContent = btn.dataset.section || 'Dein Lernraum';
    } else btn.removeAttribute('aria-current');
  });
  // The Konto entry lives beside #nav (its own container), so it is marked here rather
  // than by the loop above.
  $$('#account-nav [data-shell-view="account"]').forEach((btn) => {
    const active = id === 'account';
    btn.classList.toggle('active', active);
    if (active) {
      btn.setAttribute('aria-current', 'page');
      const sectionEl = document.getElementById('view-section');
      if (sectionEl) sectionEl.textContent = btn.dataset.section || 'Konto';
    } else btn.removeAttribute('aria-current');
  });
}

let returnTarget = null;

/** Views a sub-page can be opened from, and the label to offer for getting back. */
const RETURN_TARGETS = {
  plan: { view: 'plan', label: 'Lernplan' },
  reference: { view: 'reference', label: 'Nachschlagen' },
  home: { view: 'home', label: 'Übersicht' },
};

function backButtonHtml() {
  if (!returnTarget) return '';
  return `<button data-return-to="${esc(returnTarget.view)}" title="Zurück">← ${esc(returnTarget.label)}</button>`;
}

function wireBackButton() {
  const actionsEl = document.getElementById('view-actions');
  const btn = actionsEl?.querySelector('[data-return-to]');
  if (btn) btn.addEventListener('click', () => navigate(btn.dataset.returnTo));
}

export function setViewActions(html) {
  const actionsEl = document.getElementById('view-actions');
  if (!actionsEl) return null;
  // Keep the back link even though views replace the action bar wholesale.
  actionsEl.innerHTML = backButtonHtml() + html;
  wireBackButton();
  return actionsEl;
}

/* --------------------------------------------------------------- helpers */

export function pct(n, digits = 0) {
  if (!Number.isFinite(n)) return '–';
  return `${n.toFixed(digits)}%`;
}

export function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export function barClass(mastery) {
  if (mastery >= 72) return 'good';
  if (mastery >= 52) return 'warn';
  return 'bad';
}

export function masteryLabel(mastery) {
  if (mastery >= 80) return 'sicher';
  if (mastery >= 68) return 'gut';
  if (mastery >= 55) return 'im Aufbau';
  if (mastery >= 42) return 'unsicher';
  return 'kritisch';
}

export function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDuration(ms) {
  const totalMin = Math.round((ms || 0) / 60000);
  if (totalMin < 60) return `${totalMin} Min.`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** Progress dots like 3/10 with a bar. */
export function progressLine(index, total, label = '') {
  const p = total ? (index / total) * 100 : 0;
  return `<div class="progress-line">
    <span class="small dim nowrap">${esc(label || `${Math.min(index + 1, total)} / ${total}`)}</span>
    <div class="bar"><i style="width:${p}%"></i></div>
  </div>`;
}

export function statCard(label, value, sub = '') {
  return `<div class="stat">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

export function meterRow(name, mastery, right = '') {
  const m = Math.max(0, Math.min(100, mastery));
  return `<div class="meter-row">
    <span class="name">${esc(name)}</span>
    <span class="val">${right || esc(masteryLabel(m))}</span>
    <div class="bar ${barClass(m)}"><i style="width:${m}%"></i></div>
  </div>`;
}

export function spinnerRow(text) {
  return `<div class="btn-row"><span class="spinner"></span><span class="muted">${esc(text)}</span></div>`;
}

/** Confirm dialog that works without native window.confirm styling differences. */
export function confirmDialog(message, confirmLabel = 'Ja, weiter') {
  return new Promise((resolve) => {
    const host = document.getElementById('overlay-host');
    const node = document.createElement('div');
    node.className = 'busy-overlay';
    node.innerHTML = `<div class="busy-box">
      <h3>Bestätigen</h3>
      <p>${esc(message)}</p>
      <div class="btn-row" style="justify-content:center;margin-top:16px">
        <button data-no>Abbrechen</button>
        <button class="primary" data-yes>${esc(confirmLabel)}</button>
      </div>
    </div>`;
    host.appendChild(node);
    const close = (v) => {
      node.remove();
      resolve(v);
    };
    node.querySelector('[data-yes]').addEventListener('click', () => close(true));
    node.querySelector('[data-no]').addEventListener('click', () => close(false));
    node.addEventListener('click', (e) => {
      if (e.target === node) close(false);
    });
  });
}
