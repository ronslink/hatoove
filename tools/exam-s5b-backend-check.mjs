#!/usr/bin/env node
/** Pure timing and snapshot boundary checks. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mockTiming, validateGroupResponses, validateStartMockRun } from '../server/mock-contract.mjs';
let passed=0;
const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
const groups=[{group_id:'first',sections:['LV','SB'],starts_at:'2026-01-01T00:00:00Z',deadline_at:'2026-01-01T00:00:10Z'},
 {group_id:'second',sections:['HV'],starts_at:'2026-01-01T00:00:10Z',deadline_at:'2026-01-01T00:00:20Z'}];
const members=[{set_id:'lv',version:'v1',section:'LV'},{set_id:'hv',version:'v1',section:'HV'}];
const a={setId:'lv',version:'v1',itemId:'1',answer:'a'},b={setId:'hv',version:'v1',itemId:'1',answer:'b'};
const first=mockTiming(groups,'2026-01-01T00:00:01Z'),second=mockTiming(groups,'2026-01-01T00:00:10Z');
const inactive=fn=>assert.throws(fn,e=>e.status===409&&e.code==='mock_group_inactive');
check('legacy has no ordered timing',()=>assert.equal(mockTiming([],Date.now()),null));
check('boundary closes the previous group without extending either window',()=>{
 assert.equal(first.active_group_id,'first');assert.equal(second.active_group_id,'second');
 assert.equal(mockTiming(groups,'2026-01-01T00:00:20Z').active_group_id,null);
 assert.deepEqual(first.groups,second.groups);
});
check('active group permits additions changes and removals',()=>{
 validateGroupResponses(members,[],[a],first);validateGroupResponses(members,[a],[{...a,answer:null}],first);validateGroupResponses(members,[a],[],first);
});
check('future answers cannot be added even as null',()=>{inactive(()=>validateGroupResponses(members,[],[b],first));inactive(()=>validateGroupResponses(members,[],[{...b,answer:null}],first));});
check('closed answer cannot change or disappear through omission',()=>{inactive(()=>validateGroupResponses(members,[a],[],second));inactive(()=>validateGroupResponses(members,[a],[{...a,answer:'b'}],second));});
check('unchanged closed values and reordered snapshots remain allowed',()=>{validateGroupResponses(members,[a,b],[b,a],second);validateGroupResponses(members,[a],[a,b],second);});
check('all response changes close at final deadline but cursor-only snapshots survive',()=>{const closed=mockTiming(groups,'2026-01-01T00:00:20Z');inactive(()=>validateGroupResponses(members,[a],[],closed));validateGroupResponses(members,[a],[a],closed);});
check('start request cannot supply schedule or clock overrides',()=>{
 const base={preparationId:randomUUID(),formId:'complete',formVersion:'v1',releaseVersion:'v1',eventId:randomUUID()};
 for(const field of ['createdAt','deadlineAt','timingPolicy','timeGroups','serverNow'])assert.throws(()=>validateStartMockRun({...base,[field]:'override'}),e=>e.code==='unknown_field');
});
console.log(`EXAM-S5B backend: ${passed} checks passed.`);
