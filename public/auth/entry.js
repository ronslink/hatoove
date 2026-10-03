import { LOCALES, initialLocale, getLocale, setLocale, subscribeLocale, t, translateDom } from '../assets/i18n/core.js';
import '../assets/i18n/common.js';
import '../assets/i18n/auth-messages.js';

'use strict';

// This public entry must not import the authenticated app module. Keep the narrow validator in
// parity with checkout.js; payment-client-check exercises both against the same hostile inputs.
export function checkoutAuthReturn(search, hash = '') {
  const values = new URLSearchParams(search).getAll('returnTo');
  if (values.length > 1) return '/app/';
  const target = values.length ? values[0] : '/app/' + hash;
  const match = /^\/app\/#\/checkout\?order=([^&]+)(?:&checkout=stub)?$/.exec(target);
  return match && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(match[1]) ? target : '/app/';
}

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

function bind(id, key) {
  const target = $(id);
  if (key) target.dataset.i18n = 'auth.' + key;
  else delete target.dataset.i18n;
  target.textContent = key ? t('auth.' + key) : '';
}
function message(id, key) {
  const target = $(id);
  bind(id, key);
  target.hidden = !key;
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
  if (code === 'invalid_token') return 'invalidToken';
  if (status === 401) return 'credentials';
  if (code === 'invalid_email') return 'invalidEmail';
  if (code === 'invalid_name') return 'invalidName';
  if (code === 'invalid_password') return 'invalidPassword';
  if (code === 'invalid_language') return 'invalidLanguage';
  if (code === 'user_exists') return 'userExists';
  if (status === 422) return 'invalidInput';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'throttled';
  if (code === 'recovery_unavailable' || code === 'verification_unavailable') return 'unavailable';
  if (status >= 500) return 'server';
  return 'failed';
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
      ? (page === 'reset' && tokenWasProvided ? 'resetTimeout' : 'timeout')
      : 'offline');
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
    bind('auth-title', signin ? 'welcome' : 'signupTitle');
    bind('auth-intro', signin ? 'signinIntro' : 'signupIntro');
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
      if (kind === 'signup') {
        body.name = $('su-name').value.trim();
        body.language = getLocale();
      }
      const result = await post(`/api/auth/sign-${kind === 'signin' ? 'in' : 'up'}/email`, body,
        kind === 'signin' ? 'signingIn' : 'signingUp');
      if (result) location.replace(checkoutAuthReturn(location.search, location.hash));
    });
  }
} else if (page === 'reset' || page === 'verify') {
  const isReset = page === 'reset';
  if (tokenWasProvided) {
    $('form-request').hidden = true;
    bind('auth-title', isReset ? 'resetTitle' : 'verifyTitle');
    bind('auth-intro', isReset ? 'resetReady' : 'verifyReady');
    $(isReset ? 'form-reset' : 'form-verify').hidden = !tokenValid;
    if (!tokenValid) {
      message('error', errorMessage(400, { error: 'invalid_token' }));
      invalidateToken();
    }
  }
  $('form-request').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await post(isReset ? '/api/auth/request-password-reset' : '/api/auth/send-verification-email',
      { email: $('request-email').value.trim() }, 'requesting');
    if (result) {
      message('status', 'delivery');
      bind('request-submit', 'requestAgain');
    }
  });
  $(isReset ? 'form-reset' : 'form-verify').addEventListener('submit', async event => {
    event.preventDefault();
    if (!token || busy) return;
    if (isReset && $('new-password').value !== $('confirm-password').value) {
      message('error', 'mismatch');
      $('confirm-password').focus();
      return;
    }
    const result = await post(isReset ? '/api/auth/reset-password' : '/api/auth/verify-email',
      isReset ? { token, newPassword: $('new-password').value } : { token },
      isReset ? 'savingPassword' : 'verifying');
    if (result) {
      token = '';
      event.target.reset();
      event.target.hidden = true;
      event.target.closest('.card').hidden = true;
      $('back-signin').hidden = true;
      bind('auth-title', isReset ? 'resetDone' : 'verifyDone');
      $('auth-intro').hidden = true;
      document.querySelector('.auth-notice').hidden = true;
      $('request-another').hidden = true;
      bind('success-message', isReset
        ? 'resetSuccess'
        : 'verifySuccess');
      $('success').hidden = false;
    }
  });
}

// Locale changes patch copy only: form values, pending bodies and token memory stay intact.
function localizeEntry() {
  translateDom(document);
  for (const input of document.querySelectorAll('input[data-validation-key]')) input.setCustomValidity(t('auth.' + input.dataset.validationKey));
  $('interface-language').value = getLocale();
  document.title = t('auth.' + (page === 'signin' ? 'signin' : page === 'reset' ? 'resetTitle' : 'verifyTitle')) + ' · Hatoove';
}
// Browser-owned validation bubbles otherwise retain the browser's language.
for (const input of document.querySelectorAll('form input')) {
  input.addEventListener('invalid', () => {
    input.dataset.validationKey = input.validity.valueMissing ? 'required'
      : input.validity.typeMismatch ? 'invalidEmail' : 'invalidInput';
    input.setCustomValidity(t('auth.' + input.dataset.validationKey));
  });
  input.addEventListener('input', () => {
    delete input.dataset.validationKey;
    input.setCustomValidity('');
  });
}
$('interface-language').addEventListener('change', event => {
  if (LOCALES.includes(event.target.value)) setLocale(event.target.value, { persist: true });
});
const unsubscribeLocale = subscribeLocale(localizeEntry);
addEventListener('pagehide', event => { if (!event.persisted) unsubscribeLocale(); });
addEventListener('pageshow', event => { if (event.persisted) setLocale(initialLocale()); });
setLocale(getLocale());
localizeEntry();
