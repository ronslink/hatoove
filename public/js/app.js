/**
 * Bootstrap and routing.
 */

import * as shell from './shell.js';
import * as store from './store.js';
import * as ai from './ai.js';
import { icon } from './icons.js';
import { examCountdown } from './engine.js';
import { dashboardView, drillView, vocabView, vocabDrillView, notebookView, planView, settingsView } from './ui.js';
import { accountView, accountNavHtml } from './account.js';
import { paperView, writingView, speakingView, mockView, teardownExamViews } from './exam.js';
import {
  referenceHubView,
  speakingGuideView,
  writingGuideView,
  grammarGuideView,
  casesGuideView,
  nounsGuideView,
  sentenceGuideView,
} from './guides.js';

const NAV = [
  {
    group: 'Mein Lernweg',
    items: [
      { id: 'home', label: 'Übersicht', ico: 'layout-dashboard' },
      { id: 'plan', label: 'Lernplan', ico: 'calendar-days' },
      { id: 'drill', label: 'Adaptive Übungen', ico: 'zap' },
      { id: 'vocab', label: 'Wortschatz', ico: 'book-open' },
      { id: 'notebook', label: 'Fehlerheft', ico: 'notebook-pen', badge: () => store.listErrors().length },
    ],
  },
  {
    group: 'Prüfungstraining',
    items: [
      { id: 'paper', label: 'Prüfungsteile', ico: 'file-text' },
      { id: 'listening', label: 'Hören', ico: 'headphones' },
      { id: 'writing', label: 'Schreiben', ico: 'pen-line' },
      { id: 'speaking', label: 'Sprechen', ico: 'mic' },
      { id: 'mock', label: 'Mocktest', ico: 'timer' },
    ],
  },
  {
    group: 'Werkzeuge',
    items: [
      { id: 'reference', label: 'Nachschlagen', ico: 'library' },
      { id: 'settings', label: 'Einstellungen', ico: 'settings' },
    ],
  },
];

function buildNav() {
  const host = document.getElementById('nav');
  host.innerHTML = NAV.map((section, index) => `
    <div class="nav-group" role="group" aria-labelledby="nav-group-${index}">
    <div class="nav-sep" id="nav-group-${index}">${shell.esc(section.group)}</div>
    ${section.items.map((item) => `
      <button class="nav-item" type="button" data-view="${item.id}" data-section="${shell.esc(section.group)}">
        <span class="ico">${icon(item.ico)}</span>
        <span>${shell.esc(item.label)}</span>
        ${item.badge ? `<span class="badge" data-badge="${item.id}"></span>` : ''}
      </button>`).join('')}
    </div>
  `).join('');

  shell.delegate(host, 'click', '[data-view]', (e, t) => navigate(t.dataset.view));
}

/**
 * The account entry. It sits in the sidebar beside the nav rather than inside `#nav`,
 * so the legacy navigation (and its "all 12 views" regression check in tools/e2e.js)
 * stays untouched. It still navigates through the same `[data-shell-view]` delegation
 * the brand button and the exam-target button already use.
 */
function buildAccountNav() {
  const host = document.getElementById('account-nav');
  if (host) host.innerHTML = accountNavHtml();
}

/* --------------------------------------------------------- mobile drawer */

let drawerOpen = false;
let mobileNav;

