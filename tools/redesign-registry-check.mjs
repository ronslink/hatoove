import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {legacySeedLanguageRegistry,projectedLegacyLanguageRegistry,resolveObjectiveExplanationLanguage} from '../server/explanation-language-registry.mjs';

const bytes=readFileSync(new URL('../server/legacy-explanation-language.json',import.meta.url));
const declared=projectedLegacyLanguageRegistry(bytes);
assert.equal(declared.length,180);
assert.deepEqual(declared,legacySeedLanguageRegistry(readFileSync(new URL('../data/seed.json',import.meta.url))));
assert.ok(Object.isFrozen(declared)&&declared.every(Object.isFrozen));
console.log('PASS image projection exactly matches 180 retained source declarations');
for(const change of [rows=>rows[0].language='en',rows=>rows[0].item_id='other',rows=>rows.pop()]) {
  const rows=JSON.parse(bytes);change(rows);
  assert.deepEqual(projectedLegacyLanguageRegistry(Buffer.from(JSON.stringify(rows))),[]);
}
for(const invalid of [Buffer.from('{'),Buffer.from('null'),'not bytes']) assert.deepEqual(projectedLegacyLanguageRegistry(invalid),[]);
console.log('PASS changed declarations, identities and malformed metadata refused');
const source=JSON.parse(readFileSync(new URL('../data/seed.json',import.meta.url))).LV2[0].questions[0];
const query={examId:'telc-deutsch-b1',setId:'telc-deutsch-b1.lv2.01',setVersion:'v1',itemId:String(source.n),originalValue:source.why};
assert.equal(resolveObjectiveExplanationLanguage(query),'de');
for(const change of [{originalValue:source.why+' changed'},{examId:'other'},{setVersion:'v999'},{itemId:'999'}]) assert.equal(resolveObjectiveExplanationLanguage({...query,...change}),null);
console.log('PASS language remains bound to exact original and complete identity');
