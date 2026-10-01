/**
 * Konto (account) surface and the application session boundary (SESSION-BOUNDARY-01).
 *
 * The boundary is the ONE place that decides who the learner is and, from that, which
 * learner data the page may hold. Everything that reads or writes learner state on behalf
 * of an account goes through it:
 *
 *   - identity is resolved BEFORE learner data is read. `resolve()` asks the server
 *     (`/api/v1/account`) first and only then opens the progress store in the matching
 *     scope, so a stale or foreign record is never rendered and then swapped;
 *   - sign-out, an account switch and an expired/refused session clear private state:
 *     open draft sessions drop their text, the store drops the previous account's record
 *     (`clearAccountScope` / `setAccountScope`) - on sign-out, a switch and expiry also
 *     this browser's copy of it, whether or not the last save landed - and late responses
 *     are fenced: owned-API calls by the client's generation (`owned-client.js`), progress
 *     requests by the store's scope epoch;
 *   - a browser that was never signed in keeps the single-user path: its record is
 *     reconciled once at boot, as before, and never replaced mid-session; the one addition
 *     is that a tab return asks `/api/v1/account` again, so the page notices another tab
 *     signing in. A browser that WAS signed in and is refused fails closed to signed-out,
 *     never back to the single-user record;
 *   - the settings page and writing drafts reach the account through the boundary
 *     (`saveSettings`, `openDraft`), never by constructing their own client.
 *
 * The owned client is created exactly once, and every outcome shown to the learner comes
 * from the server's answer. The session port behind it is still the small synthetic
 * implementation, NOT Better Auth (issue #63 S5).
 */
import { createOwnedClient, OwnedClientError } from './owned-client.js';
import { createDraftSession } from './draft-session.js';
import * as appStore from './store.js';
import { esc, spinnerRow } from './shell.js';

/** Lucide "user" line icon; kept local because icons.js is owned by another slice. */
const ACCOUNT_ICON = '<svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

/* ------------------------------------------------------- session boundary */

/** Settings fields the account record owns and the boundary mirrors into the store. */
const ACCOUNT_SETTINGS = ['examDate', 'dailyGoal', 'language'];
const DRAFT_POINTER_KEY = 'b1prep.draft-pointers.v1';
/** How long a sign-out waits for the learner's last save before clearing (and forgetting) anyway. */
const SIGN_OUT_FLUSH_MS = 4000;

/**
 * Draft pointers for the draft service: identifiers only (`attemptId`, `submissionId`,
 * `pendingEventId`), never text, keyed by account id and task id. Read at call time, so the
 * module stays importable without a browser.
 */
export function localPointerStore() {
  const storage = () => {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
  };
  const readAll = () => {
    try { return JSON.parse(storage()?.getItem(DRAFT_POINTER_KEY) || '{}') || {}; } catch { return {}; }
  };
  const writeAll = (all) => {
    try { storage()?.setItem(DRAFT_POINTER_KEY, JSON.stringify(all)); } catch { /* the server copy stays authoritative */ }
  };
  return Object.freeze({
    get: (key) => readAll()[key] ?? null,
    set: (key, record) => { const all = readAll(); all[key] = record; writeAll(all); },
    delete: (key) => { const all = readAll(); delete all[key]; writeAll(all); },
  });
}

const errorCode = (error) => (error && typeof error.code === 'string' ? error.code : '');
const isOffline = (code) => code === 'network_error' || code === 'transport_unavailable';

/**
 * Create the session boundary over one owned client and one progress store.
 *
 * Phases: 'unresolved' (boot, nothing read yet), 'single-user' (accounts off or never
 * signed in on this browser: the legacy path, unchanged), 'signed-in' and 'signed-out'
 * (held nothing, persists nothing learner-derived).
 *
 * @param {object} options
 * @param {object} options.client   a createOwnedClient() instance
 * @param {object} options.store    the progress store module (./store.js)
 * @param {object} [options.pointers] draft pointer store; defaults to localPointerStore()
 * @param {Function} [options.newEventId] UUID factory passed to draft sessions
 */
