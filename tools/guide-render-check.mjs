import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guideContent } from '../public/app/guide-content.js';
import { setLocale } from '../public/assets/i18n/core.js';
setLocale('de');
const esc = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let examples = 0, wrong = 0;
for (const file of ['writing-guide', 'grammar-guide', 'core-grammar', 'core-phrases', 'gender-rules', 'cases-guide']) {
  const source = JSON.parse(fs.readFileSync(new URL(`../data/${file}.json`, import.meta.url), 'utf8'));
  const html = guideContent(source, esc);
  function check(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.example === 'string') { assert.ok(html.includes(esc(value.example)), `${file}: an authored example disappeared`); examples++; }
    if (typeof value.bad === 'string') { assert.ok(html.includes(`So nicht – fehlerhaftes oder unpassendes Beispiel</span></strong><p lang="de" dir="ltr">${esc(value.bad)}`), `${file}: wrong example is unlabelled`); wrong++; }
    if (typeof value.good === 'string') assert.ok(html.includes(`Passendes Beispiel</span></strong><p lang="de" dir="ltr">${esc(value.good)}`));
    for (const child of Object.values(value)) check(child);
  }
  check(source);
}
assert.ok(examples > 300 && wrong === 15, 'the real example and deliberate-error fixtures must be nonempty');
const bilingual = guideContent({ de: 'der Termin', en: 'appointment', example: 'Ich habe einen Termin.', exampleEn: 'I have an appointment.', bad: '<img src=x onerror=alert(1)>' }, esc, 'en');
assert.ok(bilingual.includes('Ich habe einen Termin.') && bilingual.includes('I have an appointment.') && bilingual.includes('appointment'));
assert.ok(!bilingual.includes('<img') && bilingual.includes('&lt;img'));
console.log(`PASS guide semantics: ${examples} real examples preserved, ${wrong} wrong examples labelled, translations and escaping checked`);
