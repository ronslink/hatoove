#!/usr/bin/env node
/** Synthetic payment acceptance in a disposable source-only Compose build. Never uses provider keys. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPayments } from './payment-browser.mjs';
import { buildSignatureHeader } from '../server/payments/signature.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = `hatoove-payments-browser-${Date.now()}-${process.pid}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${project}-`));
const source = path.join(scratch, 'source');
const envFile = path.join(scratch, 'compose.env');
const shotsIndex = process.argv.indexOf('--shots');
const shots = shotsIndex < 0 ? path.join(root, '.qa', 'payments', project) : path.resolve(process.argv[shotsIndex + 1]);
const webhookSecret = 'whsec_synthetic_browser_fixture_only';
let paymentMode = 'stub';
const results = [];
let started = false, cleaned = false, appPort, dbPort, base;

function command(binary, args, cwd = root, env = process.env) {
  const r = spawnSync(binary, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${binary} ${args[0]}: ${(r.error?.message || r.stderr || r.stdout || '').slice(-2500)}`);
  return (r.stdout || '').trim();
}
const compose = args => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(STRIPE_|PAYMENTS_|OWNAPI_|HATOVE_PAYMENTS_)/i.test(key)));
  return command('docker', ['compose', '--env-file', envFile, '-p', project, '-f', path.join(source, 'compose.yaml'), ...args], source,
    { ...env, HATOVE_APP_PORT: String(appPort), HATOVE_DB_PORT: String(dbPort), HATOVE_PUBLIC_ORIGIN: base,
      HATOVE_CONTENT_MODE: 'internal-preview', HATOVE_PAYMENTS_MODE: paymentMode,
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: webhookSecret });
};
const query = sql => compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'hatoove', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); }
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function sourceFixture() {
  // Git's curated source inventory excludes ignored .env, QA data, handoffs, design originals and node_modules.
  const listed = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const name of listed) {
    if (/^(\.git|\.qa|handoff|design)(\/|$)/i.test(name)
      || /(^|\/)(\.env(?:\..*)?|node_modules)(\/|$)/i.test(name)) continue;
    const from = path.resolve(root, name), to = path.resolve(source, name);
    if (!from.startsWith(root + path.sep) || !to.startsWith(source + path.sep)) throw new Error('Unsafe source path');
    if (!fs.existsSync(from)) continue; // staged deletion
    if (!fs.lstatSync(from).isFile()) throw new Error(`Non-file source entry: ${name}`);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  }
  const design = JSON.parse(fs.readFileSync(path.join(source, 'work/implementation/DESIGN-REFERENCE-MANIFEST.json'), 'utf8'));
  for (const entry of design.files.filter(entry => entry.path.startsWith('assets/'))) {
    if (!fs.existsSync(path.join(source, 'public/assets/design', entry.path.slice('assets/'.length)))) throw new Error('Curated design asset missing from source fixture: ' + entry.path);
  }
}
async function nav(cdp, url) { await cdp.send('Page.navigate', { url }); await cdp.waitFor("document.readyState === 'complete'", 25000, url); }
async function viewport(cdp, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await cdp.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
}
const theme = (cdp, value) => cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value }] });
async function shot(cdp, name, selector = null) {
  fs.mkdirSync(shots, { recursive: true });
  if (selector) {
    await cdp.evaluate(`const el=document.querySelector(${JSON.stringify(selector)});if(!el||!el.getBoundingClientRect().height)throw Error('Missing/hidden screenshot target');el.scrollIntoView({block:'start'});scrollBy(0,-88);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));`);
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(shots, `${name}.png`); fs.writeFileSync(file, Buffer.from(data, 'base64')); return file;
}
const setInputs = (cdp, values) => cdp.evaluate(`for (const [id,value] of Object.entries(${JSON.stringify(values)})) {
  const el=document.getElementById(id); if(!el) return 'missing:'+id; el.value=value;
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } return true;`);
const clickSel = (cdp, selector) => cdp.evaluate(`const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; el.click(); return true;`);
const overflow = cdp => cdp.evaluate(`const width=innerWidth,offenders=[];
  const clipped=el=>{for(let p=el.parentElement;p&&p!==document.documentElement;p=p.parentElement)if(['auto','scroll','hidden'].includes(getComputedStyle(p).overflowX))return true;return false;};
  for(const el of document.querySelectorAll('body *')){const r=el.getBoundingClientRect();if(r.width&&r.height&&r.right>width+2&&!clipped(el))offenders.push(el.tagName+'.'+el.className);}
  return {scrollWidth:document.documentElement.scrollWidth,innerWidth:width,offenders:offenders.slice(0,6),offenderCount:offenders.length};`);
async function signup(email, password) {
  const response = await fetch(base + '/api/auth/sign-up/email', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, name: 'Payment Browser Evidence' }) });
  if (response.status !== 200) throw new Error(`Synthetic signup failed: ${response.status} ${await response.text()}`);
}

try {
  appPort = await freePort(); dbPort = await freePort();
  while (dbPort === appPort) dbPort = await freePort();
  if ([4300, 55440].includes(appPort) || [4300, 55440].includes(dbPort)) throw new Error('Reserved learner port');
  base = `http://127.0.0.1:${appPort}`;
  fs.writeFileSync(envFile, `HATOVE_APP_PORT=${appPort}\nHATOVE_DB_PORT=${dbPort}\nHATOVE_PUBLIC_ORIGIN=${base}\nHATOVE_CONTENT_MODE=internal-preview\n`);
  sourceFixture();
  console.log(`Synthetic payment source fixture: ${project}, ${base}, database127.0.0.1:${dbPort}`);
  started = true; compose(['up', '--build', '-d']);
  // Payment evidence needs no writing worker; stop only this fixture's worker for deterministic drafts.
  compose(['stop', 'worker']);
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/api/ready', { signal: AbortSignal.timeout(3000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Disposable payment stack not ready');
  const password = 'synthetic-browser-pass-1', email = `browser-${Date.now()}@example.test`;
  await signup(email, password);
  await verifyPayments({ base, email, password, freePort, record, shot, viewport, theme, nav, setInputs, clickSel, overflow, query,
    webhook: async (event, valid = true) => {
      const rawBody = JSON.stringify(event);
      const signature = buildSignatureHeader({ rawBody, secret: webhookSecret, timestamp: Math.floor(Date.now() / 1000) });
      const response = await fetch(base + '/api/v1/payments/stripe/webhook', { method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': valid ? signature : 'invalid' }, body: rawBody });
      return { status: response.status, body: await response.json() };
    },
    changeMode: async mode => {
      if (!['off', 'stub'].includes(mode)) throw Error('Only isolated off/stub modes allowed');
      paymentMode = mode; compose(['up', '-d', '--no-deps', '--force-recreate', 'app']);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        try { if ((await fetch(base + '/api/ready', { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Error('Payment fixture did not restart');
    } });
} catch (error) {
  record('Payment isolated browser execution completes', false, error.stack || error.message);
} finally {
  if (started) {
    try { compose(['down', '-v', '--remove-orphans']); cleaned = true; console.log(`Removed disposable project ${project}`); }
    catch (error) { record('Payment fixture cleanup', false, error.message); }
  }
  // Verify the resolved recursive target is this uniquely created task directory before removing it.
  const resolved = fs.realpathSync(scratch);
  if ((!started || cleaned) && path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith(project + '-')) fs.rmSync(resolved, { recursive: true, force: true });
  else console.log(`Preserved source/Compose recovery files at ${scratch}`);
  const failures = results.filter(result => !result.ok);
  fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length - failures.length} passed, ${failures.length} failed; screenshots ${shots}`);
  console.log('Headless Chromium evidence; physical iPhone/Android and human content approval remain pending.');
  process.exitCode = failures.length ? 1 : 0;
}
