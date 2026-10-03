#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {persistentConfig,persistentRolePool} from '../server/owned-postgres/provision.mjs';
import {readProviderUsageSummary,validateReportWindow} from '../server/owned-postgres/provider-attempts.mjs';
const help='Usage: node tools/provider-usage-report.mjs --from=<UTC ISO milliseconds> --to=<UTC ISO milliseconds>\nPrivate stub-only engineering estimates; real spend is not measured.';
const outputError=code=>console.error(JSON.stringify({event:'provider_report_error',code}));
export async function main(argv=process.argv.slice(2)){
 let window,config,pool,client,output,exit=0;
 try{
  if(argv.length===1&&argv[0]==='--help'){console.log(help);return 0;}
  window={};for(const arg of argv){const match=/^--(from|to)=(.*)$/.exec(arg);if(!match||Object.hasOwn(window,match[1]))throw Error();window[match[1]]=match[2];}validateReportWindow(window);
  if(!process.env.OWNAPI_PG_DATABASE||!process.env.OWNAPI_PG_USER)throw Error();config=persistentConfig();
 }catch{outputError('provider_report_invalid');return 2;}
 try{
  pool=persistentRolePool(config,'worker',{max:1});pool.on('error',()=>{outputError('provider_report_unavailable');exit=1;});client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  output=await readProviderUsageSummary(client,window);await client.query('COMMIT');
 }catch(error){
  const code=['provider_report_invalid','provider_report_too_large'].includes(error?.code)?error.code:'provider_report_unavailable';
  outputError(code);exit=code==='provider_report_invalid'?2:1;if(client)try{await client.query('ROLLBACK');}catch{}
 }finally{
  if(client)try{client.release();}catch{outputError('provider_report_unavailable');exit=1;}
  if(pool)try{await pool.end();}catch{outputError('provider_report_unavailable');exit=1;}
 }
 if(!exit)console.log(JSON.stringify(output));return exit;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(code=>{process.exitCode=code;},()=>{outputError('provider_report_unavailable');process.exitCode=1;});
