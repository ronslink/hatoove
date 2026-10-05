import { messageMarkup } from './locale-preference.js';
/**
 * Authored guide payloads, rendered.
 *
 * `guideContent(value, esc, language)` is the frozen public entry point (MIRROR-B1PREP-01 section 4.2).
 * A fourth, OPTIONAL `options` argument was added for the Nachschlagen library (slice E/F):
 *
 *   options.library            render the German line first with the learner-language line beneath it,
 *                              visibly and dimmed, instead of an `en` alternative that stays hidden
 *   options.resolve(relPath)   look up the translated string for a path relative to the payload root;
 *                              returns `{ text, status }` or null. `status === 'machine_unreviewed'`
 *                              marks the line as machine translated and not yet reviewed.
 *   options.machineMarker      the (already localised) marker appended to an unreviewed line
 *   options.speaker            mark German example lines so the caller can mount the read-aloud control
 *
 * With no `options` the output is byte-identical to the previous revision, which `tools/guide-render-check.mjs`
 * pins. Nothing here decides WHICH language the learner reads; the caller resolves that.
 */
const NAMES = { why:'m266',rule:'m267',rules:'m268',pattern:'m269',example:'m087',examples:'m270',note:'m271',hint:'m271',watchOut:'m272',watch_out:'m272',traps:'m273',items:'m274',points:'m275',pitfalls:'m273',tips:'m276',checklist:'m089',phrases:'m088',table:'m085',tables:'m277',meaning:'m278',usage:'m279',forms:'m280',steps:'m275',ending:'m281',gender:'m282',plural:'m283',question:'m284',answer:'m285',solution:'m286',explanation:'m287',exceptions:'m288',situation:'m289',leitpunkte:'m290',text:'m291',looks:'m292',other:'m293',case:'m294',triggers:'m086' };
const ORDER = ['title','group','idea','type','intro','why','rule','pattern','detail','hint','situation','leitpunkte','example','examples','good','bad','note'];
const SPEAKABLE_KEYS = new Set(['example','examples','de','text','phrases']);
const dir = language => (language === 'ar' ? 'rtl' : 'ltr');

