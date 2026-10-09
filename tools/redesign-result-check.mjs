import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(process.argv.find(arg=>arg.startsWith('--source-root='))?.slice(14)||fileURLToPath(new URL('../',import.meta.url)));
const {runnerMarkup,runnerStateFromServed,applyChecked}=await import(pathToFileURL(path.join(root,'public/app/part-runner.js')));
const items=['1','2'].map(item_id=>({item_id,ordinal:Number(item_id),prompt:'Synthetic question',answer_kind:'choice',options:[{id:'a',text:'First',value:'a'},{id:'b',text:'Second',value:'b'}]}));
const state=runnerStateFromServed({family:'LV2',examLanguage:'de',response:{ok:true,data:{family:'LV2',attempt:{attempt_id:'11111111-2222-4333-8444-555555555555'},set:{set_id:'synthetic',version:'v1',family:'LV2',section:'LV',part:2,material:{passage:'Synthetic passage'},items}}}});
let failures=0,passed=0;
const check=(name,run)=>{try{run();passed++;console.log('PASS '+name);}catch(error){failures++;console.log('FAIL '+name+': '+error.message.split('\n')[0]);}};
check('navigator names open and held answers with text and glyphs',()=>{
 state.answers={'1':{key:'a',value:'a'}};
 const html=runnerMarkup(state,{locale:'de',examLanguage:'de'});
 assert.match(html,/data-runner-jump="1" data-item-state="picked"/);
 assert.match(html,/data-runner-jump="2" data-item-state="open"/);
 assert.match(html,/1 ●/);
});
const reviewed=applyChecked(state,{correct_count:1,answered_count:2,items:[{item_id:'1',chosen:'a',expected:'b',correct:false},{item_id:'2',chosen:'a',expected:'a',correct:true}]});
check('review statistics use accepted counts and labels above numbers',()=>{
 const html=runnerMarkup(reviewed,{locale:'de',examLanguage:'de'});
 assert.match(html,/<span>Richtig<\/span><b class="num">1<\/b>/);
 assert.match(html,/<span>Aufgaben<\/span><b class="num">2<\/b>/);
 assert.match(html,/<span>Fehler<\/span><b class="num">1<\/b>/);
 assert.ok(!/Punkte|Bereitschaft|bestanden/.test(html));
});
check('review navigator distinguishes correct and wrong with symbols',()=>{
 const html=runnerMarkup(reviewed,{locale:'de',examLanguage:'de'});
 assert.match(html,/data-runner-jump="1" data-item-state="wrong"/);
 assert.match(html,/data-runner-jump="2" data-item-state="correct"/);
 assert.match(html,/1 ✗/);assert.match(html,/2 ✓/);
});
console.log(passed+' passed, '+failures+' failed');process.exitCode=failures?1:0;
