#!/usr/bin/env node
/** Run in the existing Compose migration service with its restricted publisher connection. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { persistentConfig,persistentRolePool } from '../server/owned-postgres/provision.mjs';

export async function main(args=process.argv.slice(2)) {
  const dryRun=args.includes('--dry-run');
  const file=args.find(a=>!a.startsWith('--'));
  if(!file || args.some(a=>a.startsWith('--')&&a!=='--dry-run')) throw new Error('usage: node tools/import-exam-package.mjs manifest.json [--dry-run]');
  if(process.env.OWNAPI_PG_ALLOW!=='1') throw new Error('OWNAPI_PG_ALLOW=1 required for the selected database');
  const config=persistentConfig();
  const input=JSON.parse(await readFile(file,'utf8'));
  const pool=persistentRolePool(config,'migration',{max:1});
  try {return await importPackage(pool,input,{dryRun,publisher:process.env.HATOOVE_CONTENT_PUBLISHER||'content-cli'});} finally {await pool.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await main(),null,2));} catch(e) {console.error('package import failed: '+e.message);process.exitCode=1;}
}
