'use strict';

// Recovery links are bearer credentials. Keep them only in this page's memory,
// remove them from the URL immediately, and never put them in logs or storage.
const $ = id => document.getElementById(id);
const page = document.body.dataset.page;
const parameters = new URLSearchParams(location.search);
const tokenWasProvided = parameters.has('token');
let token = parameters.get('token') || '';
if (tokenWasProvided) history.replaceState(null, '', location.pathname);
const tokenValid = token.length > 0 && token.length <= 512;
let busy = false;

function message(id, text) {
  const target = $(id);
  target.textContent = text;
  target.hidden = !text;
}
function clearMessages() {
  message('error', '');
  message('status', '');
  $('success').hidden = true;
}
function setBusy(value, text = '') {
  busy = value;
  for (const control of document.querySelectorAll('form input, form button, .auth-tabs button')) {
    control.disabled = value;
  }
  for (const form of document.querySelectorAll('form')) form.setAttribute('aria-busy', String(value));
  message('status', text);
}
function errorMessage(status, payload) {
  const code = payload && (payload.error || payload.code);
  if (code === 'invalid_token') return 'Dieser Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte fordere einen neuen Link an.';
  if (status === 401) return 'E-Mail oder Passwort ist falsch. Bitte prüfe deine Eingaben.';
  if (code === 'invalid_email') return 'Bitte gib eine gültige E-Mail-Adresse ein.';
  if (code === 'invalid_name') return 'Bitte gib deinen Namen ein.';
  if (code === 'invalid_password') return 'Bitte gib ein Passwort mit höchstens 256 Zeichen ein.';
  if (code === 'user_exists') return 'Die Registrierung konnte nicht abgeschlossen werden. Versuche, dich anzumelden, oder nutze „Passwort vergessen?“.';
  if (status === 422) return 'Bitte prüfe deine Eingaben.';
  if (status === 403) return 'Diese Anfrage ist derzeit nicht freigegeben. Bitte wende dich an das Pilotteam.';
  if (status === 429) return 'Zu viele Anfragen. Bitte warte einige Minuten und versuche es dann erneut.';
  if (code === 'recovery_unavailable' || code === 'verification_unavailable') return 'Dieser Dienst ist gerade nicht verfügbar. Bitte versuche es später erneut oder wende dich an das Pilotteam.';
  if (status >= 500) return 'Der Server ist gerade nicht erreichbar. Bitte versuche es später erneut.';
  return 'Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.';
}
function invalidateToken() {
  token = '';
  const form = $(page === 'reset' ? 'form-reset' : 'form-verify');
  if (form) {
    form.reset();
    form.hidden = true;
  }
  $('request-another').hidden = false;
}
async function post(path, body, pending) {
  if (busy) return null;
  clearMessages();
  setBusy(true, pending);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* Non-JSON refusals remain errors. */ }
    if (!response.ok || payload?.ok !== true) {
      message('error', errorMessage(response.status, payload));
      if (payload?.error === 'invalid_token') invalidateToken();
      return null;
    }
    return payload;
  } catch (error) {
    message('error', error.name === 'AbortError'
      ? (page === 'reset' && tokenWasProvided ? 'Der Server hat nicht rechtzeitig geantwortet. Falls dein Passwort bereits geändert wurde, kannst du dich damit anmelden.' : 'Der Server hat nicht rechtzeitig geantwortet. Bitte prüfe deine Verbindung und versuche es erneut.')
      : 'Keine Verbindung zum Server. Deine Anfrage konnte nicht bestätigt werden. Bitte prüfe deine Internetverbindung und versuche es erneut.');
    return null;
  } finally {
    clearTimeout(timeout);
    setBusy(false);
  }
}

