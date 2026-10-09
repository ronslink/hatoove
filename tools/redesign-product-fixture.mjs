/** Prepare one explicitly unreviewed translated explanation in the generated synthetic capture database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from '../server/owned-postgres/node_modules/pg/lib/index.js';
import { packageHash } from '../server/package-contract.mjs';
import { extractObjectiveExplanationSource } from '../server/explanation-contract.mjs';
import { importObjectiveExplanations } from '../server/owned-postgres/explanation-importer.mjs';
import { registerExplanationReviewTarget } from '../server/owned-postgres/explanation-review.mjs';
assert.match(process.env.REDESIGN_TEST_PROJECT||'',/^hatoove-browser-\d+-\d+$/);
assert.equal(process.env.OWNAPI_PG_HOST,'127.0.0.1');
assert.ok(![4300,55435,55440].includes(Number(process.env.OWNAPI_PG_PORT)));
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/redesign-product-explanation.json',import.meta.url),'utf8'));
const client=new pg.Client({host:'127.0.0.1',port:Number(process.env.OWNAPI_PG_PORT),database:'hatoove',user:'hatoove_migration',options:'-c search_path=hatoove,pg_catalog'});
try {
  await client.connect(); await client.query('BEGIN');
  const original=(await client.query('SELECT explanations FROM objective_key WHERE set_id=$1 AND version=$2',[fixture.setId,fixture.setVersion])).rows[0].explanations[fixture.itemId];
  assert.equal(original,fixture.original);
  const source=extractObjectiveExplanationSource({...fixture,originalValue:original,originalLanguage:'de'});
  const payload={schema:'explanation-text-v1',blocks:source.originalPayload.blocks.map(block=>({...block,text:fixture.translation}))};
  const rep={language:fixture.language,version:'redesign-capture-v1',source_sha256:source.sourceSha256,payload,payload_sha256:packageHash(payload),provenance:{kind:'publisher-authored',source_sha256:source.sourceSha256,producer_version:'redesign-offline-ai-20261009'}};
  await importObjectiveExplanations(client,{items:[{examId:fixture.examId,setId:fixture.setId,setVersion:fixture.setVersion,itemId:fixture.itemId,sourceSha256:source.sourceSha256,representations:[rep],heads:[{language:rep.language,version:rep.version,expectedVersion:null}]}]});
  await registerExplanationReviewTarget(client,{scope:'objective',targetKind:'stored',sourceIdentity:source.identity,sourceSha256:source.sourceSha256,language:rep.language,representationVersion:rep.version,payloadSha256:rep.payload_sha256});
  await client.query('COMMIT'); console.log('Synthetic Ukrainian capture representation imported, unreviewed; no approval decision.');
} catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;} finally {await client.end();}
