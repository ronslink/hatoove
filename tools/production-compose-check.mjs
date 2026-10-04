#!/usr/bin/env node
/** Structural checks only. --compose invokes version/config with isolated synthetic inputs.
 * Never build, pull, start, inspect a daemon, read operator credentials or contact a database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['compose.production.yaml', 'compose.production.local-db.yaml', 'compose.production.managed-db.yaml',
  'deploy/Caddyfile', 'deploy/production.env.example', 'docs/PRODUCTION_DEPLOYMENT.md'];
const roles = ['admin', 'migration', 'auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner'];
const runtimeRoles = ['auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner'];
const fixed = {
  OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_CONNECT_TIMEOUT_MS: '5000',
  OWNAPI_PG_POOL_AUTH_MAX: '2', OWNAPI_PG_POOL_LEARNER_MAX: '2', OWNAPI_PG_POOL_WORKER_MAX: '1',
  OWNAPI_PG_POOL_DELETION_MAX: '1', OWNAPI_PG_POOL_PAYMENTS_MAX: '1', OWNAPI_PG_POOL_PROVISIONER_MAX: '1',
  OWNAPI_PG_POOL_ADMIN_MAX: '1', OWNAPI_PG_POOL_MIGRATION_MAX: '1', OWNAPI_PG_WORKER_RUNNER_POOL_MAX: '1',
  OWNAPI_PG_APP_REPLICAS: '1', OWNAPI_PG_WORKER_REPLICAS: '1', B1PREP_CONTENT_MODE: 'public',
};
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const requireThat = (condition, code) => { if (!condition) fail(code); };
const equalSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const keys = value => Object.keys(value ?? {});
const passwordKey = role => role === 'admin' ? 'OWNAPI_PG_PASSWORD_FILE' : `OWNAPI_PG_${role.toUpperCase()}_PASSWORD_FILE`;
const sources = service => (service.secrets ?? []).map(item => typeof item === 'string' ? item : item.source);
const networkKeys = service => Array.isArray(service.networks) ? service.networks : keys(service.networks);
const withoutComments = text => text.replace(/#[^\r\n]*/g, '');

