#!/usr/bin/env node
import process from 'node:process';
import {persistentConfig,persistentRolePool} from './owned-postgres/provision.mjs';
import {createWorker} from './owned-postgres/worker.mjs';
const USAGE='Usage: node server/worker.mjs [--once] [--interval=<ms>] [--max-iterations=<n>]\nRequires OWNAPI_PG_DATABASE and OWNAPI_PG_USER.';
const codes=new Set(['grader_error','invalid_assessment','unsupported_rubric','content_unavailable','retry_exhausted','attempt_deleted','dispatch_not_started','claim_stale','lease_reclaimed']);
function parse(argv){
 const result={intervalMs:1000,maxIterations:Infinity,help:false};const seen=new Set();
 for(const arg of argv){
  if(arg==='--help'||arg==='-h'){result.help=true;continue;}
  if(arg==='--once'){if(seen.has('once'))throw Error();seen.add('once');result.once=true;continue;}
  const match=/^--(interval|max-iterations)=(\d+)$/.exec(arg);
  if(!match||seen.has(match[1]))throw Error();seen.add(match[1]);const n=Number(match[2]);
  if(!Number.isSafeInteger(n)||n<1||(match[1]==='interval'&&n>2147483647))throw Error();
  result[match[1]==='interval'?'intervalMs':'maxIterations']=n;
 }
 if(result.once)result.maxIterations=1;return result;
}
const error=code=>console.error(JSON.stringify({event:'worker_error',code}));
export async function main(argv=process.argv.slice(2)){
 let options,config,pool,worker,exit=0,cancelSleep=null,stopping=false;
 try{options=parse(argv);}catch{error('worker_arguments_invalid');return 2;}
 if(options.help){console.log(USAGE);return 0;}
 try{if(!process.env.OWNAPI_PG_DATABASE||!process.env.OWNAPI_PG_USER)throw Error();config=persistentConfig();}catch{error('worker_configuration_invalid');return 2;}
 const stop=signal=>{stopping=true;console.log(JSON.stringify({event:'worker_stopping',signal}));cancelSleep?.();};
 const interrupt=()=>stop('SIGINT'),terminate=()=>stop('SIGTERM');
 try{
  try{pool=persistentRolePool(config,'worker',{max:2});pool.on('error',()=>{error('worker_iteration_failed');exit=1;stopping=true;cancelSleep?.();});worker=createWorker({pool});}catch{error('worker_initialization_failed');exit=1;}
  if(!exit){
   process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);console.log(JSON.stringify({event:'worker_started'}));
   try{for(let n=0;!stopping&&n<options.maxIterations;n++){
    const reclaimed=await worker.reclaimExpired();
    if(reclaimed.requeued||reclaimed.abandoned)console.log(JSON.stringify({event:'worker_reclaimed',requeued:reclaimed.requeued,abandoned:reclaimed.abandoned}));
    const result=await worker.runOnce();if(result.claimed){
     if(!['succeeded','failed','stale','skipped'].includes(result.outcome))throw Error();
     console.log(JSON.stringify({event:'worker_outcome',outcome:result.outcome,code:codes.has(result.code)?result.code:null}));
    }
    if(!stopping&&n+1<options.maxIterations)await new Promise(resolve=>{const timer=setTimeout(()=>{cancelSleep=null;resolve();},options.intervalMs);cancelSleep=()=>{clearTimeout(timer);cancelSleep=null;resolve();};});
   }}catch{error('worker_iteration_failed');exit=1;}
  }
 }catch{error('worker_initialization_failed');exit=1;}
 finally{
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);cancelSleep?.();
  if(pool)try{await pool.end();}catch{error('worker_cleanup_failed');exit=1;}
 }
 return exit;
}
if(process.argv[1]?.endsWith('worker.mjs'))main().then(code=>{process.exitCode=code;},()=>{error('worker_initialization_failed');process.exitCode=1;});
