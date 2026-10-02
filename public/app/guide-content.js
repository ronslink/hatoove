/** Render structured reference content as readable prose, examples and tables. */
export function guideContent(value, esc, language = 'de') {
  const names = { why: 'Wozu du das brauchst', rule: 'Regel', pattern: 'Satzmuster', examples: 'Beispiele', note: 'Hinweis', watchOut: 'Darauf achten', watch_out: 'Darauf achten', items: 'Merken', pitfalls: 'Häufige Fehler', tips: 'Tipps', checklist: 'Checkliste', phrases: 'Redemittel', table: 'Übersicht', tables: 'Übersichten', meaning: 'Bedeutung', usage: 'Verwendung', forms: 'Formen', steps: 'Schritt für Schritt', ending: 'Endung', gender: 'Artikel', plural: 'Plural', question: 'Frage', answer: 'Antwort', solution: 'Lösung', explanation: 'Erklärung', exceptions: 'Ausnahmen' };
  const walk = (item, depth = 0) => {
    if (item === null || item === undefined || depth > 8) return '';
    if (typeof item !== 'object') return `<p>${esc(String(item))}</p>`;
    if (Array.isArray(item)) return `<ul class="guide-list">${item.map(x => `<li>${walk(x, depth + 1)}</li>`).join('')}</ul>`;
    if (Array.isArray(item.headers) && Array.isArray(item.rows)) {
      const headers = language === 'en' && item.headersEn ? item.headersEn : item.headers;
      return `<div class="guide-table" tabindex="0" role="region" aria-label="Grammatiktabelle"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(String(h))}</th>`).join('')}</tr></thead><tbody>${item.rows.map(row => `<tr>${row.map(cell => `<td>${esc(String(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${item.note ? walk(language === 'en' && item.noteEn ? item.noteEn : item.note) : ''}`;
    }
    if (typeof item.de === 'string') return `<blockquote class="guide-example" lang="de">${esc(item.de)}</blockquote>${language === 'en' && item.en ? `<p class="muted" lang="en">${esc(item.en)}</p>` : ''}${item.note ? `<p class="small muted">${esc(item.note)}</p>` : ''}`;
    return Object.entries(item).filter(([key]) => !['id', 'kind', 'title', 'titleEn', 'source', 'level', 'en'].includes(key) && !/En$|_en$/.test(key)).map(([key, content]) => {
      const translated = item[key + 'En'] ?? item[key + '_en'];
      const selected = language === 'en' && translated !== undefined ? translated : content;
      return `${names[key] ? `<h4>${names[key]}</h4>` : ''}${walk(selected, depth + 1)}`;
    }).join('');
  };
  return walk(value);
}
