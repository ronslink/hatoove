/** Privileged Compose operator command. Never starts services or obtains reviewer authority. */
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,realpath,open,lstat,readdir} from 'node:fs/promises';
import {canonicalJson} from '../server/package-contract.mjs';
import {reviewError} from '../server/content-review-contract.mjs';
import {recordReviewerAuthority,recordContentReview,readContentCoverage,readReviewPacket} from '../server/owned-postgres/content-review.mjs';
const PUBLIC=fileURLToPath(new URL('../public/',import.meta.url));
const within=(root,target)=>{const r=path.relative(root,target);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
async function assertStaticTreeUnambiguous(root){
 const pending=[root];let visited=0;
 while(pending.length){if(++visited>10000)reviewError('review_packet_destination');for(const entry of await readdir(pending.pop(),{withFileTypes:true})){
  // A static subtree junction can expose an otherwise private sibling. Do not follow it or guess.
  if(entry.isSymbolicLink())reviewError('review_packet_destination');
  if(entry.isDirectory())pending.push(path.join(entry.parentPath??entry.path,entry.name));
 }}
}
/** Resolve the existing parent and every static root; ambiguity and existing files are refused. */
export async function privatePacketDestination(output,{staticRoots=[PUBLIC]}={}){
 if(typeof output!=='string'||!path.isAbsolute(output)||/[<>:"|?*\0]/.test(path.basename(output))||/[. ]$/.test(path.basename(output)))reviewError('review_packet_destination');
 const target=path.resolve(output),parent=await realpath(path.dirname(target));
 const resolved=path.join(parent,path.basename(target));
 for(const root of staticRoots){const lexical=path.resolve(root),physical=await realpath(lexical);if(within(lexical,target)||within(physical,resolved))reviewError('review_packet_destination');await assertStaticTreeUnambiguous(physical);}
 try{await lstat(resolved);reviewError('review_packet_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 return resolved;
}
export async function writePrivatePacket(output,value,options){
 const destination=await privatePacketDestination(output,options);
 const handle=await open(destination,'wx',0o600);
 try{await handle.writeFile(canonicalJson(value)+'\n','utf8');}finally{await handle.close();}
 return {packetSha256:value.packetSha256};
}
export function parseReviewArgs(args){
 const [operation,...rest]=args;if(!['authority','decision','coverage','packet'].includes(operation))reviewError();
 const p={operation,apply:false},seen=new Set();
 for(let i=0;i<rest.length;i++){
  const key=rest[i];if(seen.has(key)||!['--apply','--dry-run','--input','--exam','--release','--languages','--subject-file','--output'].includes(key))reviewError();seen.add(key);
  if(key==='--apply')p.apply=true;else if(key==='--dry-run')p.dryRun=true;
  else{const v=rest[++i];if(!v||v.startsWith('--'))reviewError();p[key.slice(2)]=v;}
 }
 if(p.apply&&p.dryRun)reviewError();
 const allowed={authority:['--apply','--dry-run','--input'],decision:['--apply','--dry-run','--input'],coverage:['--exam','--release','--languages'],packet:['--subject-file','--output']}[operation];
 if([...seen].some(k=>!allowed.includes(k))||(['authority','decision'].includes(operation)&&!p.input)||(operation==='coverage'&&!p.exam)||(operation==='packet'&&(!p['subject-file']||!p.output)))reviewError();
 return p;
}
/** Exported transaction runner permits real rollback tests without a second CLI implementation. */
export async function executeReviewCommand(client,p,{readJson=async f=>JSON.parse(await readFile(f,'utf8')),mediaRoot,packetOptions}={}){
 const writing=['authority','decision'].includes(p.operation);
 await client.query(writing?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  let result;
  if(p.operation==='authority')result=await recordReviewerAuthority(client,await readJson(p.input));
  else if(p.operation==='decision')result=await recordContentReview(client,await readJson(p.input),{...(mediaRoot?{mediaRoot}:{})});
  else if(p.operation==='coverage')result=await readContentCoverage(client,{examId:p.exam,releaseVersion:p.release,languages:p.languages?.split(',')},{...(mediaRoot?{mediaRoot}:{})});
  else{const packet=await readReviewPacket(client,await readJson(p['subject-file']),{...(mediaRoot?{mediaRoot}:{})});result=await writePrivatePacket(p.output,packet,packetOptions);}
  await client.query(writing&&!p.apply?'ROLLBACK':'COMMIT');
  return writing?{mode:p.apply?'applied':'dry_run',receipt:result}:result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}
export async function main(args=process.argv.slice(2),env=process.env){
 const p=parseReviewArgs(args);
 // A selected target is required even for reports; never silently connect to a default install.
 if(env.CONTENT_REVIEW_ALLOW!=='1'||!env.OWNAPI_PG_HOST||!env.OWNAPI_PG_PORT||!env.OWNAPI_PG_DATABASE||!env.OWNAPI_PG_SCHEMA||!env.OWNAPI_PG_ROLE_PREFIX)reviewError('review_database_selection_required');
 const {persistentConfig,persistentRolePool}=await import('../server/owned-postgres/provision.mjs');
 const config=persistentConfig(env),pool=persistentRolePool(config,'migration',{max:1});let client;
 try{
  client=await pool.connect();const {rows:[r]}=await client.query('SELECT current_schema() AS schema,current_user AS role');
  if(r.schema!==config.schema||r.role!==config.roles.migration)reviewError('review_database_selection_required');
  const result=await executeReviewCommand(client,p);process.stdout.write(JSON.stringify(result)+'\n');return result;
 }finally{client?.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{process.stderr.write('Review command failed: '+(/^[a-z0-9_]+$/i.test(e.code??'')?e.code:'review_failed')+'\n');process.exitCode=1;});
