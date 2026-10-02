export function bindSentenceCheck({ api, esc }) {
  const form = document.getElementById('sentence-form');
  const input = document.getElementById('sentence-text');
  const output = document.getElementById('sentence-result');
  const trigger = document.getElementById('sentence-submit');
  let serial = 0;
  input.addEventListener('input', () => { serial++; output.replaceChildren(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const request = ++serial;
    trigger.disabled = true;
    output.innerHTML = '<p class="muted">Die Satzstruktur wird untersucht …</p>';
    const result = await api.sentences.check(text);
    trigger.disabled = false;
    if (request !== serial) return;
    if (!result?.ok) {
      output.innerHTML = '<p class="err">Die Strukturhinweise konnten nicht geladen werden. Dein Text bleibt hier erhalten. Bitte versuche es erneut.</p>';
      return;
    }
    const data = result.data;
    const types = { main: 'Hauptsatz', subordinate: 'Nebensatz', question: 'Fragesatz', uncertain: 'Struktur nicht sicher erkannt' };
    output.innerHTML = `<div class="card"><strong>Hinweise zur Struktur</strong><p class="muted">${esc(data.limitation)}</p>${data.truncated ? '<p class="small muted">Es wurden nur die ersten 24 Satzteile untersucht.</p>' : ''}</div>`
      + data.clauses.map(clause => `<article class="card"><p class="kicker">${esc(types[clause.type] || types.uncertain)}</p><blockquote class="guide-example" lang="de">${esc(clause.text)}</blockquote>${clause.finite ? `<p>Mögliche finite Verbform: <strong>${esc(clause.finite.word)}</strong></p>` : ''}<p>${esc(clause.rule)}</p>${clause.hints.length ? `<ul>${clause.hints.map(h => `<li>${esc(h.message)}</li>`).join('')}</ul>` : '<p class="small muted">Kein Hinweis aus den bekannten Mustern. Das bestätigt nicht, dass der Satz grammatisch richtig ist.</p>'}</article>`).join('');
  });
}