export function createSessionBoundary({ client, store, pointers = localPointerStore(), newEventId } = {}) {
  if (!client || !store) throw new Error('createSessionBoundary needs a client and a store');
  let phase = 'unresolved';
  let reason = '';
  let account = null;
  let settingsRevision = null;
  let resolving = null;
  const listeners = new Set();
  const drafts = new Set();

  /*
   * N-2 (`session-boundary-02-review-hermes-20261001-a`). The unconditional forget on the
   * expired/signed-out path destroys unsaved work exactly as a sign-out does, and that path used to
   * tell the learner NOTHING - the discard notice existed only in `handleSignOut`.
   *
   * This has to be a field rather than a caller-side check, and that is the whole trap: `signOut()`
   * returns `lastSaveReached`, but `resolve()` returns only this snapshot, so a caller asking
   * `result.lastSaveReached` in the expiry path gets `undefined` and the notice can never fire. A
   * notice that cannot fire is the same defect class as a check that cannot fail.
   *
   * Set in `enterSignedOut` at the moment the discard happens, because that is synchronous and
   * clears the scope before any await could observe it. Cleared by the next successful sign-in, so a
   * later signed-out view cannot re-report an old discard.
   */
  let discardedUnsaved = false;

  const snapshot = () => ({ phase, reason, discardedUnsaved, account: account ? { ...account } : null });
  function notify() {
    const view = snapshot();
    for (const listener of listeners) {
      try { listener(view); } catch (error) { console.error(error); }
    }
  }
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** A step that awaited is still current only if the client is on the same account and generation. */
  const live = (gen, id) => client.generation === gen && (client.getAccount() || {}).id === id;

  function closeDrafts() {
    for (const session of drafts) {
      try { session.close(); } catch { /* closing only drops text */ }
    }
    drafts.clear();
  }

  function enterSingleUser(why) {
    closeDrafts();
    account = null;
    settingsRevision = null;
    phase = 'single-user';
    reason = why;
  }

  /**
   * The single-user path reconciles its record with the server ONCE, when the page first
   * resolves - exactly the old boot-time `syncFromServer()`. A later resolve (a tab return)
   * still re-checks identity, so a page notices another tab signing in, but a page that
   * was single-user and stays so is not reconciled again: its in-memory record is never
   * replaced mid-session (SESSION-BOUNDARY-02 F3).
   */
  async function singleUser(why) {
    const already = phase === 'single-user';
    enterSingleUser(why);
    if (already) return snapshot();
    const sync = await store.syncFromServer();
    return { ...snapshot(), sync };
  }

  /**
   * Fail closed: drop the account's text and record, and persist nothing learner-derived.
   * When the server has said the session is gone (any 401: expired, or signed out
   * elsewhere), this browser's copy of every account is forgotten too. Offline, a refused
   * answer or accounts switched off say nothing about the session, so the copy is kept,
   * unread, for the same account to resume; the next 401, sign-out or switch removes it.
   */
  function enterSignedOut(why) {
    const discards = why === 'expired' || why === 'signed_out';
    // Read the pending signal BEFORE clearing: `clearAccountScope` is synchronous and drops the
    // scope, so afterwards there is nothing left to ask. Only a page that was actually signed in
    // can have work to lose - a fresh browser that never signed in discards nothing, and claiming
    // otherwise would train the learner to ignore the notice.
    discardedUnsaved = discards && phase === 'signed-in' && store.syncStatus().state === 'pending';
    closeDrafts();
    store.clearAccountScope({ forget: discards });
    if (client.getAccount()) client.clear();
    account = null;
    settingsRevision = null;
    phase = 'signed-out';
    reason = why;
  }

  /** Server settings win once the account has saved any (revision > 0). */
  async function adoptServerSettings(gen, id) {
    let record;
    try {
      record = await client.readSettings();
    } catch (error) {
      const code = errorCode(error);
      if (code === 'stale_session') return false; // a newer identity owns the page now
      if (code === 'unauthenticated') { enterSignedOut('expired'); return false; }
      return true; // offline or refused: the account's cached settings stay in use
    }
    if (!live(gen, id)) return false;
    settingsRevision = record.revision;
    if (record.revision > 0) {
      const settings = store.getState().settings;
      let changed = false;
      for (const key of ACCOUNT_SETTINGS) {
        if (record.settings[key] !== undefined && settings[key] !== record.settings[key]) {
          settings[key] = record.settings[key];
          changed = true;
        }
      }
      if (changed) store.saveNow();
    }
    return true;
  }

  async function enterAccount(verified) {
    const gen = client.generation;
    const scope = store.getAccountScope();
    const switching = phase !== 'signed-in' || !account || account.id !== verified.id || scope.accountId !== verified.id;
    let sync = { adopted: false, reachable: true };
    // A successful sign-in supersedes any earlier discard, so a previous notice cannot be
    // re-reported against this account's signed-out view later.
    discardedUnsaved = false;
    account = { id: verified.id, email: verified.email };
    if (switching) {
      closeDrafts();
      settingsRevision = null;
      // issue #63: the single-user blob is never assigned to an account automatically.
      // A switch forgets every other account's copy in this browser.
      store.setAccountScope(verified.id, { adoptLegacy: false, forgetOthers: true });
      phase = 'signed-in';
      reason = '';
      sync = await store.syncFromServer();
      if (!live(gen, verified.id)) return { ...snapshot(), superseded: true };
      if (!(await adoptServerSettings(gen, verified.id))) return { ...snapshot(), superseded: true };
    }
    phase = 'signed-in';
    return { ...snapshot(), sync, switched: switching };
  }

  async function resolveNow() {
    let verified;
    try {
      verified = await client.refreshAccount();
    } catch (error) {
      const code = errorCode(error);
      // A newer transition owns the state; this answer is stale.
      if (code === 'stale_session') return { ...snapshot(), superseded: true };
      const scoped = store.getAccountScope().mode !== 'legacy';
      if (phase === 'signed-in' && isOffline(code)) return { ...snapshot(), offline: true };
      if (!scoped && (code === 'not_found' || isOffline(code))) {
        return singleUser(code === 'not_found' ? 'accounts_off' : 'offline');
      }
      // This browser held an account: anything but a verified identity fails closed.
      enterSignedOut(code === 'not_found' ? 'accounts_off' : isOffline(code) ? 'offline' : 'refused');
      return snapshot();
    }
    if (verified) return enterAccount(verified);
    // 401. A browser that never signed in stays on the single-user path, unchanged; one that
    // was signed in has expired and fails closed.
    const mode = store.getAccountScope().mode;
    if (mode === 'legacy' && phase !== 'signed-in') return singleUser('anonymous');
    enterSignedOut(mode === 'signed-out' && phase !== 'signed-in' ? 'signed_out' : 'expired');
    return snapshot();
  }

  /**
   * Resolve identity, THEN open the matching learner scope. Concurrent callers share one
   * resolution. Resolves to the boundary snapshot plus the progress `sync` outcome.
   */
  function resolve() {
    if (!resolving) {
      const previous = phase;
      const previousId = account ? account.id : null;
      resolving = resolveNow().finally(() => { resolving = null; });
      resolving.then((result) => {
        if (result.phase !== previous || (result.account ? result.account.id : null) !== previousId) notify();
      }, () => {});
    }
    return resolving;
  }

  async function authenticate(action) {
    const verified = await action();
    const result = await enterAccount(verified);
    notify();
    return result;
  }

  const signIn = (credentials) => authenticate(() => client.signIn(credentials));
  const signUp = (details) => authenticate(() => client.signUp(details));

  /**
   * Sign out. The learner's last change is sent first, under THEIR scope and bounded in
   * time. Then every piece of private state is dropped locally - including this browser's
   * copy of the account, WHETHER OR NOT that last save reached the server - BEFORE the
   * server is told, so neither a failed save nor a failed sign-out leaves the account
   * readable here. Resolves to the snapshot plus `lastSaveReached` (null when no account
   * was signed in); a failed server sign-out rejects with the same field on the error, so
   * the caller can tell the learner the truth about the discarded change either way.
   */
  async function signOut() {
    let lastSaveReached = null;
    if (phase === 'signed-in') {
      let timer = null;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), SIGN_OUT_FLUSH_MS); });
      lastSaveReached = (await Promise.race([Promise.resolve(store.flushNow()).catch(() => false), timeout])) === true;
      clearTimeout(timer);
    }
    closeDrafts();
    store.clearAccountScope({ forget: true });
    account = null;
    settingsRevision = null;
    phase = 'signed-out';
    reason = 'signed_out';
    notify();
    try {
      await client.signOut();
    } catch (error) {
      if (error && typeof error === 'object') error.lastSaveReached = lastSaveReached;
      throw error;
    }
    return { ...snapshot(), lastSaveReached };
  }

  /**
   * Save the account-owned settings against the revision this page last saw. Resolves to
   * `{saved: true, revision}`, or `{saved: false, reason}` when there is no account
   * ('not_signed_in') or another device moved the record ('conflict'). A transport failure
   * rejects; an expired session fails closed.
   */
  async function saveSettings(fields) {
    if (phase !== 'signed-in' || !account) return { saved: false, reason: 'not_signed_in' };
    const gen = client.generation;
    const id = account.id;
    const settings = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (value !== undefined) settings[key] = value;
    }
    try {
      if (settingsRevision === null) {
        settingsRevision = (await client.readSettings()).revision;
        if (!live(gen, id)) return { saved: false, reason: 'stale_session' };
      }
      const saved = await client.saveSettings({ expectedRevision: settingsRevision, settings });
      if (!live(gen, id)) return { saved: false, reason: 'stale_session' };
      settingsRevision = saved.revision;
      return { saved: true, revision: saved.revision };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'stale_session') return { saved: false, reason: 'stale_session' };
      if (code === 'conflict') return { saved: false, reason: 'conflict' };
      if (code === 'unauthenticated') { enterSignedOut('expired'); notify(); return { saved: false, reason: 'expired' }; }
      throw error;
    }
  }

  /**
   * Open the account's writing draft for `taskId` through the draft service. The session is
   * owned by the boundary: any identity transition closes it and drops its text.
   */
  async function openDraft(taskId) {
    if (phase !== 'signed-in') throw new OwnedClientError('unauthenticated', { message: 'Sign in before opening a draft' });
    const session = createDraftSession({ client, pointers, taskId, newEventId });
    drafts.add(session);
    try {
      await session.open();
    } catch (error) {
      drafts.delete(session);
      if (errorCode(error) === 'unauthenticated') { enterSignedOut('expired'); notify(); }
      throw error;
    }
    return session;
  }

  return Object.freeze({
    resolve,
    signIn,
    signUp,
    signOut,
    saveSettings,
    openDraft,
    subscribe,
    status: snapshot,
    get phase() { return phase; },
    get client() { return client; },
    get openDrafts() { return drafts.size; },
  });
}

