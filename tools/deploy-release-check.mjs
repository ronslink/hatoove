/** No network, Docker or production paths are touched: malformed arguments fail before setup. */
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=readFileSync(new URL('../deploy/deploy-release.sh',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
const syntax=spawnSync(bash,['--noprofile','--norc','-n'],{input:script,encoding:'utf8',timeout:10000});
assert.equal(syntax.status,0,syntax.stderr);
const revision='a'.repeat(40),digest='b'.repeat(64);
for(const [rev,sha,expected] of [
 ['a'.repeat(39),digest,'git revision'],['a'.repeat(41),digest,'git revision'],
 ['abcdef01/../../outside',digest,'git revision'],['A'.repeat(40),digest,'git revision'],
 [revision,'b'.repeat(63),'archive sha256'],[revision,'b'.repeat(65),'archive sha256'],
 [revision,'abcdef01;touch /tmp/unwanted','archive sha256'],
]) {
 const result=spawnSync(bash,['--noprofile','--norc','-s','--',rev,'/nonexistent/archive.tar',sha],{input:script,encoding:'utf8',timeout:10000});
 assert.equal(result.status,2);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'Invalid '+expected);
}
const readable=script.indexOf('Worker secret readable; live configuration valid');
const composition=script.indexOf('Production composition verified; provider secret belongs only to worker');
const stopping=script.indexOf("printf 'Stopping app and worker");
assert(readable>0&&composition>readable&&stopping>composition,'Secret and composition preflight must precede downtime');
assert(script.includes('install -o 1000 -g 1000 -m 0400'));
assert(script.includes('worker_connections')&&script.includes("'{{.RestartCount}}'"));
console.log('PASS deployment shell syntax, seven real malformed-input refusals, and pre-downtime secret/worker guards');
const workflow=readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const gate=workflow.split('      - name: Verify both CI workflows succeeded for target commit\n')[1].split('        id: gate')[0].split('        run: |\n')[1].replace(/^          /gm,'');
const fixture=mkdtempSync(path.join(tmpdir(),'hatoove-deploy-gate-'));
const output=path.join(fixture,'output');
const commands=`git(){ if [ "$1" = rev-parse ]; then printf '%s\\n' '${revision}'; else return 0; fi; }
gh(){ case "$*" in *"$TEST_FAILED_WORKFLOW"*) case "$*" in *conclusion*) printf '%s\\n' "$TEST_CONCLUSION";; *status*) printf '%s\\n' "$TEST_STATUS";; esac;; *) case "$*" in *conclusion*) printf 'success\\n';; *status*) printf 'completed\\n';; esac;; esac; }
`;
try {
 for(const event of ['workflow_run','workflow_dispatch'])for(const failed of ['ci.yml','pilot-contracts.yml'])for(const state of ['success','failure','in_progress']){
  rmSync(output,{force:true});
  const result=spawnSync(bash,['--noprofile','--norc','-s'],{input:commands+gate,encoding:'utf8',timeout:10000,env:{...process.env,EVENT_NAME:event,REPO:'synthetic/fixture',GITHUB_OUTPUT:output.replaceAll('\\','/'),TEST_FAILED_WORKFLOW:failed,TEST_CONCLUSION:state==='in_progress'?'none':state,TEST_STATUS:state==='in_progress'?'in_progress':'completed'}});
  assert.equal(result.status,event==='workflow_dispatch'&&state!=='success'?1:0,result.stderr);
  if(state==='success')assert(readFileSync(output,'utf8').includes('ready=true'));
  else if(event==='workflow_run')assert.equal(readFileSync(output,'utf8').trim(),'ready=false');
 }
} finally {rmSync(fixture,{recursive:true,force:true});}
console.log('PASS actual workflow gate refuses failed or unfinished CI for both manual and automatic deployments');
