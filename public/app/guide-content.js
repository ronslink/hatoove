import { messageMarkup } from './locale-preference.js';
/** Authored learning material stays in its source language. Interface labels are separate. */
export function guideContent(value, esc, language = 'de') {
  const names = { why:'m266',rule:'m267',rules:'m268',pattern:'m269',example:'m087',examples:'m270',note:'m271',hint:'m271',watchOut:'m272',watch_out:'m272',traps:'m273',items:'m274',points:'m275',pitfalls:'m273',tips:'m276',checklist:'m089',phrases:'m088',table:'m085',tables:'m277',meaning:'m278',usage:'m279',forms:'m280',steps:'m275',ending:'m281',gender:'m282',plural:'m283',question:'m284',answer:'m285',solution:'m286',explanation:'m287',exceptions:'m288',situation:'m289',leitpunkte:'m290',text:'m291',looks:'m292',other:'m293',case:'m294',triggers:'m086' };
  const alternative = markup => '<div class="muted" lang="en" dir="ltr" data-authored-alternative="en"' + (language === 'en' ? '' : ' hidden') + '>' + markup + '</div>';
  const walk = (item, depth = 0, sourceLanguage = 'de') => {
    if (item === null || item === undefined || depth > 12) return '';
    if (typeof item !== 'object') return `<p lang="${sourceLanguage}" dir="ltr">${esc(String(item))}</p>`;
    if (Array.isArray(item)) return `<ul class="guide-list" lang="${sourceLanguage}" dir="ltr">${item.map(x => `<li>${walk(x, depth + 1, sourceLanguage)}</li>`).join('')}</ul>`;
    const skip = new Set(['id','kind','source','level','pos','en']);
    let html = '';
    if (Array.isArray(item.headers) && Array.isArray(item.rows)) {
      const table = (headers, english = false) => `<div class="guide-table" tabindex="0" role="region" data-i18n-aria-label="shell.grammarTable" aria-label="Grammatiktabelle"><table lang="de" dir="ltr"><thead><tr>${headers.map(h => `<th scope="col" lang="${english ? 'en' : 'de'}" dir="ltr">${esc(String(h))}</th>`).join('')}</tr></thead><tbody>${item.rows.map((row,i) => `<tr>${row.map((cell,j) => { const translated = Boolean(english && j === 0 && item.firstColumnEn?.[i]); return `<td lang="${translated ? 'en' : 'de'}" dir="ltr">${esc(String(translated ? item.firstColumnEn[i] : cell))}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
      html += table(item.headers);
      if (Array.isArray(item.headersEn)) html += alternative(table(item.headersEn,true));
      ['headers','headersEn','rows','firstColumnEn'].forEach(key => skip.add(key));
    }
    if (typeof item.de === 'string') {
      html += `<blockquote class="guide-example" lang="de" dir="ltr">${esc(item.de)}</blockquote>`;
      if (item.en) html += alternative(`<p>${esc(item.en)}</p>`);
      skip.add('de');
    }
    const order = ['title','group','idea','type','intro','why','rule','pattern','detail','hint','situation','leitpunkte','example','examples','good','bad','note'];
    const rank = key => order.includes(key) ? order.indexOf(key) : 100;
    for (const [key, content] of Object.entries(item).sort(([a],[b]) => rank(a)-rank(b))) {
      if (skip.has(key) || /En$|_en$/.test(key)) continue;
      if (key === 'good' || key === 'bad') {
        html += `<div class="guide-${key}"><strong>${messageMarkup(key === 'good' ? 'm295' : 'm296')}</strong>${walk(content,depth+1,sourceLanguage)}</div>`;
        continue;
      }
      const translated = item[key+'En'] ?? item[key+'_en'];
      if (['title','group','idea','type'].includes(key) && typeof content === 'string') html += `<h4 lang="${sourceLanguage}" dir="ltr">${esc(content)}</h4>`;
      else html += (names[key] ? `<h4>${messageMarkup(names[key])}</h4>` : '') + walk(content,depth+1,sourceLanguage);
      if (translated !== undefined) html += alternative(walk(translated,depth+1,'en'));
    }
    return html;
  };
  return walk(value);
}
