/** Q-01: local, version-pinned axe scans in an explicitly isolated browser fixture. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CDP } from './cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '4.13.0';
const integrity = 'sha512-UzGt8zg7Ny8djbYMhxl2zuEevVa7r2gJjYY5Lwr1xM7+XU2nd6CkIWFTVcCIbAP63vSz71NaVyyuSk9lHKcy0A==';
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const required = Object.freeze({
  app: ['auth-signin', 'auth-register', 'auth-error', 'reset-request', 'reset-acknowledgement', 'reset-new-password', 'reset-invalid-token',
    'objective-pre-answer', 'objective-post-answer', 'writing-draft', 'writing-rubric', 'writing-pending', 'writing-failed', 'writing-assessed',
    'history-list', 'history-detail', 'recovery-conflict', 'recovery-offline', 'recovery-uncertain-save'],
  audio: ['audio-load-error', 'audio-retry', 'audio-loaded', 'audio-playing', 'audio-recovery', 'audio-exhausted'],
  payments: ['checkout-unavailable', 'checkout-offer', 'checkout-pending', 'checkout-error', 'checkout-activated'],
});
const representative = new Set(['auth-signin', 'objective-post-answer', 'writing-assessed', 'recovery-conflict', 'recovery-offline', 'audio-loaded', 'audio-recovery', 'checkout-offer', 'checkout-error']);

export function browserEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(B1PREP_|OWNAPI_|STRIPE_|PAYMENTS_|HATOVE_|HATOOVE_|COMPOSE_)/i.test(key)));
}

export function copyBrowserSource(sourceRoot, destination) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  for (const name of files) {
    if (/^(\.git|\.qa|handoff|design)(\/|$)/i.test(name) || /(^|\/)(\.env(?:\..*)?|node_modules)(\/|$)/i.test(name)) continue;
    const from = path.resolve(sourceRoot, name), to = path.resolve(destination, name);
    if (!from.startsWith(sourceRoot + path.sep) || !to.startsWith(destination + path.sep)) throw Error('Unsafe source copy');
    if (!fs.existsSync(from)) continue;
    if (!fs.lstatSync(from).isFile()) throw Error('Non-file source entry');
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  }
}

export function verifyBrowserProject({ project, dbPort, compose, command }) {
  if (!/^hatoove-(?:s5-|payments-)?browser-\d+-\d+$/.test(project) || [4300, 55440].includes(dbPort)) throw Error('Unsafe browser project');
  const id = compose(['ps', '-q', 'db']);
  if (!id || /\s/.test(id)) throw Error('One generated database required');
  const row = JSON.parse(command('docker', ['inspect', id]))[0], ports = row.NetworkSettings.Ports['5432/tcp'];
  if (row.Config.Labels['com.docker.compose.project'] !== project || row.Config.Labels['com.docker.compose.service'] !== 'db'
    || ports?.length !== 1 || ports[0].HostIp !== '127.0.0.1' || ports[0].HostPort !== String(dbPort)) throw Error('Generated database label/port mismatch');
  const schema = compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'hatoove', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT current_database() || ':' || nspname FROM pg_namespace WHERE nspname='hatoove'"]);
  if (schema !== 'hatoove:hatoove') throw Error('Generated database schema mismatch');
}

export function verifyBrowserCleanup(project, command, { before = false } = {}) {
  if (!/^hatoove-(?:s5-|payments-)?browser-\d+-\d+$/.test(project)) throw Error('Unsafe cleanup project');
  const ids = command('docker', ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project]).split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const row = JSON.parse(command('docker', ['volume', 'inspect', id]))[0];
    if (row.Labels?.['com.docker.compose.project'] !== project) throw Error('Unsafe cleanup volume');
  }
  if (!before && (ids.length || command('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]))) throw Error('Generated resources remain');
}

function assertClean(result) {
  if (!Array.isArray(result.violations) || !Array.isArray(result.incomplete) || !Array.isArray(result.passes) || result.testEngine?.version !== version) throw Error('Invalid axe engine result');
  if (result.passes.length === 0) throw Error('axe did not report any exercised passing rules');
  if (result.violations.length) throw Object.assign(Error(result.violations.map(v => v.id + ': ' + v.nodes.map(n => n.target.join(' ')).join(', ')).join('; ')), { code: 'Q01_A11Y' });
}
function assertCoverage(expected, seen) {
  const missing = expected.filter(id => !seen.has(id));
  if (missing.length) throw Error('Missing required accessibility states: ' + missing.join(', '));
}

export function createA11yAuditor({ suite, enabled = process.argv.includes('--axe'), directory, record, viewport, theme, shot, context = {} }) {
  if (!required[suite]) throw Error('Unknown accessibility suite');
  const scans = [], controls = [], seen = new Set(), startedAt = Date.now();
  let source, base, busy = false, controlsPassed = false;
  const output = path.join(directory, 'axe');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim());
  const write = (name, value) => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); };
  function load() {
    if (source) return;
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools/a11y/package-lock.json'), 'utf8'));
    const entry = lock.packages['node_modules/axe-core'];
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'tools/a11y/node_modules/axe-core/package.json'), 'utf8'));
    if (entry.version !== version || entry.integrity !== integrity || installed.version !== version) throw Error('axe dependency differs from frozen contract');
    source = fs.readFileSync(path.join(root, 'tools/a11y/node_modules/axe-core/axe.min.js'), 'utf8');
  }
  async function analyse(cdp) {
    load();
    if (await cdp.evaluate('return location.origin') !== base) throw Error('Accessibility scan escaped the disposable origin');
    await cdp.evaluate(`return (async()=>{
      await document.fonts.ready;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const finite=document.getAnimations().filter(a=>a.playState==='running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
      let timeout;
      try { await Promise.race([Promise.all(finite.map(a=>a.finished.catch(()=>{}))),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Page transitions did not settle')),4000)})]); }
      finally { clearTimeout(timeout); }
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return true;
    })()`);
    const injection = await cdp.send('Runtime.evaluate', { expression: source });
    if (injection.exceptionDetails) throw Error('axe injection failed');
    if (await cdp.evaluate('return window.axe?.version') !== version) throw Error('axe injection/version mismatch');
    return cdp.evaluate(`return axe.run(document,{runOnly:{type:'tag',values:${JSON.stringify(tags)}}})`);
  }
  async function discriminator(cdp) {
    const target = await cdp.send('Target.createTarget', { url: base + '/signin' });
    let control;
    try {
      const port = new URL(cdp.ws.url).port;
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = targets.find(row => row.id === target.targetId);
      if (!page) throw Error('Control tab missing');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
      control = new CDP(ws); await control.send('Page.enable'); await control.send('Runtime.enable');
      await control.waitFor("location.origin === " + JSON.stringify(base) + " && document.readyState==='complete'", 15000);
      const tree = await control.send('Page.getFrameTree');
      await control.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html: '<!doctype html><html lang="de"><head><title>Q01 synthetic control</title></head><body><main><h1>Technische Kontrollseite</h1><button type="button">Weiter</button></main></body></html>' });
      const baseline = await analyse(control); assertClean(baseline);
      controls.push({ kind: 'clean-baseline', passed: true, exercisedRules: baseline.passes.length });
      await control.evaluate("const button=document.createElement('button');button.id='q01-unnamed-button';button.type='button';button.style.cssText='width:100px;height:40px';document.querySelector('main').append(button);return true");
      const defect = await analyse(control);
      let rejected = false;
      try { assertClean(defect); } catch (error) { rejected = error.code === 'Q01_A11Y' && defect.violations.some(v => v.id === 'button-name' && v.nodes.some(n => n.target.includes('#q01-unnamed-button'))); }
      if (!rejected) throw Error('Unnamed-button discriminator did not reject its exact defect');
      controls.push({ kind: 'expected-violation', rule: 'button-name', target: '#q01-unnamed-button', rejected });
      write('control-expected-violation', { expected: true, violations: defect.violations });
      await control.evaluate("document.querySelector('#q01-unnamed-button').remove();return true");
      const restored = await analyse(control); assertClean(restored);
      controls.push({ kind: 'defect-removed', passed: true, exercisedRules: restored.passes.length });
      let omission = false;
      const omitted = required[suite][0];
      try { assertCoverage(required[suite], new Set(required[suite].slice(1))); } catch (error) { omission = error.message.includes(omitted); }
      if (!omission) throw Error('Missing-state discriminator did not fail');
      controls.push({ kind: 'required-state-omission', state: omitted, rejected: omission }); controlsPassed = true;
      record('AXE ' + suite + ' deliberate defect, removal and missing-state controls', true);
    } finally { control?.ws.close(); await cdp.send('Target.closeTarget', { targetId: target.targetId }); }
  }
  return {
    enabled,
    async start(cdp, origin) {
      if (!enabled || controlsPassed) return;
      const url = new URL(origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || ['4300', '55440'].includes(url.port)) throw Error('Disposable accessibility origin required');
      base = url.origin;
      try { load(); await discriminator(cdp); }
      catch (error) { write('engine-error', { sourceRevision: revision, sourceDirty, suite, error: error.message }); throw error; }
    },
    async scan(cdp, id, condition) {
      if (!enabled) return;
      if (!controlsPassed || busy || !required[suite].includes(id)) throw Error('Invalid accessibility scan sequence/state: ' + id);
      busy = true;
      const previous = await cdp.evaluate("return {width:innerWidth,height:innerHeight,mobile:matchMedia('(pointer:coarse)').matches,theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light',x:scrollX,y:scrollY}");
      try {
        const variants = [{ width: 1440, height: 900, theme: 'light' }, ...(representative.has(id) ? [{ width: 390, height: 844, theme: 'dark' }, { width: 320, height: 844, theme: 'light' }] : [])];
        for (const variant of variants) {
          const key = id + '-' + variant.width + '-' + variant.theme;
          const scanStarted = Date.now();
          const row = { sourceRevision: revision, sourceDirty, suite, state: id, engine: version, tags, ...variant, startedAt: new Date().toISOString() };
          try {
            row.urlPath = await cdp.evaluate('return location.pathname');
            await viewport(cdp, variant.width, variant.height, variant.width !== 1440); await theme(cdp, variant.theme);
            await cdp.waitFor(condition, 10000, 'required state ' + id);
            const result = await analyse(cdp);
            await cdp.waitFor(condition, 1000, 'state remained visible ' + id);
            row.urlPath = await cdp.evaluate('return location.pathname');
            row.passes = result.passes?.length || 0; row.violations = result.violations; row.incomplete = result.incomplete;
            assertClean(result); row.ok = true;
            record('AXE ' + key, true, row.incomplete.length + ' incomplete/manual');
          } catch (error) {
            row.ok = false; row.error = error.message;
            try { row.screenshot = path.basename(await shot(cdp, 'axe-' + key)); } catch {}
            record('AXE ' + key, false, error.message);
            throw Object.assign(Error('Accessibility ' + key + ': ' + error.message), { code: 'Q01_A11Y' });
          } finally { row.durationMs = Date.now() - scanStarted; scans.push(row); write(key, row); }
        }
        seen.add(id);
      } finally {
        busy = false;
        await viewport(cdp, previous.width, previous.height, previous.mobile); await theme(cdp, previous.theme);
        await cdp.evaluate(`scrollTo(${previous.x},${previous.y});return true`);
      }
    },
    finish() {
      if (!enabled) return;
      let error;
      try { if (!controlsPassed || scans.length === 0) throw Error('Accessibility engine controls or scans missing'); assertCoverage(required[suite], seen); } catch (failure) { error = failure.message; record('AXE ' + suite + ' required coverage', false, error); }
      write('summary', { sourceRevision: revision, sourceDirty, context, suite, engine: version, tags, durationMs: Date.now() - startedAt, required: required[suite], completed: [...seen], controls, scans, error: error || null, incompleteAreManual: true });
    },
  };
}