function setDrawer(open, restoreFocus = true) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('nav-toggle');
  const isMobile = mobileNav?.matches;
  const wasOpen = drawerOpen;
  const sidebarHadFocus = sidebar.contains(document.activeElement);
  drawerOpen = Boolean(open && isMobile);
  document.body.classList.toggle('nav-open', drawerOpen);
  toggle.setAttribute('aria-expanded', String(drawerOpen));
  toggle.setAttribute('aria-label', drawerOpen ? 'Navigation schließen' : 'Navigation öffnen');
  document.getElementById('nav-scrim').hidden = !drawerOpen;
  document.getElementById('main').inert = drawerOpen;
  sidebar.inert = Boolean(isMobile && !drawerOpen);
  if (isMobile && !drawerOpen) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');

  if (drawerOpen) {
    document.getElementById('nav-close').focus();
    // A fully hidden drawer may need its visibility change painted before a
    // browser accepts focus. Never steal focus after dismissal or a user move.
    requestAnimationFrame(() => {
      if (drawerOpen && mobileNav.matches && !sidebar.contains(document.activeElement)) {
        document.getElementById('nav-close').focus();
      }
    });
  }
  else if (isMobile && restoreFocus && (wasOpen || sidebarHadFocus)) toggle.focus();
  else if (wasOpen && !isMobile && sidebarHadFocus) sidebar.querySelector('.nav-item.active')?.focus();
}