if (page === 'signin') {
  function selectTab(which, focus = true) {
    if (busy) return;
    const signin = which === 'signin';
    $('form-signin').hidden = !signin;
    $('form-signup').hidden = signin;
    $('tab-signin').setAttribute('aria-pressed', String(signin));
    $('tab-signup').setAttribute('aria-pressed', String(!signin));
    $('auth-title').textContent = signin ? 'Willkommen zurück' : 'Dein nächster Schritt';
    $('auth-intro').textContent = signin ? 'Melde dich an und setze deine Übungen fort.' : 'Erstelle dein kostenloses Konto für den Hatoove-Pilot.';
    clearMessages();
    if (focus) $(signin ? 'si-email' : 'su-name').focus();
  }
  $('tab-signin').addEventListener('click', () => selectTab('signin'));
  $('tab-signup').addEventListener('click', () => selectTab('signup'));
  if (parameters.get('mode') === 'signup') selectTab('signup', false);
  for (const kind of ['signin', 'signup']) {
    $(`form-${kind}`).addEventListener('submit', async event => {
      event.preventDefault();
      const prefix = kind === 'signin' ? 'si' : 'su';
      const body = { email: $(`${prefix}-email`).value.trim(), password: $(`${prefix}-password`).value };
      if (kind === 'signup') body.name = $('su-name').value.trim();
      const result = await post(`/api/auth/sign-${kind === 'signin' ? 'in' : 'up'}/email`, body,
        kind === 'signin' ? 'Du wirst angemeldet …' : 'Dein Konto wird erstellt …');
      if (result) location.replace('/app/');
    });
  }
} else if (page === 'reset' || page === 'verify') {
  const isReset = page === 'reset';
  if (tokenWasProvided) {
    $('form-request').hidden = true;
    $('auth-title').textContent = isReset ? 'Neues Passwort festlegen' : 'E-Mail-Adresse bestätigen';
    $('auth-intro').textContent = isReset ? 'Speichere ein neues Passwort für dein Konto.' : 'Dein Link ist bereit. Bestätige jetzt deine E-Mail-Adresse.';
    $(isReset ? 'form-reset' : 'form-verify').hidden = !tokenValid;
    if (!tokenValid) {
      message('error', errorMessage(400, { error: 'invalid_token' }));
      invalidateToken();
    }
  }
  $('form-request').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await post(isReset ? '/api/auth/request-password-reset' : '/api/auth/send-verification-email',
      { email: $('request-email').value.trim() }, 'Deine Anfrage wird übermittelt …');
    if (result) {
      message('status', 'Wenn diese Adresse zu einem passenden Konto gehört, erhält das Pilotteam die Anfrage. Eine Person sendet dir den Link über den vereinbarten Kontaktweg. Es wurde keine automatische E-Mail verschickt.');
      $('request-submit').textContent = 'Link erneut anfordern';
    }
  });
  $(isReset ? 'form-reset' : 'form-verify').addEventListener('submit', async event => {
    event.preventDefault();
    if (!token || busy) return;
    if (isReset && $('new-password').value !== $('confirm-password').value) {
      message('error', 'Die beiden Passwörter stimmen nicht überein.');
      $('confirm-password').focus();
      return;
    }
    const result = await post(isReset ? '/api/auth/reset-password' : '/api/auth/verify-email',
      isReset ? { token, newPassword: $('new-password').value } : { token },
      isReset ? 'Dein Passwort wird gespeichert …' : 'Deine E-Mail-Adresse wird bestätigt …');
    if (result) {
      token = '';
      event.target.reset();
      event.target.hidden = true;
      event.target.closest('.card').hidden = true;
      $('back-signin').hidden = true;
      $('auth-title').textContent = isReset ? 'Passwort geändert' : 'Adresse bestätigt';
      $('auth-intro').hidden = true;
      document.querySelector('.auth-notice').hidden = true;
      $('request-another').hidden = true;
      $('success-message').textContent = isReset
        ? 'Dein Passwort wurde geändert. Frühere Sitzungen sind beendet. Melde dich jetzt mit deinem neuen Passwort an.'
        : 'Deine E-Mail-Adresse ist bestätigt. Melde dich mit deinem Passwort an, um weiterzuüben.';
      $('success').hidden = false;
    }
  });
}