/** The one transport instance and the one boundary for the whole page. */
let client = null;
let boundary = null;

/**
 * The page's owned client. Only the boundary below should drive it; it stays exported for
 * the existing Konto checks, which assert there is exactly one instance.
 */
export function ownedClient() {
  if (!client) {
    // A thin wrapper, not a bare `globalThis.fetch` reference: calling fetch detached
    // from `window` throws "Illegal invocation" in Chromium.
    client = createOwnedClient({ fetchImpl: (input, init) => globalThis.fetch(input, init) });
  }
  return client;
}

/** The page's session boundary. app.js resolves it before any learner data is read. */
export function session() {
  if (!boundary) boundary = createSessionBoundary({ client: ownedClient(), store: appStore });
  return boundary;
}

/**
 * Honest, learner-facing German for a transport error. The server error token (`detail`)
 * is checked first where it is more specific than the HTTP status, e.g. a 401 sign-in
 * carries `invalid_credentials` and a 409 sign-up carries `user_exists`.
 */
export function messageForError(err) {
  if (!(err instanceof OwnedClientError)) return 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut.';
  const { code, detail } = err;
  if (code === 'invalid_request') return 'Bitte prüfe deine Eingaben.';
  if (detail === 'invalid_credentials') return 'E-Mail-Adresse oder Passwort stimmt nicht.';
  if (detail === 'user_exists') return 'Für diese E-Mail-Adresse gibt es schon ein Konto. Melde dich stattdessen an.';
  if (detail === 'weak_password' || detail === 'invalid_password') return 'Das Passwort wurde abgelehnt. Bitte wähle ein anderes.';
  switch (code) {
    case 'transport_unavailable':
    case 'network_error':
      return 'Der Server ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.';
    case 'unauthenticated':
      return 'Die Sitzung ist nicht mehr angemeldet. Bitte melde dich erneut an.';
    case 'not_found':
      return 'Konten sind auf diesem Server nicht aktiviert.';
    case 'conflict':
      return 'Die Anfrage passt nicht zum aktuellen Stand auf dem Server. Bitte versuche es erneut.';
    case 'bad_request':
    case 'unprocessable':
      return 'Der Server hat die Eingaben abgelehnt. Bitte prüfe sie und versuche es erneut.';
    case 'too_large':
      return 'Die Eingabe ist zu lang.';
    case 'forbidden':
      return 'Diese Anfrage ist nicht erlaubt.';
    case 'stale_session':
      return 'Die Sitzung hat sich geändert. Bitte versuche es erneut.';
    case 'unsupported_contract':
    case 'malformed_response':
      return 'Der Server hat unerwartet geantwortet. Bitte versuche es später erneut.';
    case 'server_error':
    case 'http_error':
      return 'Der Server konnte die Anfrage nicht verarbeiten. Bitte versuche es später erneut.';
    default:
      return 'Es ist ein Fehler aufgetreten. Bitte versuche es erneut.';
  }
}

