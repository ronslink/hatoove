#!/usr/bin/env node
/** Explicitly authorized disposable execution only; default invocation never starts anything. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertProductionModel,isolatedEnvironment} from './production-compose-check.mjs';
import {writeSourceFixture} from './production-runtime-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--run-disposable'||!/^--caddy-image=caddy:2(?:\.[0-9]+){0,2}(?:-alpine)?$/.test(args[1])) {
  console.error('Usage: node tools/production-runtime-check.mjs --run-disposable --caddy-image=caddy:2[.x.y][-alpine] (requires a separate execution lease and preexisting images)');
  process.exit(2);
}
const caddyRef=args[1].slice('--caddy-image='.length);
const stamp=Date.now()+'-'+process.pid,deadline=Date.now()+25*60*1000;
const receipt={scope:'synthetic_hosting_engineering',sourceRevision:null,sourceChanges:null,dockerEndpoint:null,images:{},variants:[],uncertainOperations:[],passed:false,limitations:[
  'No Cloudflare, public DNS or ACME issuance/renewal proof',
  'Generated local certificate trust; no physical-device or browser acceptance',
  'Named content review is synthetic and carries no human approval',
  'Payments stub only; deterministic worker remains a deployment blocker',
  'Functional evidence is not capacity, backup/restore or production acceptance',
]};
const evidenceDir=path.join(root,'.qa','hosting-runtime',stamp);
let controlScratch=null,env;
// Context metadata is read once, before pinning. Never inherit endpoint, credential or preload overrides.
let endpoint=null,current=null,stage='local_docker_pin',cancelled=false,operationSequence=0;
const cancel=()=>{cancelled=true;};
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
function run(binary,argv,{cwd=root,timeout=90000,allowFailure=false,environment=env,daemonOperation=null}={}) {
  if((Date.now()>deadline||cancelled)&&!current?.cleaning)throw Error('overall_deadline_or_cancel');
  const operation=daemonOperation?{sequence:++operationSequence,kind:daemonOperation,project:current?.project??null,stage,timeoutMs:timeout}:null;
  let result;
  try {result=spawnSync(binary,argv,{cwd,env:environment,encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024});}
  catch {result={error:true,status:null};}
  if(operation&&(result.error||result.signal||result.status===null||[130,143].includes(result.status)||cancelled&&!current?.cleaning)) {
    // A dead CLI is not proof that a submitted daemon operation stopped. Even an
    // immediately empty listing cannot resolve this uncertainty or authorize reuse.
    receipt.uncertainOperations.push({...operation,outcome:'completion_unconfirmed'});
    throw Error('daemon_operation_unconfirmed');
  }
  if(cancelled&&!current?.cleaning)throw Error('cancelled');
  if(!allowFailure&&(result.error||result.status!==0))throw Error('command_failed_'+stage);
  return result;
}
function dockerResult(argv,options){assert.ok(endpoint);return run('docker',['--host',endpoint,...argv],{...options,daemonOperation:['build','run','compose','inspect','ps','network','volume','image'].includes(argv[0])?argv[0]:'other'});}
function docker(argv,options){return (dockerResult(argv,options).stdout||'').trim();}
function inspect(kind,name) {
  const result=dockerResult(kind==='container'?['inspect',name]:[kind,'inspect',name],{allowFailure:true});
  if(result.error)throw Error('inspection_timeout');
  if(result.status!==0) {
    if(/No such (?:object|container|image|volume|network)/i.test(result.stderr))return null;
    throw Error('inspection_failed');
  }
  return JSON.parse(result.stdout)[0];
}
function labels(kind,row){return kind==='container'||kind==='image'?row.Config?.Labels:row.Labels;}
function owned(kind,row) {
  assert.ok(row);assert.equal(labels(kind,row)?.['org.hatoove.hosting-fixture'],current.project);
  if(kind==='container') {
    const service=row.Config.Labels?.['com.docker.compose.service'];
    if(service){assert.equal(row.Config.Labels['com.docker.compose.project'],current.project);assert.ok(['app','worker','migrate','ingress','db','tlsdb','probe'].includes(service));}
    else assert.ok(['/'+current.project+'-certificates','/'+current.project+'-caddy-adapt'].includes(row.Name));
    assert.ok(row.Name.startsWith('/'+current.project+'-'));
    assert.equal(Object.keys(row.HostConfig.PortBindings||{}).length,0,'fixture publishes no host ports');
    assert.equal(row.HostConfig.Privileged,false);
    for(const mount of row.Mounts??[])if(mount.Type==='volume')owned('volume',inspect('volume',mount.Name));
    else if(mount.Type==='bind') {
      const from=path.resolve(mount.Source),scratch=fs.realpathSync(current.scratch);
      // On Docker Desktop the daemon reports native Linux paths for Windows bind sources.
      const normalized=mount.Source.replaceAll('\\','/').toLowerCase();
      const expected=scratch.replaceAll('\\','/').toLowerCase();
      assert.ok(from.startsWith(scratch+path.sep)||normalized.startsWith('/run/desktop/mnt/host/'+expected.replace(/^([a-z]):/,'$1')+'/')||normalized.startsWith('/host_mnt/'+expected.replace(/^([a-z]):/,'$1')+'/'),'bind belongs to exact scratch');
    }
  }
  if(kind==='volume')assert.ok(['caddy-data','caddy-config','pg-data'].some(suffix=>row.Name===current.project+'-'+suffix));
  if(kind==='network'){assert.equal(row.Internal,true);assert.ok(['application','backend','edge'].some(suffix=>row.Name===current.project+'_'+suffix));}
}
function listed(kind) {
  const command={container:['ps','-a'],network:['network','ls'],volume:['volume','ls'],image:['image','ls']}[kind];
  return [...new Set(docker([...command,'-q','--filter','label=org.hatoove.hosting-fixture='+current.project]).split(/\s+/).filter(Boolean))];
}
function preflightCompose() {
  for(const [kind,command] of Object.entries({container:['ps','-a'],network:['network','ls'],volume:['volume','ls'],image:['image','ls']}))
    assert.equal(docker([...command,'-q','--filter','label=com.docker.compose.project='+current.project]),'','Compose project label already exists: '+kind);
  for(const service of ['app','worker','migrate','ingress','db','tlsdb','probe'])
    for(const name of [current.project+'-'+service+'-1',current.project+'_'+service+'_1'])
      assert.equal(inspect('container',name),null,'generated service name already exists');
  for(const network of ['application','backend','edge'])
    assert.equal(inspect('network',current.project+'_'+network),null,'generated network name already exists');
}
function compose(argv,{phase='base',...options}={}) {
  const files=['compose.production.yaml','compose.production.'+current.variant+'-db.yaml'].flatMap(name=>['-f',path.join(current.source,name)]);
  files.push('-f',current.overlay);
  if(phase!=='base')files.push('-f',path.join(current.scratch,phase+'.yaml'));
  return dockerResult(['compose','--project-directory',current.source,'--project-name',current.project,'--env-file',current.envFile,...files,...argv],options);
}
function jsonOutput(result){assert.equal(result.status,0);return JSON.parse(result.stdout);}
function resourceName(kind,suffix){const name=current.project+'-'+suffix;assert.equal(inspect(kind,name),null,'generated name already exists');return name;}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value));}
const volumeLabel=project=>'org.hatoove.hosting-fixture='+project;
function sourceCopy(target) {
  const git=args=>run('git',['-c','safe.directory='+root,...args]);
  const revision=git(['rev-parse','HEAD']).stdout.trim(),changes=git(['status','--porcelain']).stdout.trim();
  assert.equal(changes,'','freeze a clean source commit before execution');
  if(receipt.sourceRevision)assert.equal(revision,receipt.sourceRevision);else {receipt.sourceRevision=revision;receipt.sourceChanges=changes;}
  for(const name of git(['ls-files','--cached','-z']).stdout.split('\0').filter(Boolean)) {
    if(/^(?:\.git|\.qa|handoff|design)(?:\/|$)/i.test(name)||/(?:^|\/)(?:\.env(?:\..*)?|node_modules)(?:\/|$)/i.test(name))continue;
    const from=path.resolve(root,name),to=path.resolve(target,name);
    assert.ok(from.startsWith(root+path.sep)&&to.startsWith(target+path.sep));
    assert.ok(fs.lstatSync(from).isFile()&&!fs.lstatSync(from).isSymbolicLink());
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
  }
}
function image(ref) {
  const row=inspect('image',ref);assert.ok(row,'required image must already exist; no implicit pull');
  assert.match(row.Id,/^sha256:[a-f0-9]{64}$/);
  const repository=ref.split(':')[0],digest=(row.RepoDigests??[]).find(value=>value.startsWith(repository+'@sha256:'));
  assert.ok(digest,'stock image must have an immutable repository digest');
  receipt.images[ref]={id:row.Id,digest};return {id:row.Id,digest};
}
function requireClosedOverlay(before,after) {
  const extra=current.variant==='managed'?['probe','tlsdb']:['probe'];
  assert.deepEqual(Object.keys(after.services).sort(),[...Object.keys(before.services),...extra].sort());
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort());
  for(const key of Object.keys(before).filter(key=>!['services','networks'].includes(key)))assert.deepEqual(after[key],before[key],'undeclared top-level overlay change');
  assert.deepEqual(Object.keys(after.networks).sort(),Object.keys(before.networks).sort());
  for(const [name,base] of Object.entries(before.networks))
    assert.deepEqual(after.networks[name],{...base,internal:true,labels:{'org.hatoove.hosting-fixture':current.project}});
  const images={app:current.appImage,worker:current.appImage,migrate:current.appImage,ingress:receipt.images[caddyRef].id,db:receipt.images['postgres:17-alpine'].id};
  for(const [name,base] of Object.entries(before.services)) {
    const changed=structuredClone(after.services[name]);
    assert.equal(changed.image,images[name]);changed.image=base.image;
    assert.equal(changed.labels['org.hatoove.hosting-fixture'],current.project);delete changed.labels;
    if(base.labels)changed.labels=base.labels;
    if(name==='ingress') {assert.ok(!changed.ports?.length);changed.ports=base.ports;
      assert.equal(changed.volumes.length,4);
      // Exact generated TLS config and certificate mount are the only ingress changes.
      const originalConfig=base.volumes.find(mount=>mount.target==='/etc/caddy/Caddyfile');
      assert.deepEqual(changed.volumes.find(mount=>mount.target==='/etc/caddy/Caddyfile'),{...originalConfig,source:path.join(current.scratch,'Caddyfile')});
      const tls=changed.volumes.find(mount=>mount.target==='/fixture-tls');
      assert.deepEqual(tls,{type:'bind',source:path.join(current.scratch,'ingress-tls'),target:'/fixture-tls',read_only:true,bind:{create_host_path:false}});
      const byTarget=(a,b)=>a.target.localeCompare(b.target);
      assert.deepEqual(changed.volumes.filter(mount=>!['/etc/caddy/Caddyfile','/fixture-tls'].includes(mount.target)).sort(byTarget),
        base.volumes.filter(mount=>mount.target!=='/etc/caddy/Caddyfile').sort(byTarget),'retained Caddy volume mounts must be byte-equivalent');
      changed.volumes=base.volumes;
    }
    if(name==='migrate') {
      assert.equal(changed.environment.HOSTING_FIXTURE_ID,current.project);delete changed.environment.HOSTING_FIXTURE_ID;
      const extraMount=changed.volumes.find(mount=>mount.target==='/fixture/binding.json');
      assert.deepEqual(extraMount,{type:'bind',source:path.join(current.scratch,'binding.json'),target:'/fixture/binding.json',read_only:true,bind:{create_host_path:false}});
      changed.volumes=changed.volumes.filter(mount=>mount.target!=='/fixture/binding.json');if(!base.volumes?.length)delete changed.volumes;
    }
    assert.deepEqual(changed,base,'undeclared overlay change: '+name);
  }
  for(const network of Object.values(after.networks))assert.equal(network.internal,true);
  for(const service of Object.values(after.services))assert.ok(!service.ports?.length,'no fixture host ports');
}
function record(name,data={}){current.receipt.checks.push({name,...data});console.log('PASS '+current.variant+' '+name);}
function fixture(action) {
  return jsonOutput(compose(['run','--rm','--no-deps','-T','migrate','node','tools/production-runtime-fixture.mjs',action],{timeout:90000}));
}
function probe(mode,{phase='base'}={}) {
  const result=jsonOutput(compose(['run','--rm','--no-deps','-T','probe','node','tools/production-runtime-probe.mjs',mode],{phase,timeout:90000}));
  assert.equal(result.mode,mode);assert.ok(result.passed>0);record('https_'+mode,{checks:result.checks});
}
function running(service) {
  const result=compose(['ps','-a','-q',service]);assert.equal(result.status,0);
  const ids=result.stdout.trim().split(/\s+/).filter(Boolean);assert.equal(ids.length,1);
  const row=inspect('container',ids[0]);owned('container',row);return row;
}
function preparePhase(name,services){fs.writeFileSync(path.join(current.scratch,name+'.yaml'),JSON.stringify({services}));}
async function prepare(variant,nodeImage,pgImage,caddyImage) {
  const project='hatoove-hosting-'+stamp+'-'+variant,schema='ownapi_hosting_'+stamp.replaceAll('-','_')+'_'+variant;
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),project+'-')),source=path.join(scratch,'source');
  current={project,variant,scratch,source,schema,overlay:path.join(scratch,'fixture.yaml'),envFile:path.join(scratch,'inputs.env'),canCleanup:false,cleaning:false,
    receipt:{project,variant,schema,roles:['migration','auth','learner','worker','deletion','payments','provisioner'].map(role=>schema+'_'+role),checks:[],resources:[],cleanupErrors:[],cleaned:false}};
  receipt.variants.push(current.receipt);
  for(const kind of ['container','network','volume','image'])assert.equal(listed(kind).length,0,'generated ownership label already exists');
  preflightCompose();
  for(const suffix of ['caddy-data','caddy-config','pg-data'])resourceName('volume',suffix);
  resourceName('container','certificates');resourceName('container','caddy-adapt');
  fs.mkdirSync(source);sourceCopy(source);
  await writeSourceFixture(source);
  const tools=['production-runtime-fixture','production-runtime-probe','exam-s5-fixture','exam-s5b-fixture','exam-s6-fixture'];
  fs.appendFileSync(path.join(source,'.dockerignore'),'\n'+tools.map(name=>'!tools/'+name+'.mjs').join('\n')+'\n');
  const dockerfile=fs.readFileSync(path.join(source,'Dockerfile'),'utf8');
  assert.equal(dockerfile.split('FROM node:22-bookworm').length,2);
  fs.writeFileSync(path.join(source,'Dockerfile'),dockerfile.replace('FROM node:22-bookworm','FROM '+nodeImage.digest)+'\n'+tools.map(name=>'COPY tools/'+name+'.mjs ./tools/'+name+'.mjs').join('\n')+'\n');
  for(const name of ['secrets','certificates','trust','ingress-tls','postgres-tls'])fs.mkdirSync(path.join(scratch,name));
  const roles=['admin','migration','auth','learner','worker','deletion','payments','provisioner'];
  for(const role of roles)fs.writeFileSync(path.join(scratch,'secrets',role),randomBytes(32).toString('hex'),{mode:0o600});
  const webhookSecret='whsec_synthetic_'+randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(scratch,'webhook-secret'),webhookSecret,{mode:0o600});
  writeJson(path.join(scratch,'binding.json'),{project,variant,schema,database:'hatoove_hosting_synthetic'});
  const appTag=project+'-app:fixture';
  assert.equal(inspect('image',appTag),null);
  current.canCleanup=true;current.appTag=appTag;
  current.receipt.recoveryScope={label:volumeLabel(project),composeProject:project,imageTag:appTag,
    helperNames:[project+'-certificates',project+'-caddy-adapt'],serviceNames:['app','worker','migrate','ingress','db','tlsdb','probe'].map(name=>project+'-'+name+'-1'),
    networkNames:['application','backend','edge'].map(name=>project+'_'+name),volumeNames:['caddy-data','caddy-config',...(variant==='local'?['pg-data']:[])].map(name=>project+'-'+name)};
  docker(['build','--pull=false','--label',volumeLabel(project),'-t',appTag,source],{timeout:300000});current.appImage=inspect('image',appTag).Id;
  current.receipt.appImage=current.appImage;
  const certName=resourceName('container','certificates');
  const certCommands=[
    'cd /certificates',
    'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Hatoove-Hosting-Disposable -keyout ca.key -out ca.crt',
    'for pair in ingress:hatoove.com postgres:tls-db.fixture.invalid; do name=$'+'{pair%%:*}; host=$'+'{pair#*:}; printf "subjectAltName=DNS:%s\\nextendedKeyUsage=serverAuth\\n" "$host" > "$name.ext"; openssl req -newkey rsa:2048 -nodes -subj "/CN=$host" -keyout "$name.key" -out "$name.csr"; openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile "$name.ext" -out "$name.crt"; done',
    'uid=$(id -u node); gid=$(id -g node); test "$uid" -ne 0; chown "$uid:$gid" /secrets/* /webhook-secret; chmod 400 /secrets/* /webhook-secret; chmod 644 ca.crt ingress.crt postgres.crt; chmod 600 ca.key ingress.key postgres.key',
    // Keep keys root0600: an unprivileged host must not need to read them in order
    // to prepare the two narrower service mounts. Only the public CA is copied later.
    'cp ingress.crt ingress.key /ingress-tls/; cp postgres.crt postgres.key /postgres-tls/; chmod 600 /ingress-tls/ingress.key /postgres-tls/postgres.key',
  ].join('\n');
  docker(['run','--name',certName,'--label',volumeLabel(project),'--network','none','--pull','never','--mount','type=bind,source='+path.join(scratch,'certificates')+',target=/certificates','--mount','type=bind,source='+path.join(scratch,'secrets')+',target=/secrets','--mount','type=bind,source='+path.join(scratch,'webhook-secret')+',target=/webhook-secret',
    ...['ingress','postgres'].flatMap(name=>['--mount','type=bind,source='+path.join(scratch,name+'-tls')+',target=/'+name+'-tls']),nodeImage.id,'sh','-ceu',certCommands]);
  owned('container',inspect('container',certName));current.receipt.resources.push({kind:'container',name:certName,id:inspect('container',certName).Id});
  fs.copyFileSync(path.join(scratch,'certificates','ca.crt'),path.join(scratch,'trust','provider-ca.pem'));
  const original=fs.readFileSync(path.join(source,'deploy/Caddyfile'),'utf8');
  const tlsBlock=/\ttls \{\r?\n\t\tissuer acme \{\r?\n\t\t\tdisable_tlsalpn_challenge\r?\n\t\t\}\r?\n\t\}/;
  assert.equal((original.match(new RegExp(tlsBlock.source,'g'))??[]).length,1);
  fs.writeFileSync(path.join(scratch,'Caddyfile'),original.replace(tlsBlock,'\ttls /fixture-tls/ingress.crt /fixture-tls/ingress.key'));
  const adaptName=resourceName('container','caddy-adapt');
  const adapted=JSON.parse(docker(['run','--name',adaptName,'--label',volumeLabel(project),'--network','none','--pull','never','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--tmpfs','/data','--tmpfs','/config','--mount','type=bind,source='+path.join(source,'deploy/Caddyfile')+',target=/etc/caddy/Caddyfile,readonly',caddyImage.id,'caddy','adapt','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']));
  const issuers=adapted.apps?.tls?.automation?.policies?.flatMap(policy=>policy.issuers??[])??[];
  assert.ok(issuers.some(issuer=>issuer.module==='acme'&&issuer.challenges?.['tls-alpn']?.disabled===true&&!issuer.challenges?.http?.disabled));
  record('original_caddy_http01_adaptation');
  const volumes={};
  for(const suffix of ['caddy-data','caddy-config',...(variant==='local'?['pg-data']:[])]) {
    const name=resourceName('volume',suffix);docker(['volume','create','--label',volumeLabel(project),name]);owned('volume',inspect('volume',name));volumes[suffix]=name;
  }
  const values={HATOVE_APP_IMAGE:'hatoove-fixture@'+current.appImage,HATOVE_CADDY_IMAGE:caddyImage.digest,HATOVE_POSTGRES_IMAGE:pgImage.digest,
    OWNAPI_PG_DATABASE:'hatoove_hosting_synthetic',HATOVE_PG_ADMIN_USER:'postgres',OWNAPI_PG_SCHEMA:schema,OWNAPI_PG_ROLE_PREFIX:schema,OWNAPI_PG_CONNECTION_BUDGET:'12',
    HATOVE_CADDY_DATA_VOLUME:volumes['caddy-data'],HATOVE_CADDY_CONFIG_VOLUME:volumes['caddy-config'],HATOVE_PG_DATA_VOLUME:volumes['pg-data']??'unused',
    HATOVE_MANAGED_PG_HOST:'tls-db.fixture.invalid',HATOVE_MANAGED_PG_PORT:'5432',HATOVE_PG_TRUST_DIR:path.join(scratch,'trust'),OWNAPI_PG_TLS_CA_FILE:variant==='managed'?'/run/hatoove/pg-trust/provider-ca.pem':undefined};
  for(const role of roles)values['HATOVE_PG_'+role.toUpperCase()+'_PASSWORD_SOURCE']=path.join(scratch,'secrets',role);
  fs.writeFileSync(current.envFile,Object.entries(values).filter(([,value])=>value!==undefined).map(([key,value])=>key+'='+String(value).replaceAll('\\','/')).join('\n'));
  const baseArgs=['compose','--project-directory',source,'--project-name',project,'--env-file',current.envFile,'-f',path.join(source,'compose.production.yaml'),'-f',path.join(source,'compose.production.'+variant+'-db.yaml'),'config','--format','json'];
  const baseline=JSON.parse(docker(baseArgs));assertProductionModel(baseline,variant);
  const bind=(file,target,readonly=true)=>({type:'bind',source:file,target,read_only:readonly,bind:{create_host_path:false}});
  const label={'org.hatoove.hosting-fixture':project};
  const services={
    app:{image:current.appImage,labels:label},worker:{image:current.appImage,labels:label},
    migrate:{image:current.appImage,labels:label,environment:{HOSTING_FIXTURE_ID:project},volumes:[bind(path.join(scratch,'binding.json'),'/fixture/binding.json')]},
    ingress:{image:caddyImage.id,labels:label,volumes:[bind(path.join(scratch,'Caddyfile'),'/etc/caddy/Caddyfile'),bind(path.join(scratch,'ingress-tls'),'/fixture-tls')]},
    probe:{image:current.appImage,pull_policy:'never',labels:label,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],networks:['application'],environment:{HOSTING_FIXTURE_ID:project},
      volumes:[bind(path.join(scratch,'binding.json'),'/fixture/binding.json'),bind(path.join(scratch,'trust','provider-ca.pem'),'/fixture/ca.crt'),bind(path.join(scratch,'webhook-secret'),'/fixture/webhook-secret')]},
  };
  if(variant==='local')services.db={image:pgImage.id,labels:label};
  else services.tlsdb={image:pgImage.id,pull_policy:'never',labels:label,networks:{backend:{aliases:['tls-db.fixture.invalid']}},tmpfs:['/var/lib/postgresql/data'],secrets:['pg_admin'],
    environment:{POSTGRES_DB:'hatoove_hosting_synthetic',POSTGRES_PASSWORD_FILE:'/run/secrets/pg_admin',POSTGRES_INITDB_ARGS:'--auth-host=scram-sha-256 --auth-local=scram-sha-256',POSTGRES_HOST_AUTH_METHOD:'scram-sha-256'},
    volumes:[bind(path.join(scratch,'postgres-tls'),'/fixture-tls')],
    command:['sh','-ceu','mkdir -p /tmp/hosting-tls; cp /fixture-tls/postgres.key /fixture-tls/postgres.crt /tmp/hosting-tls/; chown postgres:postgres /tmp/hosting-tls/*; chmod 600 /tmp/hosting-tls/postgres.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_key_file=/tmp/hosting-tls/postgres.key -c ssl_cert_file=/tmp/hosting-tls/postgres.crt'],
    healthcheck:{test:['CMD-SHELL','pg_isready -U postgres -d hatoove_hosting_synthetic'],interval:'1s',timeout:'3s',retries:40}};
  let overlay='services:\n';
  for(const [name,service] of Object.entries(services)){overlay+='  '+name+':\n';for(const [key,value] of Object.entries(service))overlay+='    '+key+': '+JSON.stringify(value)+'\n';if(name==='ingress')overlay+='    ports: !reset []\n';}
  overlay+='networks:\n';for(const name of ['application','backend','edge'])overlay+='  '+name+': '+JSON.stringify({internal:true,labels:label})+'\n';
  fs.writeFileSync(current.overlay,overlay);
  requireClosedOverlay(baseline,jsonOutput(compose(['config','--format','json'])));
  record('exact_production_pair_and_closed_fixture_overlay');
  preparePhase('stub',{app:{environment:{PAYMENTS_MODE:'stub',STRIPE_WEBHOOK_SECRET:webhookSecret}}});
  const faultDir=path.join(scratch,'pending-migrations');fs.mkdirSync(faultDir);
  for(const file of fs.readdirSync(path.join(source,'server/migrations')).filter(name=>/^\d{4}-.*\.sql$/.test(name)))fs.copyFileSync(path.join(source,'server/migrations',file),path.join(faultDir,file));
  fs.writeFileSync(path.join(faultDir,'9999-hosting-synthetic-failure.sql'),"CREATE TABLE hosting_upgrade_rollback_marker(id integer); DO $$ BEGIN RAISE EXCEPTION 'hosting_synthetic_failure'; END $$;\n");
  const fault={environment:{OWNAPI_MIGRATIONS_DIR:'/fixture/pending-migrations'},volumes:[bind(faultDir,'/fixture/pending-migrations')]};
  preparePhase('stale',{app:fault});preparePhase('failure',{migrate:fault});
}

async function executeVariant() {
  const dbService=current.variant==='local'?'db':'tlsdb';
  stage=current.variant+'_startup';
  preflightCompose(); // Compose itself must not discover/recreate an existing foreign project.
  compose(['up','-d','--wait','--wait-timeout','60',dbService]);
  compose(['up','--no-deps','--force-recreate','--abort-on-container-exit','--exit-code-from','migrate','migrate']);
  const oldMigration=running('migrate');assert.equal(oldMigration.State.ExitCode,0);
  compose(['up','-d','--no-deps','--wait','--wait-timeout','60','app','worker','ingress']);
  assert.equal(running('app').State.Running,true);const worker=running('worker');assert.equal(worker.State.Running,true);
  const workerAddress=worker.NetworkSettings.Networks[current.project+'_backend'].IPAddress;
  assert.match(workerAddress,/^\d{1,3}(?:\.\d{1,3}){3}$/);
  const bindingFile=path.join(current.scratch,'binding.json'),binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
  writeJson(bindingFile,{...binding,workerAddress});
  for(const [service,names] of [['app',['auth','learner','worker','deletion','payments','provisioner']],['worker',['worker']]]) {
    const expected=names.map(name=>'pg_'+name).sort();
    const program="const fs=require('node:fs'),assert=require('node:assert/strict');assert.ok(process.getuid()>0);const expected="+JSON.stringify(expected)+";assert.deepEqual(fs.readdirSync('/run/secrets').sort(),expected);for(const name of expected)assert.ok(fs.readFileSync('/run/secrets/'+name).length>0);console.log(JSON.stringify({uid:process.getuid(),secretScopeVerified:true}));";
    const verified=jsonOutput(compose(['exec','-T',service,'node','-e',program]));assert.equal(verified.secretScopeVerified,true);
    record('unprivileged_'+service+'_exact_readable_secret_scope',{uid:verified.uid});
  }
  let connections;
  for(let n=0;n<40;n++){connections=fixture('connections');if(connections.workerConnected)break;await new Promise(resolve=>setTimeout(resolve,250));}
  assert.equal(connections.workerConnected,true);
  if(current.variant==='managed')assert.equal(connections.allTls,true);
  record('fresh_migration_restricted_runtime_and_worker_connected',{tls:connections.allTls});
  probe('initial');
  const seed=fixture('seed');record('exact_named_synthetic_publication',seed);
  probe('public');
  stage=current.variant+'_webhook';
  compose(['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','60','app'],{phase:'stub'});
  const before=fixture('snapshot');probe('stub',{phase:'stub'});const after=fixture('snapshot');
  assert.deepEqual(after.fingerprints,before.fingerprints);assert.equal(after.eventCount,before.eventCount+1);assert.equal(after.ledgerHash,before.ledgerHash);
  record('signed_webhook_single_receipt_and_unchanged_saved_facts');
  stage=current.variant+'_stale_schema';
  compose(['stop','--timeout','60','app','worker']);
  compose(['up','-d','--no-deps','--force-recreate','app'],{phase:'stale'});
  // A schema refusal deliberately remains unhealthy; wait for liveness, not ready=true.
  let alive=false;
  for(let n=0;n<40;n++) {
    const result=compose(['exec','-T','app','node','-e',"fetch('http://127.0.0.1:4321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{phase:'stale',allowFailure:true,timeout:5000});
    if(result.status===0){alive=true;break;}await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(alive,true);probe('stale');
  assert.equal(fixture('snapshot').pendingRecorded,false);
  compose(['stop','--timeout','60','app']);
  compose(['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','60','app','worker']);
  assert.equal(running('app').State.Running,true);assert.equal(running('worker').State.Running,true);
  stage=current.variant+'_failed_upgrade';
  const preserved=fixture('snapshot');
  // The actual runbook sequence starts with existing running services, stops both, and
  // never executes the success-only restart after the deliberately failed fresh migrator.
  compose(['stop','--timeout','60','app','worker']);
  assert.equal(running('app').State.Running,false);assert.equal(running('worker').State.Running,false);
  const failed=compose(['up','--no-deps','--force-recreate','--abort-on-container-exit','--exit-code-from','migrate','migrate'],{phase:'failure',allowFailure:true});
  assert.ok(!failed.error&&failed.status!==0);assert.match(failed.stdout+failed.stderr,/hosting_synthetic_failure/);
  const fresh=running('migrate');assert.notEqual(fresh.Id,oldMigration.Id);assert.notEqual(fresh.State.ExitCode,0);
  assert.equal(running('app').State.Running,false);assert.equal(running('worker').State.Running,false);
  const retained=fixture('snapshot');assert.equal(retained.markerPresent,false);assert.equal(retained.pendingRecorded,false);
  assert.deepEqual(retained,preserved);probe('unavailable');
  record('failed_fresh_upgrade_rolls_back_and_withholds_restart',{oldMigratorId:oldMigration.Id,newMigratorId:fresh.Id});
}
function cleanup() {
  current.cleaning=true;const errors=current.receipt.cleanupErrors;
  const attempt=(label,work)=>{try{work();}catch{errors.push(label);}};
  // Independent attempts: one failure must not skip later known-owned cleanup.
  for(const kind of current.canCleanup?['container','network','volume']:[]) {
    let ids=[];attempt('list_'+kind,()=>{ids=listed(kind);});
    for(const id of ids)attempt('remove_'+kind,()=>{
      const row=inspect(kind,id);owned(kind,row);current.receipt.resources.push({kind,id,name:row.Name??row.name??null});
      docker(kind==='container'?['rm','-f',id]:[kind,'rm',id],{timeout:90000});
    });
  }
  if(current.canCleanup&&current.appTag)attempt('remove_image',()=>{
    const row=inspect('image',current.appTag);if(!row)return;owned('image',row);
    assert.deepEqual(row.RepoTags,[current.appTag]);docker(['image','rm',current.appTag]);
  });
  for(const kind of current.canCleanup?['container','network','volume','image']:[])attempt('verify_'+kind,()=>assert.equal(listed(kind).length,0));
  current.receipt.uncertainOperations=receipt.uncertainOperations.filter(operation=>operation.project===current.project);
  if(current.receipt.uncertainOperations.length)errors.push('daemon_operation_completion_unconfirmed');
  if(!errors.length)attempt('scratch',()=>{
    const resolved=fs.realpathSync(current.scratch);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(current.project+'-'));assert.equal(fs.lstatSync(current.scratch).isSymbolicLink(),false);
    fs.rmSync(resolved,{recursive:true,force:true});assert.equal(fs.existsSync(resolved),false);
  });
  current.receipt.cleaned=errors.length===0;
  if(current.receipt.cleaned)current.receipt.databaseDisposition=current.canCleanup
    ?'Owned disposable database container and any data volume removed; no surviving shared database was used'
    :'No daemon mutation was authorized for this variant; only its generated scratch was removed';
  if(errors.length)current.receipt.recoveryScratch=current.scratch;
}

try {
  controlScratch=fs.mkdtempSync(path.join(os.tmpdir(),'hatoove-hosting-cli-'+stamp+'-'));
  env=isolatedEnvironment(process.env,controlScratch);
  fs.mkdirSync(env.DOCKER_CONFIG);
  const systemPlugins=process.platform==='win32'&&process.env.ProgramFiles?path.join(process.env.ProgramFiles,'Docker','cli-plugins'):null;
  fs.writeFileSync(path.join(env.DOCKER_CONFIG,'config.json'),JSON.stringify(systemPlugins&&fs.existsSync(systemPlugins)?{cliPluginsExtraDirs:[systemPlugins]}:{}));
  // Context read is metadata only. All daemon operations below use this exact local endpoint.
  const contextEnv={...env};delete contextEnv.DOCKER_CONFIG;delete contextEnv.HOME;delete contextEnv.USERPROFILE;
  for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])contextEnv[key]=process.env[key];
  const contexts=JSON.parse(run('docker',['context','inspect'],{environment:contextEnv}).stdout);
  assert.equal(contexts.length,1);endpoint=contexts[0]?.Endpoints?.docker?.Host;
  assert.ok(typeof endpoint==='string'&&(process.platform==='win32'?/^npipe:\/{2,4}\.\/pipe\/[A-Za-z0-9_.-]+$/:/^unix:\/\/\/[^?#\x00\r\n]+$/).test(endpoint));
  receipt.dockerEndpoint=endpoint;
  const nodeImage=image('node:22-bookworm'),pgImage=image('postgres:17-alpine'),caddyImage=image(caddyRef);
  for(const variant of ['local','managed']) {
    try {await prepare(variant,nodeImage,pgImage,caddyImage);await executeVariant();}
    finally {if(current)cleanup();}
    assert.equal(current.receipt.cleaned,true,'cleanup must succeed before another variant');
    current=null;
  }
  receipt.passed=true;
} catch {receipt.failureStage=stage;process.exitCode=1;}
finally {
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  try {if(receipt.uncertainOperations.length) {
    // Preserve all recovery inputs until an operator establishes exact daemon
    // completion/cancellation; this checker deliberately makes no such claim.
    receipt.cliScratchRemoved=false;receipt.recoveryCliScratch=controlScratch;receipt.passed=false;process.exitCode=1;
  } else {if(controlScratch) {
    const resolved=fs.realpathSync(controlScratch);
    assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('hatoove-hosting-cli-'+stamp+'-'));
    assert.equal(fs.lstatSync(controlScratch).isSymbolicLink(),false);fs.rmSync(resolved,{recursive:true,force:true});
    assert.equal(fs.existsSync(resolved),false);
  } receipt.cliScratchRemoved=true;}
  } catch {receipt.cliScratchRemoved=false;receipt.passed=false;process.exitCode=1;}
  // Artifact I/O happens only after attempted teardown and cannot bypass resource cleanup.
  receipt.finishedAt=new Date().toISOString();
  try {fs.mkdirSync(evidenceDir,{recursive:true});writeJson(path.join(evidenceDir,'receipt.json'),receipt);}
  catch {console.error('hosting_runtime_evidence_failed');process.exitCode=1;}
}
console.log((receipt.passed?'PASS':'FAIL')+' hosting-runtime; metadata evidence '+evidenceDir);
process.exitCode=receipt.passed&&receipt.variants.every(result=>result.cleaned)?process.exitCode??0:1;