export function guideContent(value, esc, language = 'de', options = {}) {
  const library = options.library === true;
  const speaker = library && options.speaker === true;
  const resolve = typeof options.resolve === 'function' ? options.resolve : () => null;
  const machineMarker = typeof options.machineMarker === 'string' ? options.machineMarker : '';
  const locale = typeof language === 'string' && language ? language : 'de';
  const alternative = markup => '<div class="muted" lang="en" dir="ltr" data-authored-alternative="en"' + (locale === 'en' ? '' : ' hidden') + '>' + markup + '</div>';
  /**
   * The learner-language line, or nothing at all.
   *
   * In the library the authored `…En` fields are the English translation and are shown ONLY to a
   * learner whose language is English: for every other language the contract's German-only path
   * applies (German source plus one note), and an English paragraph under an Arabic heading would be
   * a third language nobody asked for.
   */
  const learnerLine = (markup, lineLanguage, status) => {
    if (!library) return alternative(markup);
    if (lineLanguage === 'en' && locale !== 'en') return '';
    const machine = status === 'machine_unreviewed';
    return '<div class="library-translation' + (machine ? ' library-machine' : '') + '" lang="' + lineLanguage + '" dir="' + dir(lineLanguage) + '">'
      + markup + (machine && machineMarker ? '<span class="library-machine-note">' + machineMarker + '</span>' : '') + '</div>';
  };
  /** A translated string from the bundle, when F2 serves one. */
  const resolvedLine = (path, lineLanguage) => {
    if (!library) return '';
    const hit = path ? resolve(path) : null;
    return hit && typeof hit.text === 'string' && hit.text ? learnerLine(esc(hit.text), lineLanguage, hit.status) : '';
  };
  const walk = (item, depth = 0, sourceLanguage = 'de', path = '', speakable = false) => {
    if (item === null || item === undefined || depth > 12) return '';
    if (typeof item !== 'object') {
      const paragraph = `<p lang="${sourceLanguage}" dir="ltr"${speaker && speakable && sourceLanguage === 'de' ? ' data-library-speak' : ''}>${esc(String(item))}</p>`;
      return paragraph + (library && sourceLanguage === 'de' ? resolvedLine(path, locale) : '');
    }
    if (Array.isArray(item)) return `<ul class="guide-list" lang="${sourceLanguage}" dir="ltr">${item.map((x, index) => `<li>${walk(x, depth + 1, sourceLanguage, path ? `${path}.${index}` : String(index), speakable)}</li>`).join('')}</ul>`;
    const skip = new Set(['id','kind','source','level','pos','en']);
    let html = '';
    if (Array.isArray(item.headers) && Array.isArray(item.rows)) {
      const table = (headers, english = false) => {
        const head = headers.map((h, index) => {
          const translation = !english && library ? resolve(path ? `${path}.headers.${index}` : `headers.${index}`) : null;
          const value = translation && translation.text ? translation.text : h;
          return `<th scope="col" lang="${english || translation ? 'en' : 'de'}" dir="ltr">${esc(String(value))}</th>`;
        }).join('');
        const body = item.rows.map((row, i) => `<tr>${row.map((cell, j) => {
          const authored = Boolean(english && j === 0 && item.firstColumnEn?.[i]);
          const translation = !english && library ? resolve(path ? `${path}.rows.${i}.${j}` : `rows.${i}.${j}`) : null;
          const value = authored ? item.firstColumnEn[i] : (translation && translation.text ? translation.text : cell);
          const cellLanguage = authored ? 'en' : (translation ? locale : 'de');
          return `<td lang="${cellLanguage}" dir="${dir(cellLanguage)}">${esc(String(value))}</td>`;
        }).join('')}</tr>`).join('');
        return `<div class="guide-table" tabindex="0" role="region" data-i18n-aria-label="shell.grammarTable" aria-label="Grammatiktabelle"><table lang="de" dir="ltr"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      };
      html += table(item.headers);
      if (Array.isArray(item.headersEn)) {
        const english = table(item.headersEn, true);
        html += library ? learnerLine(english, 'en', null) : alternative(english);
      }
      ['headers','headersEn','rows','firstColumnEn'].forEach(key => skip.add(key));
    }
    if (typeof item.de === 'string') {
      html += `<blockquote class="guide-example" lang="de" dir="ltr"${speaker ? ' data-library-speak' : ''}>${esc(item.de)}</blockquote>`;
      const translated = resolvedLine(path ? `${path}.de` : 'de', locale);
      if (translated) html += translated;
      else if (item.en) html += learnerLine(`<p>${esc(item.en)}</p>`, 'en', null);
      skip.add('de');
    }
    const rank = key => ORDER.includes(key) ? ORDER.indexOf(key) : 100;
    for (const [key, content] of Object.entries(item).sort(([a],[b]) => rank(a)-rank(b))) {
      if (skip.has(key) || /En$|_en$/.test(key)) continue;
      if (key === 'good' || key === 'bad') {
        html += `<div class="guide-${key}"><strong>${messageMarkup(key === 'good' ? 'm295' : 'm296')}</strong>${walk(content,depth+1,sourceLanguage, path ? `${path}.${key}` : key, speakable)}</div>`;
        continue;
      }
      const translated = item[key+'En'] ?? item[key+'_en'];
      const childPath = path ? `${path}.${key}` : key;
      const childSpeakable = speakable || SPEAKABLE_KEYS.has(key);
      if (['title','group','idea','type'].includes(key) && typeof content === 'string') html += `<h4 lang="${sourceLanguage}" dir="ltr">${esc(content)}</h4>`;
      else html += (NAMES[key] ? `<h4>${messageMarkup(NAMES[key])}</h4>` : '') + walk(content,depth+1,sourceLanguage,childPath,childSpeakable);
      const fromBundle = resolvedLine(childPath, locale);
      if (fromBundle) html += fromBundle;
      else if (translated !== undefined) html += library
        ? learnerLine(walk(translated, depth + 1, 'en', childPath, false), 'en', null)
        : alternative(walk(translated,depth+1,'en'));
    }
    return html;
  };
  return walk(value);
}