/* --------------------------------------------------------------- rendering */

function statusHtml(text = '') {
  return `<div data-account-status class="small" aria-live="polite">${text}</div>`;
}

function errorHtml(message = '') {
  return `<div data-account-error class="account-error" role="alert"${message ? '' : ' hidden'}>${esc(message)}</div>`;
}

/**
 * What the account does, said plainly and without a claim the code cannot support: no
 * "synchronised" claim, no retention claim, and the browser's earlier progress is not moved.
 */
function workCardHtml() {
  return `
    <div class="card">
      <h3>Was passiert mit deiner Arbeit?</h3>
      <p class="muted small">
        Angemeldet gehören Fortschritt, Fehlerheft und Einstellungen zu deinem Konto und werden
        beim Server unter deinem Konto gespeichert. Meldest du dich in einem anderen Browser an,
        lädt die App sie von dort.
      </p>
      <p class="muted small">
        Fortschritt, der ohne Konto in diesem Browser entstanden ist, wird <b>nicht</b> in das
        Konto übernommen und auch nicht gelöscht.
      </p>
      <p class="muted small">
        Nach dem Abmelden zeigt die App nichts mehr aus deinem Konto an, und die Kopie in diesem
        Browser wird gelöscht – auch wenn die letzte Speicherung den Server nicht erreicht hat;
        das wird dir dann angezeigt. Was du danach übst, wird nicht gespeichert, bis du dich
        wieder anmeldest.
      </p>
    </div>`;
}

