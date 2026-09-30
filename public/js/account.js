/**
 * Konto (account) surface: the first and only page code that reaches the owned API.
 *
 * The server side of accounts was built and proven rounds ago, but no page imported the
 * client, so a human could not sign up, sign in or sign out. This module is that surface
 * and nothing more. It is a thin UI layer over the already-proven transport in
 * `owned-client.js`:
 *
 *   - the client is created exactly once, `createOwnedClient({ fetchImpl })`, and nowhere
 *     else constructs one;
 *   - every outcome shown to the learner comes from the server's answer. While a request
 *     is in flight the controls are disabled and no outcome is shown yet; a failed sign-in
 *     is rendered as a failure, never as a signed-in state, and no success is invented;
 *   - the German copy states only what this code can do. There is no "synchronised"
 *     claim, no cross-device claim and no retention claim.
 *
 * Deliberately NOT in this slice (see TASK-ACCOUNT-UI-01): attempts, drafts, progress and
 * settings are not wired to the account. Signing in here does not move, merge or delete
 * the browser's existing progress, and the app keeps working exactly as before whether or
 * not anyone signs in. That wiring is the next slice.
 */
import { createOwnedClient, OwnedClientError } from './owned-client.js';
import { esc, spinnerRow } from './shell.js';

/** Lucide "user" line icon; kept local because icons.js is owned by another slice. */
const ACCOUNT_ICON = '<svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

/** The one transport instance for the whole page. */
let client = null;

/**
 * Exported deliberately: `settingsView` needs the account-scoped settings record, and creating a
 * SECOND client there would quietly defeat the generation fencing this module exists to provide -
 * a stale-session response would be fenced on one instance and trusted on the other.
 */
export function ownedClient() {
  if (!client) {
    // A thin wrapper, not a bare `globalThis.fetch` reference: calling fetch detached
    // from `window` throws "Illegal invocation" in Chromium.
    client = createOwnedClient({ fetchImpl: (input, init) => globalThis.fetch(input, init) });
  }
  return client;
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
 * What the account is for, said plainly and without a claim the code cannot support.
 * The account is the reason attempts/drafts/settings will follow the learner instead of
 * the browser, but this slice only creates or opens the account.
 */
function workCardHtml() {
  return `
    <div class="card">
      <h3>Was passiert mit deiner Arbeit?</h3>
      <p class="muted small">
        Ein Konto ist dafür gedacht, dass deine Versuche, Entwürfe und Einstellungen dir folgen
        statt nur in diesem Browser zu bleiben.
      </p>
      <p class="muted small">
        Dieser Schritt legt nur das Konto an bzw. meldet es an: Der Fortschritt, der schon in
        diesem Browser liegt, wird dabei <b>nicht</b> verändert und noch <b>nicht</b> mit dem
        Konto verknüpft — das kommt in einem späteren Schritt.
      </p>
      <p class="muted small">
        Ohne Anmeldung funktioniert die App genau wie bisher weiter; dein Fortschritt bleibt
        dann in diesem Browser gespeichert.
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

function paintUnavailable(view) {
  view.el.innerHTML = `
    <div class="card">
      <h3>Konto</h3>
      <p class="muted small">
        Konten sind auf diesem Server nicht aktiviert. Die App läuft weiter wie bisher im
        Einzelplatz-Modus; dein Fortschritt bleibt in diesem Browser gespeichert.
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
    const account = await ownedClient().signIn({ email, password });
    paintSignedIn(view, account);
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
    const account = await ownedClient().signUp({ name, email, password });
    paintSignedIn(view, account);
  } catch (err) {
    paintSignedOut(view, messageForError(err), email);
  }
}

async function handleSignOut(view) {
  setBusy(view, 'Abmeldung läuft…');
  let message = '';
  try {
    await ownedClient().signOut();
  } catch (err) {
    // signOut() clears the local identity before it talks to the server, so a failed
    // sign-out still leaves the page signed out - report the real failure, do not pretend.
    message = messageForError(err);
  }
  paintSignedOut(view, message);
}

/**
 * Render the Konto view. The signed-in/out state is decided by the server's
 * `/api/v1/account` answer, never by a guess: 401 (or a verified account) is authoritative,
 * a missing endpoint means accounts are not mounted, and a transport failure is reported as
 * such instead of inventing a state.
 */
export async function accountView(el) {
  const view = { el };
  el.innerHTML = `<div class="card"><h3>Konto</h3>${spinnerRow('Kontostatus wird geladen…')}</div>`;
  try {
    const account = await ownedClient().refreshAccount();
    if (account) paintSignedIn(view, account);
    else paintSignedOut(view, '');
  } catch (err) {
    const code = err instanceof OwnedClientError ? err.code : '';
    if (code === 'not_found') paintUnavailable(view);
    else if (code === 'network_error' || code === 'transport_unavailable') paintOffline(view);
    else paintSignedOut(view, messageForError(err));
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
