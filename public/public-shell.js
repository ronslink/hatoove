import { LOCALES, storedLocale, getLocale, setLocale, subscribeLocale, translateDom } from './assets/i18n/core.js';
import './assets/i18n/common.js';
import './assets/i18n/public-messages.js';

const selector = document.getElementById('interface-language');

function localizeShell() {
  translateDom(document);
  if (selector) selector.value = getLocale();
}

if (selector) {
  selector.addEventListener('change', event => {
    if (LOCALES.includes(event.target.value)) setLocale(event.target.value, { persist: true });
  });
}

const unsubscribeLocale = subscribeLocale(localizeShell);
addEventListener('pagehide', event => { if (!event.persisted) unsubscribeLocale(); });
addEventListener('pageshow', event => { if (event.persisted) setLocale(storedLocale() ?? 'de'); });

/* Keep the default German for crawlers while honouring any explicit visitor choice. */
setLocale(storedLocale() ?? 'de');
localizeShell();
