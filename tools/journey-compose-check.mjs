#!/usr/bin/env node
/** Run the retained HTTP journey assertions in a source-only, disposable Compose project. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stamp=Date.now()+'-'+process.pid;
const project='hatoove-journey-check-'+stamp;
const schema='ownapi_journey_'+stamp.replaceAll('-','_');
const imageName=project+'-checker:latest';
const commandEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^(B1PREP_|OWNAPI_|STRIPE_|PAYMENTS_|HATOVE_|COMPOSE_|DEEPSEEK_|OPENAI_|ANTHROPIC_)/i.test(key)));
let scratch,source,envFile,composeFile,started=false,cleaned=false;
const evidence={project,schema,image:imageName,sourceRevision:null,sourceChanges:null,passed:false,cleaned:false};
const evidenceDir=path.join(root,'.qa','journey-compose',project);

function command(binary,args,{cwd=root,timeout=120000,allowFailure=false}={}) {
  const result=spawnSync(binary,args,{cwd,env:commandEnv,encoding:'utf8',windowsHide:true,timeout,maxBuffer:16*1024*1024});
  if(!allowFailure&&(result.error||result.status!==0))throw Error(`${binary} ${args[0]}: ${(result.error?.message||result.stderr||result.stdout||'').slice(-2000)}`);
  return result;
}
function output(binary,args,options){return (command(binary,args,options).stdout||'').trim();}
function compose(args,options={}) {
  return command('docker',['compose','--env-file',envFile,'--project-name',project,'--file',composeFile,...args],{cwd:source,...options});
}
function resources(kind) {
  const args={container:['ps','-a'],volume:['volume','ls'],network:['network','ls'],image:['image','ls']}[kind];
  assert.ok(args,'known resource kind');
  return [...new Set(output('docker',[...args,'-q','--filter','label=com.docker.compose.project='+project]).split(/\s+/).filter(Boolean))];
}
function inspect(kind,id) {
  return JSON.parse(output('docker',kind==='container'?['inspect',id]:[kind,'inspect',id]))[0];
}
function verifyResources() {
  assert.match(project,/^hatoove-journey-check-\d+-\d+$/);
  for(const kind of ['container','volume','network','image'])for(const id of resources(kind)) {
    const row=inspect(kind,id),labels=kind==='container'||kind==='image'?row.Config?.Labels:row.Labels;
    assert.equal(labels?.['com.docker.compose.project'],project,'exact disposable resource label');
    if(kind==='container') {
      assert.ok(['db','checker'].includes(labels['com.docker.compose.service']),'known disposable service');
      assert.equal(Object.keys(row.HostConfig.PortBindings||{}).length,0,'no host ports');
      // Docker's HostConfig.Binds also contains named volumes; inspect the resolved mount type.
      assert.equal((row.Mounts||[]).filter(mount=>mount.Type==='bind').length,0,'no host bind mounts');
      for(const mount of row.Mounts||[]) {
        assert.equal(mount.Type,'volume','only the named fixture database volume is allowed');
        assert.equal(labels['com.docker.compose.service'],'db','only the database has a volume');
        assert.equal(mount.Destination,'/var/lib/postgresql/data','only the database data path');
        assert.equal(inspect('volume',mount.Name).Labels?.['com.docker.compose.project'],project,'mounted volume belongs to this project');
      }
    }
    if(kind==='network')assert.equal(row.Internal,true,'no external egress');
    if(kind==='image')assert.deepEqual(row.RepoTags,[imageName],'only the generated image tag');
  }
}
function copySource() {
  const names=output('git',['ls-files','--cached','-z']).split('\0').filter(Boolean);
  for(const name of names) {
    if(/^(\.git|\.qa|handoff|design)(\/|$)/i.test(name)||/(^|\/)(\.env(?:\..*)?|node_modules)(\/|$)/i.test(name))continue;
    const from=path.resolve(root,name),to=path.resolve(source,name);
    assert.ok(from.startsWith(root+path.sep)&&to.startsWith(source+path.sep),'source paths remain in their roots');
    if(!fs.existsSync(from))continue;
    assert.ok(fs.lstatSync(from).isFile(),'source file is not a directory or link');
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
  }
  // The shipping image deliberately contains only runtime tools. Add this exact checker only
  // in the disposable source copy; no dependency, environment or learner data is copied.
  fs.appendFileSync(path.join(source,'.dockerignore'),'\n!tools/journey-api-check.mjs\n');
  fs.appendFileSync(path.join(source,'Dockerfile'),'\nCOPY tools/journey-api-check.mjs ./tools/journey-api-check.mjs\n');
}

try {
  evidence.sourceRevision=output('git',['rev-parse','HEAD']);
  evidence.sourceChanges=output('git',['status','--porcelain']);
  for(const kind of ['container','volume','network','image'])assert.equal(resources(kind).length,0,'generated project must be unused');
  assert.equal(output('docker',['image','ls','--format','{{.Repository}}:{{.Tag}}','--filter','reference='+imageName]),'','generated image tag must be unused');
  scratch=fs.mkdtempSync(path.join(os.tmpdir(),project+'-'));
  source=path.join(scratch,'source');envFile=path.join(scratch,'empty.env');composeFile=path.join(scratch,'journey.yaml');
  fs.mkdirSync(source);fs.writeFileSync(envFile,'');copySource();
  fs.writeFileSync(composeFile,`services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
      POSTGRES_DB: hatoove_journey_synthetic
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d hatoove_journey_synthetic"]
      interval: 1s
      timeout: 3s
      retries: 40
  checker:
    image: ${imageName}
    build:
      context: ./source
      labels:
        com.docker.compose.project: ${project}
    init: true
    command: ["node", "tools/journey-api-check.mjs"]
    environment:
      OWNAPI_PG_ALLOW: "1"
      OWNAPI_PG_HOST: db
      OWNAPI_PG_PORT: "5432"
      OWNAPI_PG_DATABASE: hatoove_journey_synthetic
      OWNAPI_PG_USER: postgres
      OWNAPI_PG_SCHEMA: ${schema}
      OWNAPI_PG_ROLE_PREFIX: ${schema}
      B1PREP_FORCE_OFFLINE: "1"
      B1PREP_CONTENT_MODE: internal-preview
      B1PREP_PUBLIC_ORIGIN: http://127.0.0.1:4481
      MFP14_JOURNEY_PORT: "4481"
    depends_on:
      db:
        condition: service_healthy
networks:
  default:
    internal: true
volumes:
  db-data:
`);
  console.log('Disposable journey project '+project+'; no published ports or host mounts.');
  started=true;
  compose(['build','checker'],{timeout:300000});
  compose(['up','--detach','--wait','db'],{timeout:90000});
  verifyResources();
  const result=compose(['run','--rm','--no-deps','-T','checker'],{timeout:180000,allowFailure:true});
  fs.mkdirSync(evidenceDir,{recursive:true});
  fs.writeFileSync(path.join(evidenceDir,'journey.log'),(result.stdout||'')+(result.stderr||''));
  console.log((result.stdout||'').trim());
  if(result.error||result.status!==0)throw Error('Journey checker failed: '+(result.error?.message||(result.stderr||'').slice(-1000)||'exit '+result.status));
  assert.match(result.stdout,/\b\d+ passed, 0 pending, 0 failed\b/,'actual journey summary is required');
  evidence.passed=true;
} catch(error) {
  evidence.error=error.message;
  console.error('FAIL disposable journey: '+error.message);
} finally {
  if(!started)cleaned=true; // No Docker operation occurred; an incomplete source copy can still be removed.
  if(started)try {
    verifyResources();
    compose(['down','--volumes','--remove-orphans'],{timeout:90000});
    if(resources('image').length)command('docker',['image','rm',imageName]);
    for(const kind of ['container','volume','network','image'])assert.equal(resources(kind).length,0,'disposable '+kind+' remains');
    cleaned=true;
  }catch(error){evidence.cleanupError=error.message;console.error('FAIL disposable cleanup: '+error.message);}
  if(scratch&&cleaned) {
    const resolved=fs.realpathSync(scratch),temp=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved),temp,'scratch is a direct child of the temporary directory');
    assert.ok(path.basename(resolved).startsWith(project+'-'),'exact scratch prefix');
    fs.rmSync(resolved,{recursive:true,force:true});
    evidence.scratchRemoved=!fs.existsSync(resolved);
  }
  evidence.cleaned=cleaned;evidence.finishedAt=new Date().toISOString();
  fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,'result.json'),JSON.stringify(evidence,null,2)+'\n');
}
console.log((evidence.passed&&cleaned?'PASS':'FAIL')+' source-only journey and cleanup; evidence '+evidenceDir);
process.exitCode=evidence.passed&&cleaned?0:1;
