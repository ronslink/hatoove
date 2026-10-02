/** Render authored semantics, including wrong examples and nested phrase examples. */
export function guideContent(value, esc, language = 'de') {
  const names = { why: 'Wozu du das brauchst', rule: 'Regel', rules: 'Regeln', pattern: 'Satzmuster', example: 'Beispiel', examples: 'Beispiele', note: 'Hinweis', hint: 'Hinweis', watchOut: 'Darauf achten', watch_out: 'Darauf achten', traps: 'Häufige Fehler', items: 'Merken', points: 'Schritt für Schritt', pitfalls: 'Häufige Fehler', tips: 'Tipps', checklist: 'Checkliste', phrases: 'Redemittel', table: 'Übersicht', tables: 'Übersichten', meaning: 'Bedeutung', usage: 'Verwendung', forms: 'Formen', steps: 'Schritt für Schritt', ending: 'Endung', gender: 'Artikel', plural: 'Plural', question: 'Frage', answer: 'Antwort', solution: 'Lösung', explanation: 'Erklärung', exceptions: 'Ausnahmen', situation: 'Situation', leitpunkte: 'Leitpunkte', text: 'Beispieltext', looks: 'Typische Endung', other: 'Andere Bedeutung', case: 'Fall', triggers: 'Auslöser' };
  const walk = (item, depth = 0) => {
    if (item === null || item === undefined || depth > 12) return '';
    if (typeof item !== 'object') return `<p>${esc(String(item))}</p>`;
    if (Array.isArray(item)) return `<ul class="guide-list">${item.map(x => `<li>${walk(x, depth + 1)}</li>`).join('')}</ul>`;
    const skip = new Set(['id', 'kind', 'source', 'level', 'pos', 'en']);
    let html = '';
    if (Array.isArray(item.headers) && Array.isArray(item.rows)) {
      const headers = language === 'en' && item.headersEn ? item.headersEn : item.headers;
      html += `<div class="guide-table" tabindex="0" role="region" aria-label="Grammatiktabelle"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(String(h))}</th>`).join('')}</tr></thead><tbody>${item.rows.map((row, i) => `<tr>${row.map((cell, j) => `<td>${esc(String(language === 'en' && j === 0 && item.firstColumnEn?.[i] ? item.firstColumnEn[i] : cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      ['headers', 'rows', 'firstColumnEn'].forEach(key => skip.add(key));
    }
    if (typeof item.de === 'string') {
      html += `<blockquote class="guide-example" lang="de">${esc(item.de)}</blockquote>${language === 'en' && item.en ? `<p class="muted" lang="en">${esc(item.en)}</p>` : ''}`;
      skip.add('de');
    }
    const order = ['title', 'group', 'idea', 'type', 'intro', 'why', 'rule', 'pattern', 'detail', 'hint', 'situation', 'leitpunkte', 'example', 'examples', 'good', 'bad', 'note'];
    const rank = key => order.includes(key) ? order.indexOf(key) : 100;
    for (const [key, content] of Object.entries(item).sort(([a], [b]) => rank(a) - rank(b))) {
      if (skip.has(key) || /En$|_en$/.test(key)) continue;
      if (key === 'good' || key === 'bad') {
        html += `<div class="guide-${key}" lang="de"><strong>${key === 'good' ? 'Passendes Beispiel' : 'So nicht – fehlerhaftes oder unpassendes Beispiel'}</strong>${walk(content, depth + 1)}</div>`;
        continue;
      }
      const translated = item[key + 'En'] ?? item[key + '_en'];
      // German examples and model letters stay German; translations are additional explanations.
      const example = ['example', 'examples', 'text', 'pattern', 'leitpunkte', 'situation'].includes(key);
      const selected = !example && language === 'en' && translated !== undefined ? translated : content;
      if (['title', 'group', 'idea', 'type'].includes(key) && typeof selected === 'string') html += `<h4>${esc(selected)}</h4>`;
      else html += `${names[key] ? `<h4>${names[key]}</h4>` : ''}<div lang="${selected === translated ? 'en' : 'de'}">${walk(selected, depth + 1)}</div>`;
      if (example && language === 'en' && translated !== undefined) html += `<div class="muted" lang="en">${walk(translated, depth + 1)}</div>`;
    }
    return html;
  };
  return walk(value);
}