export function assertCaddy(text) {
  const source = withoutComments(text);
  requireThat(/^\s*admin off\s*$/m.test(source), 'caddy_admin_exposed');
  requireThat(/^hatoove\.com\s*\{/m.test(source), 'caddy_canonical_host_missing');
  requireThat(/^http:\/\/, https:\/\/\s*\{\s*respond 421\s*\}/m.test(source), 'caddy_unknown_host_refusal_missing');
  requireThat(/^http:\/\/hatoove\.com\s*\{\s*redir https:\/\/hatoove\.com\{uri\} 308\s*\}/m.test(source), 'caddy_canonical_redirect_missing');
  requireThat(/header\s*\{\s*defer\s+X-Content-Type-Options nosniff/.test(source), 'caddy_header_deferral_missing');
  requireThat(/^\s*issuer acme\s*\{/m.test(source) && /^\s*disable_tlsalpn_challenge\s*$/m.test(source), 'caddy_http01_missing');
  requireThat((source.match(/\breverse_proxy\b/g) ?? []).length === 1 && /reverse_proxy app:4321\s*\{/.test(source), 'caddy_upstream_changed');
  requireThat(/^\s*lb_retries 0\s*$/m.test(source), 'caddy_retry_enabled');
  requireThat(/^\s*compression off\s*$/m.test(source), 'caddy_compression_enabled');
  requireThat(!/\b(file_server|root|rewrite|uri|encode|request_body|trusted_proxies|handle_errors|on_demand|insecure_skip_verify|tls_insecure_skip_verify|auto_https|log)\b/.test(source.replaceAll('{uri}', '')), 'caddy_unsafe_directive');
  requireThat(!/header_(?:up|down)\s+[+\-]?(?:Host|Origin|Referer|Cookie|X-Hatoove-Account|Stripe-Signature|Range|Content-Range|Content-Length|Cache-Control|Set-Cookie)\b/i.test(source), 'caddy_protected_header_changed');
  for (const name of ['Forwarded', 'X-Real-IP', 'CF-Connecting-IP', 'True-Client-IP'])
    requireThat(source.includes(`header_up -${name}`), 'caddy_untrusted_header_forwarded');
}

/** Validate actual docker compose config JSON, not a second YAML implementation. */
export function assertProductionModel(model, variant) {
  requireThat(['local', 'managed'].includes(variant), 'invalid_variant');
  const services = model.services ?? {};
  requireThat(equalSet(keys(services), ['migrate', 'app', 'worker', 'ingress', ...(variant === 'local' ? ['db'] : [])]), 'unexpected_service');
  requireThat(equalSet(keys(model.secrets), roles.map(role => `pg_${role}`)), 'secret_inventory_changed');
  for (const role of roles) {
    const secret = model.secrets[`pg_${role}`];
    requireThat(typeof secret.file === 'string' && path.isAbsolute(secret.file) && !secret.environment && !secret.external, 'invalid_secret_source');
  }
  requireThat(new Set(Object.values(model.secrets).map(secret => secret.file)).size === roles.length, 'shared_password_file');
  for (const [name, service] of Object.entries(services)) {
    requireThat(typeof service.image === 'string' && /@sha256:[a-f0-9]{64}$/.test(service.image), 'image_not_pinned');
    requireThat(service.pull_policy === 'never', 'implicit_image_pull');
    requireThat(!service.build && !service.privileged && !service.network_mode && !service.env_file && !service.entrypoint, 'unsafe_service_override');
    if (name !== 'ingress') requireThat(!(service.ports ?? []).length, 'private_port_published');
    const environment = service.environment ?? {};
    requireThat(!keys(environment).some(key => /(?:^PGPASSWORD$|^PGSSLMODE$|^NODE_OPTIONS$|^NODE_TLS_|STRIPE|DEEPSEEK|OPENAI|SERVE_REVIEW|SERVE_RIGHTS|_PASSWORD$)/.test(key)), 'secret_or_policy_environment_leak');
    for (const mount of service.volumes ?? []) requireThat(!String(mount.source).includes('docker.sock'), 'docker_socket_mounted');
  }
  requireThat(services.app.image === services.worker.image && services.app.image === services.migrate.image, 'runtime_image_drift');
  const identityKeys = ['OWNAPI_PG_HOST','OWNAPI_PG_PORT','OWNAPI_PG_DATABASE','OWNAPI_PG_USER','OWNAPI_PG_SCHEMA','OWNAPI_PG_ROLE_PREFIX','OWNAPI_PG_CONNECTION_BUDGET'];
  for (const name of ['migrate', 'app', 'worker']) {
    const service = services[name], env = service.environment;
    for (const key of identityKeys) requireThat(env[key] === services.migrate.environment[key], 'database_identity_drift');
    for (const [key, value] of Object.entries(fixed)) requireThat(env[key] === value, 'allocation_or_policy_changed');
    requireThat(/^\d+$/.test(env.OWNAPI_PG_CONNECTION_BUDGET ?? '') && Number(env.OWNAPI_PG_CONNECTION_BUDGET) >= 12 && Number(env.OWNAPI_PG_CONNECTION_BUDGET) <= 1000, 'invalid_connection_budget');
    requireThat(env.OWNAPI_PG_DATABASE && env.OWNAPI_PG_USER && env.OWNAPI_PG_SCHEMA && env.OWNAPI_PG_ROLE_PREFIX, 'missing_database_identity');
    requireThat(service.read_only === true && service.init === true && equalSet(service.cap_drop ?? [], ['ALL']) && (service.security_opt ?? []).includes('no-new-privileges:true'), 'runtime_isolation_changed');
    const expectedRoles = name === 'migrate' ? roles : name === 'app' ? runtimeRoles : ['worker'];
    requireThat(equalSet(sources(service), expectedRoles.map(role => `pg_${role}`)), 'credential_mount_scope_changed');
    requireThat(equalSet(keys(env).filter(key => /PASSWORD_FILE$/.test(key)), expectedRoles.map(passwordKey)), 'credential_environment_scope_changed');
    for (const role of expectedRoles) requireThat(env[passwordKey(role)] === `/run/secrets/pg_${role}`, 'credential_target_changed');
    for (const secret of service.secrets ?? []) requireThat(!secret.target || secret.target === secret.source || secret.target === `/run/secrets/${secret.source}`, 'secret_mount_target_changed');
    requireThat(JSON.stringify(service.command) === JSON.stringify(['node', name === 'app' ? 'server.js' : name === 'worker' ? 'server/worker.mjs' : 'server/migrate.mjs']), 'runtime_command_changed');
    requireThat(equalSet(networkKeys(service), name === 'app' ? ['application', 'backend'] : ['backend']), 'runtime_network_changed');
    if (name !== 'migrate') requireThat(service.depends_on?.migrate?.condition === 'service_completed_successfully', 'migration_gate_missing');
    if (variant === 'local') {
      requireThat(env.OWNAPI_PG_HOST === 'db' && env.OWNAPI_PG_PORT === '5432' && env.OWNAPI_PG_TLS_MODE === 'disable' && env.OWNAPI_PG_TLS_CA_FILE == null, 'local_connection_changed');
      requireThat(!(service.volumes ?? []).length, 'unexpected_runtime_mount');
    } else {
      requireThat(env.OWNAPI_PG_TLS_MODE === 'verify-full' && typeof env.OWNAPI_PG_HOST === 'string' && env.OWNAPI_PG_HOST.includes('.') && env.OWNAPI_PG_HOST !== 'db', 'managed_tls_changed');
      requireThat(/^[0-9]+$/.test(env.OWNAPI_PG_PORT) && Number(env.OWNAPI_PG_PORT) >= 1 && Number(env.OWNAPI_PG_PORT) <= 65535, 'managed_port_invalid');
      requireThat(!service.depends_on?.db, 'managed_local_dependency');
      const mounts = service.volumes ?? [];
      requireThat(mounts.length === 1 && mounts[0].type === 'bind' && mounts[0].target === '/run/hatoove/pg-trust' && mounts[0].read_only === true && mounts[0].bind?.create_host_path === false, 'managed_ca_mount_changed');
      requireThat(env.OWNAPI_PG_TLS_CA_FILE == null || /^\/run\/hatoove\/pg-trust\/[a-zA-Z0-9_-]+\.pem$/.test(env.OWNAPI_PG_TLS_CA_FILE), 'managed_ca_path_changed');
    }
  }
  const app = services.app, ingress = services.ingress;
  for (const [key, value] of Object.entries({B1PREP_SAAS:'1', B1PREP_ACCOUNTS:'1', B1PREP_REQUIRE_HTTPS:'1', B1PREP_PUBLIC_ORIGIN:'https://hatoove.com', B1PREP_BIND:'0.0.0.0', B1PREP_PORT:'4321', PAYMENTS_MODE:'off'}))
    requireThat(app.environment[key] === value, 'public_https_boundary_changed');
  requireThat(JSON.stringify(app.healthcheck?.test).includes('http://127.0.0.1:4321/api/ready'), 'readiness_probe_missing');
  requireThat(services.migrate.restart === 'no' && services.migrate.environment.OWNAPI_PG_ALLOW === '1', 'migration_lifecycle_changed');
  requireThat(!keys(ingress.depends_on).length, 'certificate_bootstrap_depends_on_app');
  requireThat(equalSet(networkKeys(ingress), ['edge', 'application']) && model.networks?.application?.internal === true, 'ingress_network_changed');
  const ports = ingress.ports ?? [];
  requireThat(ports.length === 2 && [80,443].every(port => ports.some(item => Number(item.target) === port && Number(item.published) === port && (item.protocol ?? 'tcp') === 'tcp')), 'ingress_ports_changed');
  requireThat(!sources(ingress).length, 'ingress_database_secret');
  const config = (ingress.volumes ?? []).find(mount => mount.target === '/etc/caddy/Caddyfile');
  requireThat(ingress.volumes?.length === 3 && config?.type === 'bind' && config.read_only === true && config.bind?.create_host_path === false && config.source.replaceAll('\\','/').endsWith('/deploy/Caddyfile'), 'caddy_config_mount_changed');
  for (const [volume, target] of [['caddy-data','/data'],['caddy-config','/config']]) {
    requireThat(model.volumes?.[volume]?.external === true && (ingress.volumes ?? []).some(mount => mount.source === volume && mount.target === target && mount.type === 'volume'), 'certificate_state_not_retained');
  }
  const expectedVolumes = ['caddy-data','caddy-config', ...(variant === 'local' ? ['pg-data'] : [])];
  requireThat(equalSet(keys(model.volumes), expectedVolumes) && expectedVolumes.every(name => typeof model.volumes[name].name === 'string' && model.volumes[name].name.length > 0) && new Set(expectedVolumes.map(name => model.volumes[name].name)).size === expectedVolumes.length, 'retained_volume_identity_changed');
  if (variant === 'local') {
    const db = services.db;
    requireThat(db.environment.POSTGRES_DB === services.migrate.environment.OWNAPI_PG_DATABASE && db.environment.POSTGRES_USER === services.migrate.environment.OWNAPI_PG_USER, 'database_bootstrap_identity_drift');
    requireThat(db.environment.POSTGRES_HOST_AUTH_METHOD === 'scram-sha-256' && db.environment.POSTGRES_INITDB_ARGS === '--auth-host=scram-sha-256 --auth-local=scram-sha-256', 'database_auth_weakened');
    requireThat(equalSet(sources(db), ['pg_admin']) && db.environment.POSTGRES_PASSWORD_FILE === '/run/secrets/pg_admin', 'database_secret_changed');
    requireThat(equalSet(networkKeys(db), ['backend']) && services.migrate.depends_on?.db?.condition === 'service_healthy', 'database_health_gate_missing');
    requireThat(model.volumes?.['pg-data']?.external === true && db.volumes?.length === 1 && db.volumes[0].source === 'pg-data' && db.volumes[0].target === '/var/lib/postgresql/data', 'database_volume_not_retained');
  }
}

export function isolatedEnvironment(base, scratch) {
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','ComSpec','PATHEXT','TEMP','TMP',
    'ProgramData','PROGRAMDATA','ProgramFiles','ProgramW6432','ALLUSERSPROFILE','SystemDrive']) if (base[key]) env[key] = base[key];
  return {...env, HOME:scratch, USERPROFILE:scratch, DOCKER_CONFIG:path.join(scratch,'docker'), COMPOSE_DISABLE_ENV_FILE:'1', DOCKER_CLI_HINTS:'false'};
}

function rejected(work, code) {
  let failed = false;
  try { work(); } catch (error) { requireThat(typeof error.code === 'string', 'unclassified_check_failure'); failed = true; }
  requireThat(failed, code);
}

function sourceChecks() {
  for (const file of files) requireThat(fs.statSync(path.join(root,file)).isFile(), 'source_file_missing');
  const caddy = fs.readFileSync(path.join(root,'deploy/Caddyfile'),'utf8'); assertCaddy(caddy);
  for (const newline of ['\n', '\r\n']) assertCaddy(caddy.replace(/\r?\n/g, newline));
  for (const source of [caddy.replace('lb_retries 0','lb_retries 1'), caddy.replace('disable_tlsalpn_challenge',''), `${caddy}\nfile_server`, `${caddy}\ntrusted_proxies private_ranges`, `${caddy}\nheader_up Cookie removed`, caddy.replace('respond 421','respond 200'), caddy.replace('http://, https://','https://'), caddy.replace('redir https://hatoove.com{uri} 308',''), caddy.replace('redir https://hatoove.com{uri} 308','redir https://foreign.invalid{uri} 308'), `${caddy}\nuri strip_prefix /api`, caddy.replace(/^\s*defer\s*$/m,'')])
    rejected(() => assertCaddy(source), 'caddy_mutation_escaped');
  const isolated = isolatedEnvironment({PATH:'synthetic-path', PGPASSWORD:'private-sentinel', STRIPE_SECRET_KEY:'private-sentinel', COMPOSE_FILE:'wrong', DOCKER_HOST:'wrong', OWNAPI_PG_TLS_CA_FILE:'wrong'}, os.tmpdir());
  requireThat(!keys(isolated).some(key => /PGPASSWORD|STRIPE|COMPOSE_FILE|DOCKER_HOST|TLS_CA_FILE/.test(key)), 'ambient_environment_leaked');
  const doc = fs.readFileSync(path.join(root,'docs/PRODUCTION_DEPLOYMENT.md'),'utf8');
  for (const phrase of ['deployment blocker', 'stop → fresh migrate → success-only start', '--force-recreate', '--exit-code-from migrate', 'app and worker remain stopped', 'Always Use HTTPS off', 'Full (Strict)', 'do not assume it', 'no throughput or SLA claim'])
    requireThat(doc.includes(phrase), 'operational_boundary_missing');
  const template = fs.readFileSync(path.join(root,'deploy/production.env.example'),'utf8');
  requireThat(!template.split('\n').some(line => /^[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY)=/.test(line)), 'template_secret_value');
  return {sourceGroups:4, sourceMutations:11};
}

function runComposeChecks() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'hatoove-production-config-'));
  const tempRoot = fs.realpathSync(os.tmpdir());
  let summary;
  try {
    for (const file of files) {
      const dest = path.join(scratch,file); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(root,file),dest);
    }
    fs.mkdirSync(path.join(scratch,'docker')); fs.mkdirSync(path.join(scratch,'trust'));
    // Windows Desktop may register its system plugin directory in the user's config.
    // Reconstruct only that public installation path; never read/copy the user's config.
    const systemPlugins = process.platform === 'win32' && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles,'Docker','cli-plugins') : null;
    fs.writeFileSync(path.join(scratch,'docker','config.json'), JSON.stringify(
      systemPlugins && fs.existsSync(systemPlugins) ? {cliPluginsExtraDirs:[systemPlugins]} : {}));
    const env = isolatedEnvironment(process.env,scratch);
    const execute = args => {
      requireThat(args[0] === 'compose' && (args[1] === 'version' || args.includes('config')), 'unsafe_docker_command');
      return spawnSync('docker',args,{cwd:scratch,env,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true});
    };
    const version = execute(['compose','version','--short']);
    const versionText = version.stdout?.trim() ?? '', versionMatch = /^v?(\d+)\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.exec(versionText);
    requireThat(!version.error && version.status === 0 && versionMatch && Number(versionMatch[1]) >= 2, 'compose_version_unavailable');
    const values = {
      HATOVE_APP_IMAGE:`synthetic.invalid/hatoove@sha256:${'a'.repeat(64)}`, HATOVE_CADDY_IMAGE:`caddy@sha256:${'b'.repeat(64)}`,
      HATOVE_POSTGRES_IMAGE:`postgres@sha256:${'c'.repeat(64)}`, OWNAPI_PG_DATABASE:'hatoove_synthetic_config', HATOVE_PG_ADMIN_USER:'synthetic_admin',
      OWNAPI_PG_SCHEMA:'hatoove_fixture', OWNAPI_PG_ROLE_PREFIX:'hatoove_fixture', OWNAPI_PG_CONNECTION_BUDGET:'12',
      HATOVE_CADDY_DATA_VOLUME:'hatoove-config-only-caddy-data', HATOVE_CADDY_CONFIG_VOLUME:'hatoove-config-only-caddy-config', HATOVE_PG_DATA_VOLUME:'hatoove-config-only-pg-data',
      HATOVE_MANAGED_PG_HOST:'synthetic-db.invalid', HATOVE_MANAGED_PG_PORT:'25060', HATOVE_PG_TRUST_DIR:path.join(scratch,'trust'),
    };
    const sentinels = [];
    for (const role of roles) {
      const file = path.join(scratch,`synthetic-${role}.txt`), value = `SYNTHETIC_PRIVATE_${role}_DO_NOT_RENDER`;
      fs.writeFileSync(file,value); sentinels.push(value); values[`HATOVE_PG_${role.toUpperCase()}_PASSWORD_SOURCE`] = file;
    }
    fs.writeFileSync(path.join(scratch,'.env'),'OWNAPI_PG_DATABASE=UNEXPECTED_AMBIENT_DATABASE\nSTRIPE_SECRET_KEY=UNEXPECTED_AMBIENT_PROVIDER\n');
    const render = (variants, additions = {}, removals = [], expectFailure = false) => {
      const selected = {...values,...additions}; for (const key of removals) delete selected[key];
      const envFile = path.join(scratch,'synthetic-input.env');
      fs.writeFileSync(envFile,Object.entries(selected).map(([key,value])=>`${key}=${String(value).replaceAll('\\','/')}`).join('\n'));
      const args = ['compose','--project-name','hatoove-production-config-only','--project-directory',scratch,'--env-file',envFile,'-f',path.join(scratch,'compose.production.yaml')];
      for (const variant of variants) args.push('-f',path.join(scratch,`compose.production.${variant}-db.yaml`));
      args.push('config','--format','json'); const result = execute(args);
      requireThat(!sentinels.some(value => result.stdout?.includes(value) || result.stderr?.includes(value)), 'secret_bytes_rendered');
      if (expectFailure) { requireThat(result.status !== 0, 'missing_required_input_accepted'); return null; }
      requireThat(!result.error && result.status === 0, 'compose_render_failed');
      let model; try { model = JSON.parse(result.stdout); } catch { fail('compose_json_invalid'); }
      requireThat(!result.stdout.includes('UNEXPECTED_AMBIENT_'), 'repository_environment_loaded');
      return model;
    };
    const local = render(['local']); assertProductionModel(local,'local');
    const managed = render(['managed']); assertProductionModel(managed,'managed');
    requireThat(managed.services.app.environment.OWNAPI_PG_TLS_CA_FILE == null, 'optional_ca_not_absent');
    const managedCA = render(['managed'],{OWNAPI_PG_TLS_CA_FILE:'/run/hatoove/pg-trust/provider-ca.pem'});
    assertProductionModel(managedCA,'managed');
    requireThat(managedCA.services.app.environment.OWNAPI_PG_TLS_CA_FILE === '/run/hatoove/pg-trust/provider-ca.pem', 'optional_ca_not_propagated');
    rejected(() => assertProductionModel(render([]),'local'), 'base_without_variant_accepted');
    rejected(() => assertProductionModel(render(['local','managed']),'managed'), 'both_variants_accepted');
    render(['local'],{},['OWNAPI_PG_CONNECTION_BUDGET'],true);
    render(['local'],{},['HATOVE_PG_AUTH_PASSWORD_SOURCE'],true);
    render(['managed'],{},['HATOVE_MANAGED_PG_HOST'],true);
    const mutations = [
      ['local',m=>{m.services.app.ports=[{target:4321,published:'4321'}];}],
      ['local',m=>{m.services.app.secrets.push({source:'pg_admin'});}],
      ['local',m=>{m.services.worker.environment.OWNAPI_PG_PASSWORD_FILE='/run/secrets/pg_admin';}],
      ['local',m=>{m.services.migrate.secrets.pop();}],
      ['local',m=>{delete m.services.app.depends_on.migrate;}],
      ['local',m=>{m.services.worker.depends_on.migrate.condition='service_started';}],
      ['local',m=>{m.services.app.environment.B1PREP_CONTENT_MODE='internal-preview';}],
      ['local',m=>{m.services.app.environment.B1PREP_PUBLIC_ORIGIN='http://hatoove.com';}],
      ['local',m=>{m.services.app.environment.B1PREP_REQUIRE_HTTPS='0';}],
      ['local',m=>{m.services.app.environment.PAYMENTS_MODE='stripe-test';}],
      ['local',m=>{m.services.worker.environment.PGPASSWORD='synthetic';}],
      ['local',m=>{m.services.app.environment.OWNAPI_PG_CONNECTION_BUDGET='11';}],
      ['local',m=>{m.services.app.environment.OWNAPI_PG_POOL_AUTH_MAX='3';}],
      ['local',m=>{m.services.worker.environment.OWNAPI_PG_WORKER_REPLICAS='2';}],
      ['local',m=>{m.services.ingress.volumes[0].read_only=false;}],
      ['local',m=>{m.services.ingress.depends_on={app:{condition:'service_healthy'}};}],
      ['local',m=>{m.services.db.environment.POSTGRES_HOST_AUTH_METHOD='trust';}],
      ['local',m=>{m.services.db.ports=[{target:5432,published:'5432'}];}],
      ['local',m=>{m.volumes['pg-data'].external=false;}],
      ['local',m=>{m.services.ingress.image='caddy:latest';}],
      ['local',m=>{m.services.ingress.volumes.push({source:'/var/run/docker.sock',target:'/var/run/docker.sock'});}],
      ['local',m=>{m.secrets.pg_worker.file=m.secrets.pg_admin.file;}],
      ['local',m=>{m.services.worker.command.reverse();}],
      ['local',m=>{m.services.worker.environment.OWNAPI_PG_SCHEMA='wrong_schema';}],
      ['local',m=>{m.services.db.environment.POSTGRES_DB='wrong_database';}],
      ['local',m=>{m.volumes['caddy-config'].name=m.volumes['caddy-data'].name;}],
      ['managed',m=>{m.services.app.environment.OWNAPI_PG_TLS_MODE='disable';}],
      ['managed',m=>{m.services.migrate.depends_on={db:{condition:'service_healthy'}};}],
      ['managed',m=>{m.services.worker.volumes[0].read_only=false;}],
      ['managed',m=>{m.services.app.environment.NODE_TLS_REJECT_UNAUTHORIZED='0';}],
    ];
    for (const [variant, mutate] of mutations) {
      const candidate = structuredClone(variant === 'local' ? local : managed); mutate(candidate);
      rejected(() => assertProductionModel(candidate,variant), 'unsafe_model_mutation_escaped');
    }
    summary = {composeVersion:versionText, renderedVariants:3, modelMutations:mutations.length, configurationNegatives:5};
  } finally {
    requireThat(fs.realpathSync(path.dirname(scratch)) === tempRoot && path.basename(scratch).startsWith('hatoove-production-config-') && !fs.lstatSync(scratch).isSymbolicLink(), 'scratch_cleanup_refused');
    fs.rmSync(scratch,{recursive:true,force:true});
    requireThat(!fs.existsSync(scratch), 'scratch_cleanup_failed');
  }
  return {...summary, scratchRemoved:true};
}

export function main(args = process.argv.slice(2)) {
  requireThat(args.length === 0 || args.length === 1 && args[0] === '--compose', 'invalid_arguments');
  const source = sourceChecks();
  const result = args.length ? {...source,...runComposeChecks()} : {...source, composeExecution:'not_run'};
  console.log(`production-compose PASS ${JSON.stringify(result)}`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`production-compose FAIL ${/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'check_failed'}`); process.exitCode = 1; }
}