function paintSignedOut(view, message = '', email = '') {
  view.el.innerHTML = `
    <div class="card">
      <h3>Konto</h3>
      <p class="muted small">
        Melde dich an oder erstelle ein Konto. Eine Meldung erscheint erst, wenn der Server
        geantwortet hat — eine fehlgeschlagene Anmeldung wird als Fehler gezeigt, nicht als Erfolg.
      </p>
      ${errorHtml(message)}
      ${statusHtml()}
      <form id="account-signin-form" novalidate>
        <label class="field"><span>E-Mail</span>
          <input type="email" id="signin-email" name="email" autocomplete="username" spellcheck="false" value="${esc(email)}">
        </label>
        <label class="field"><span>Passwort</span>
          <input type="password" id="signin-password" name="password" autocomplete="current-password">
        </label>
        <div class="btn-row"><button class="primary" type="submit" data-signin>Anmelden</button></div>
      </form>
      <hr>
      <h3>Neu hier? Konto erstellen</h3>
      <form id="account-signup-form" novalidate>
        <label class="field"><span>Name</span>
          <input type="text" id="signup-name" name="name" autocomplete="name">
        </label>
        <label class="field"><span>E-Mail</span>
          <input type="email" id="signup-email" name="email" autocomplete="email" spellcheck="false">
        </label>
        <label class="field"><span>Passwort</span>
          <input type="password" id="signup-password" name="password" autocomplete="new-password">
        </label>
        <div class="btn-row"><button class="primary" type="submit" data-signup>Konto erstellen</button></div>
      </form>
    </div>
    ${workCardHtml()}`;

  view.el.querySelector('#account-signin-form').addEventListener('submit', (event) => {
    event.preventDefault();
    handleSignIn(view);
  });
  view.el.querySelector('#account-signup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    handleSignUp(view);
  });
}