function buildDrawer() {
  mobileNav = window.matchMedia('(max-width: 860px)');
  shell.on(document.getElementById('nav-toggle'), 'click', () => setDrawer(!drawerOpen));
  shell.on(document.getElementById('nav-close'), 'click', () => setDrawer(false));
  shell.on(document.getElementById('nav-scrim'), 'click', () => setDrawer(false));
  mobileNav.addEventListener('change', () => setDrawer(false));
  document.addEventListener('keydown', (event) => {
    if (!drawerOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDrawer(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const sidebar = document.getElementById('sidebar');
    const focusable = shell.$$('button:not(:disabled), a[href], [tabindex="0"]', sidebar);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
      event.preventDefault();
      first?.focus();
    }
  });
  shell.delegate(document.getElementById('sidebar'), 'click', '[data-shell-view]', (event, button) => navigate(button.dataset.shellView));
  setDrawer(false);
}

/* ----------------------------------------------------------- exam target */

function refreshExamTarget() {
  const host = document.getElementById('exam-target');
  if (!host) return;
  const countdown = examCountdown(store.getState().settings.examDate);
  let heading = 'Dein Prüfungstermin';
  let detail = 'Setze dein Ziel. Plane deinen Weg.';
  let action = 'Termin festlegen';
  if (countdown) {
    heading = countdown.past ? 'Dein Prüfungstermin' : countdown.days === 0 ? 'Heute ist Prüfungstag' : `Noch ${countdown.days} ${countdown.days === 1 ? 'Tag' : 'Tage'}`;
    detail = shell.fmtDate(countdown.date);
    action = 'Termin anpassen';
  }
  host.innerHTML = `
    <div class="exam-target-label">${icon('calendar-days')} <span>Dein Ziel</span></div>
    <strong>${shell.esc(heading)}</strong>
    <p>${shell.esc(detail)}</p>
    <button type="button" data-shell-view="settings">${shell.esc(action)} ${icon('arrow-right')}</button>`;
}

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'certa-theme';
const THEMES = [
  { id: 'system', label: 'Auto', title: 'Wie das System' },
  { id: 'light', label: icon('sun'), title: 'Hell' },
  { id: 'dark', label: icon('moon'), title: 'Dunkel' },
];

function readTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(id) {
  const root = document.documentElement;
  if (id === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  try {
    if (id === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, id);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  shell.$$('#theme-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === id)));
}

function buildThemeToggle() {
  const host = document.getElementById('theme-toggle');
  if (!host) return;
  host.innerHTML = THEMES.map((t) => `<button type="button" data-theme="${t.id}" title="${t.title}" aria-label="${t.title}" aria-pressed="false">${t.label}</button>`).join('');
  shell.delegate(host, 'click', '[data-theme]', (e, t) => applyTheme(t.dataset.theme));
  applyTheme(readTheme());
}

function refreshBadges() {
  shell.$$('#nav [data-badge]').forEach((el) => {
    const id = el.dataset.badge;
    const item = NAV.flatMap((s) => s.items).find((i) => i.id === id);
    if (!item?.badge) return;
    const n = item.badge();
    el.textContent = n > 0 ? String(n) : '';
    el.className = `badge pill ${n > 0 ? 'bad' : ''}`;
  });
  refreshExamTarget();
}

function navigate(id, params = {}) {
  const wasDrawerOpen = drawerOpen;
  const previousFocus = document.activeElement;
  setDrawer(false, false);
  teardownExamViews();
  shell.renderRoute(id, params).then(() => {
    refreshBadges();
    if (shell.currentViewId() !== id) return;
    window.scrollTo(0, 0);
    // Announce the new view to keyboard users, while respecting a view that
    // intentionally focused its own answer field during rendering.
    const focusWasLost = document.activeElement === document.body || document.activeElement === previousFocus;
    if (wasDrawerOpen || focusWasLost) {
      document.getElementById('view-title')?.focus({ preventScroll: true });
    }
  });
}

async function boot() {
  store.load();

  shell.registerView('home', { title: 'Übersicht', render: dashboardView });
  shell.registerView('drill', { title: 'Adaptive Übungen', render: drillView });
  shell.registerView('vocab', { title: 'Wortschatz', render: vocabView });
  shell.registerView('vocabdrill', { title: 'Wortschatz-Training', render: vocabDrillView });
  shell.registerView('notebook', { title: 'Fehlerheft', render: notebookView });
  shell.registerView('paper', { title: 'Prüfungsteile', render: paperView });
  shell.registerView('listening', { title: 'Hörverstehen', render: (el, params) => paperView(el, { ...params, group: 'HV' }) });
  shell.registerView('writing', { title: 'Schreiben', render: writingView });
  shell.registerView('speaking', { title: 'Sprechen', render: speakingView });
  shell.registerView('reference', { title: 'Nachschlagen', render: referenceHubView });
  shell.registerView('speakingguide', { title: 'Redemittel Sprechen', render: speakingGuideView });
  shell.registerView('writingguide', { title: 'Briefe schreiben', render: writingGuideView });
  shell.registerView('casesguide', { title: 'Fälle & Artikel', render: casesGuideView });
  shell.registerView('nounsguide', { title: 'Nomen & Genus', render: nounsGuideView });
  shell.registerView('grammarguide', { title: 'Grammatik', render: grammarGuideView });
  shell.registerView('sentenceguide', { title: 'Satzbau verstehen', render: sentenceGuideView });
  shell.registerView('mock', { title: 'Mocktest', render: mockView });
  shell.registerView('plan', { title: 'Lernplan', render: planView });
  shell.registerView('settings', { title: 'Einstellungen', render: settingsView });
  shell.registerView('account', { title: 'Konto', render: accountView });

  shell.setNavigator(navigate);
  buildNav();
  buildAccountNav();
  buildThemeToggle();
  buildDrawer();

  // Progress is kept on disk by the server; localStorage is only a local cache.
  // Reconcile BEFORE the first render so the app always opens on the true state,
  // whichever browser or port you happen to use.
  const sync = await store.syncFromServer();

  // Server config next: it decides whether AI features are advertised.
  const cfg = await ai.refreshStatus();
  const settings = store.getState().settings;
  if (!settings.examDate && cfg.examDate) {
    settings.examDate = cfg.examDate;
    store.saveNow();
  }

  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled rejection:', e.reason);
  });

  await shell.renderRoute('home', {});
  refreshBadges();

  if (sync.adopted) {
    shell.toast('Fortschritt vom Server geladen.', 'good', 3500);
  } else if (sync.uploaded && sync.empty === undefined) {
    // First run after an upgrade: local progress has just been migrated to disk.
  } else if (!sync.reachable) {
    shell.toast('Server nicht erreichbar – Fortschritt wird vorerst nur lokal gespeichert.', 'warn', 7000);
  }

  // Save when the tab is hidden or closed, so at most the last moment is at risk.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      store.flushNow();
    } else {
      await ai.refreshStatus();
      refreshBadges();
    }
  });
  window.addEventListener('pagehide', () => {
    store.flushNow();
  });
}

boot();
