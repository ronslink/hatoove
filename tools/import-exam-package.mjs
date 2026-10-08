#!/usr/bin/env node
/** Run in the existing Compose migration service with its restricted publisher connection. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { persistentConfig,persistentRolePool } from '../server/owned-postgres/provision.mjs';

export async function main(args=process.argv.slice(2)) {
  const dryRun=args.includes('--dry-run');
  /*
   * `--media-root` is the private directory the contract's `readMediaBytes` resolves against: it
   * CONTAINS the exam folders, so `content/exams/<exam>/audio/x.wav` is read from
   * `<media-root>/<exam>/audio/x.wav`. Audio bytes are deliberately not in this repository, so the
   * importer needs to be told where they are; without it the import fails closed on the first file.
   */
  const mediaIndex=args.indexOf('--media-root');
  const mediaRoot=mediaIndex<0?undefined:args[mediaIndex+1];
  const file=args.find((argument,index)=>!argument.startsWith('--')&&(mediaIndex<0||index!==mediaIndex+1));
  const unknownFlag=args.some((argument,index)=>argument.startsWith('--')&&!['--dry-run','--media-root'].includes(argument)&&index!==mediaIndex+1);
  if(!file || unknownFlag || (mediaIndex>=0 && (!mediaRoot || mediaRoot.startsWith('--'))))
    throw new Error('usage: node tools/import-exam-package.mjs package.json [--dry-run] [--media-root <absolute private directory>]');
  if(process.env.OWNAPI_PG_ALLOW!=='1') throw new Error('OWNAPI_PG_ALLOW=1 required for the selected database');
  const config=persistentConfig();
  const input=JSON.parse(await readFile(file,'utf8'));
  const pool=persistentRolePool(config,'migration',{max:1});
  try {return await importPackage(pool,input,{dryRun,mediaRoot,publisher:process.env.HATOOVE_CONTENT_PUBLISHER||'content-cli'});} finally {await pool.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await main(),null,2));} catch(e) {console.error('package import failed: '+e.message);process.exitCode=1;}
}