function paintSignedIn(view, account) {
  const email = account && typeof account.email === 'string' && account.email ? account.email : '–';
  view.el.innerHTML = `
    <div class="card">
      <h3>Konto</h3>
      <p class="muted small">Du bist angemeldet.</p>
      <div class="account-identity">
        <span class="label">E-Mail</span>
        <strong data-account-email>${esc(email)}</strong>
      </div>
      ${statusHtml()}
      <div class="btn-row">
        <button class="danger" data-signout>Abmelden</button>
      </div>
    </div>
    ${workCardHtml()}`;

  view.el.querySelector('[data-signout]').addEventListener('click', () => handleSignOut(view));
}

/**
 * Paint the outcome of a sign-in or sign-up. A sign-out (or another account) that overtook
 * it while it was in flight wins: the superseded result is painted as signed out, never as
 * the account that was being opened.
 */
function paintAuthenticated(view, result) {
  const now = result && !result.superseded ? result : session().status();
  if (now.phase === 'signed-in' && now.account) paintSignedIn(view, now.account);
  else paintSignedOut(view, '');
}

function paintUnavailable(view, signedOut = false) {
  // A browser that was signed in is NOT handed back to the single-user record (fail closed).
  const detail = signedOut
    ? 'Dieser Browser war mit einem Konto angemeldet; die App zeigt deshalb keine gespeicherten Daten an.'
    : 'Die App läuft weiter wie bisher im Einzelplatz-Modus; dein Fortschritt bleibt in diesem Browser gespeichert.';
  view.el.innerHTML = `
    <div class="card">
      <h3>Konto</h3>
      <p class="muted small">
        Konten sind auf diesem Server nicht aktiviert. ${detail}
      </p>
      <div class="btn-row"><button data-account-retry>Erneut prüfen</button></div>
    </div>
    ${workCardHtml()}`;
  wireRetry(view);
}

