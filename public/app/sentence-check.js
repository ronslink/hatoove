import { getLocale } from '../assets/i18n/core.js';
import { pl, updatePracticeLocale } from '../assets/i18n/practice-messages.js';
export function bindSentenceCheck({ api, esc }) {
  const form = document.getElementById('sentence-form');
  const input = document.getElementById('sentence-text');
  const output = document.getElementById('sentence-result');
  const trigger = document.getElementById('sentence-submit');
  let serial = 0;
  const onInput = () => { serial++; output.replaceChildren(); };
  input.addEventListener('input',onInput);
  const onSubmit = async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const request = ++serial;
    trigger.disabled = true;
    output.innerHTML = '<p class="muted" data-practice-key="ui69">Die Satzstruktur wird untersucht …</p>';
    updateLocale();
    const result = await api.sentences.check(text);
    trigger.disabled = false;
    if (request !== serial) return;
    if (!result?.ok) {
      output.innerHTML = '<p class="err" data-practice-key="ui70">Die Strukturhinweise konnten nicht geladen werden. Dein Text bleibt hier erhalten. Bitte versuche es erneut.</p>';
      updateLocale(); return;
    }
    const data = result.data;
    const types = {main:'mainClause',subordinate:'subordinateClause',question:'questionClause',uncertain:'uncertainClause'};
    output.innerHTML = `<div class="card"><strong data-practice-key="ui71">Hinweise zur Struktur</strong><p class="small muted">${pl('sourceGerman')}</p><p class="muted" lang="de" dir="ltr">${esc(data.limitation)}</p>${data.truncated ? '<p class="small muted" data-practice-key="ui72">Es wurden nur die ersten 24 Satzteile untersucht.</p>' : ''}</div>`
      + data.clauses.map(clause => `<article class="card"><p class="kicker">${pl(types[clause.type] || types.uncertain)}</p><blockquote class="guide-example" lang="de" dir="ltr">${esc(clause.text)}</blockquote>${clause.finite ? `<p>${pl('finiteVerb')} <strong lang="de" dir="ltr">${esc(clause.finite.word)}</strong></p>` : ''}<p lang="de" dir="ltr">${esc(clause.rule)}</p>${clause.hints.length ? `<ul lang="de" dir="ltr">${clause.hints.map(h => `<li>${esc(h.message)}</li>`).join('')}</ul>` : '<p class="small muted" data-practice-key="ui73">Kein Hinweis aus den bekannten Mustern. Das bestätigt nicht, dass der Satz grammatisch richtig ist.</p>'}</article>`).join('');
    updateLocale();
  };
  form.addEventListener('submit',onSubmit);
  function updateLocale(locale = getLocale()) { if (output.isConnected) updatePracticeLocale(output,locale); }
  return {updateLocale,dispose() { serial++; form.removeEventListener('submit',onSubmit); input.removeEventListener('input',onInput); }};
}