function paintOffline(view) {
  view.el.innerHTML = `
    <div class="card">
      <h3>Konto</h3>
      <p class="muted small">
        Der Server ist nicht erreichbar. Anmelden und Konto erstellen brauchen eine Verbindung
        zum Server; die App selbst funktioniert offline weiter.
      </p>
      <div class="btn-row"><button data-account-retry>Erneut versuchen</button></div>
    </div>
    ${workCardHtml()}`;
  wireRetry(view);
}

function wireRetry(view) {
  view.el.querySelector('[data-account-retry]')?.addEventListener('click', () => accountView(view.el));
}

/** Freeze the view while a request is in flight; the outcome waits for the server. */
function setBusy(view, text) {
  view.el.setAttribute('aria-busy', 'true');
  view.el.querySelectorAll('input, button').forEach((node) => { node.disabled = true; });
  const status = view.el.querySelector('[data-account-status]');
  if (status) status.innerHTML = `<span class="spinner"></span> ${esc(text)}`;
}

/* ------------------------------------------------------------------- actions */

async function handleSignIn(view) {
  const email = view.el.querySelector('#signin-email').value.trim();
  const password = view.el.querySelector('#signin-password').value;
  setBusy(view, 'Anmeldung läuft…');
  try {
    const result = await session().signIn({ email, password });
    paintAuthenticated(view, result);
  } catch (err) {
    paintSignedOut(view, messageForError(err), email);
  }
}

async function handleSignUp(view) {
  const name = view.el.querySelector('#signup-name').value.trim();
  const email = view.el.querySelector('#signup-email').value.trim();
  const password = view.el.querySelector('#signup-password').value;
  setBusy(view, 'Konto wird erstellt…');
  try {
    const result = await session().signUp({ name, email, password });
    paintAuthenticated(view, result);
  } catch (err) {
    paintSignedOut(view, messageForError(err), email);
  }
}

/** Said when the sign-out had to discard a change the server never confirmed. */
const UNSAVED_DISCARDED = 'Deine letzte Speicherung hat den Server nicht erreicht. Änderungen seit der letzten '
  + 'erfolgreichen Speicherung wurden zum Schutz deiner Daten aus diesem Browser gelöscht.';

async function handleSignOut(view) {
  setBusy(view, 'Abmeldung läuft…');
  const messages = [];
  try {
    const result = await session().signOut();
    if (result.lastSaveReached === false) messages.push(UNSAVED_DISCARDED);
  } catch (err) {
    // The boundary clears every piece of private state before it talks to the server, so a
    // failed sign-out still leaves the page signed out - report the real failure, do not pretend.
    if (err && err.lastSaveReached === false) messages.push(UNSAVED_DISCARDED);
    messages.push(messageForError(err));
  }
  paintSignedOut(view, messages.join(' '));
}

/**
 * Render the Konto view. The signed-in/out state is decided by the boundary, which asks the
 * server's `/api/v1/account`, never by a guess: 401 (or a verified account) is authoritative,
 * a missing endpoint means accounts are not mounted, and a transport failure is reported as
 * such instead of inventing a state.
 */
export async function accountView(el) {
  const view = { el };
  el.innerHTML = `<div class="card"><h3>Konto</h3>${spinnerRow('Kontostatus wird geladen…')}</div>`;
  try {
    const result = await session().resolve();
    if (result.phase === 'signed-in') paintSignedIn(view, result.account);
    else if (result.reason === 'accounts_off') paintUnavailable(view, result.phase === 'signed-out');
    else if (result.reason === 'offline') paintOffline(view);
    else paintSignedOut(view, result.discardedUnsaved ? UNSAVED_DISCARDED : '');
  } catch (err) {
    paintSignedOut(view, messageForError(err));
  }
  return undefined;
}

/** Build the sidebar "Konto" entry. */
export function accountNavHtml() {
  return `<button class="nav-item" type="button" data-shell-view="account" data-section="Konto">
    <span class="ico">${ACCOUNT_ICON}</span>
    <span>Konto</span>
  </button>`;
}
