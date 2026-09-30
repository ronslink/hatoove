/** Focused offline writing UI regression checks.
 * Usage: node tools/writing-browser-check.js [isolatedServerUrl]
 * Start that server with B1PREP_PROGRESS_FILE pointing at disposable test data.
 * Never run this against the learner's app: the rotation counter is reset.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, connectToPage, makeRecorder } from './cdp.js';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4325');
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)
    || !base.port || ['4321', '4381'].includes(base.port)) {
  throw new Error('Use an isolated local test server; live ports 4321 and 4381 are forbidden.');
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { record, summary } = makeRecorder();
let cdp;
let cleanup;

async function readTask() {
  return cdp.evaluate(`
    return import('/js/store.js').then((store) => {
      const card = [...document.querySelectorAll('#view .card')].find((el) => el.querySelector('ol'));
      return {
        situation: card.querySelector('p').textContent,
        register: card.querySelector('b').textContent,
        points: [...card.querySelectorAll('ol li')].map((el) => el.textContent),
        placeholder: document.querySelector('#writing-text').placeholder,
        index: store.getState().settings.writingTaskIndex,
      };
    });
  `);
}

async function openWriting() {
  await cdp.click('[data-view="writing"]');
  await cdp.waitFor(`!!document.querySelector('#writing-text')`, 12000, 'writing task');
  return readTask();
}

async function nextTask(index) {
  await cdp.click('[data-new-task]');
  await cdp.waitFor(`document.querySelector('#writing-text') && JSON.parse(localStorage.getItem('b1prep.state.v1')).settings.writingTaskIndex === ${index}`, 12000, 'next writing task');
  return readTask();
}

try {
  const configResponse = await fetch(new URL('/api/config', base));
  if (!configResponse.ok) throw new Error(`Test server returned HTTP ${configResponse.status}`);
  const config = await configResponse.json();
  if (config.configured) throw new Error('This browser check requires an offline server with no AI key configured.');

  ({ cleanup } = await launchBrowser(9228));
  cdp = await connectToPage(9228);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: base.href });
  await cdp.waitFor(`!!document.querySelector('#view .card')`, 15000, 'dashboard boot');
  const initial = await cdp.evaluate(`
    return import('/js/store.js').then(async (store) => {
      store.getState().settings.writingTaskIndex = 0;
      store.saveNow();
      await store.flushNow();
      return store.getState().settings.writingTaskIndex;
    });
  `);
  record('isolated browser starts at rotation slot zero', initial === 0);

  const first = await openWriting();
  record('first task is informal and has a personal greeting placeholder', first.register === 'informell · du' && first.placeholder.startsWith('Liebe/r') && first.index === 1);
  record('informal task renders four nonblank guiding points', first.points.length === 4 && first.points.every((point) => point.trim()));

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const screenshotPath = path.join(ROOT, '.qa', 'informal-writing.png');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log(`Screenshot: ${screenshotPath}`);

  await cdp.evaluate(`
    const input = document.querySelector('#writing-text');
    input.value = 'Liebe Anna, vielen Dank für deine Einladung. Ich freue mich sehr, weil ich dich lange nicht gesehen habe. Ich komme am Samstag mit dem Zug und kann um drei Uhr bei dir sein. Wenn du möchtest, bringe ich einen Kuchen mit. Außerdem möchte ich gern mit dir spazieren gehen, denn das Wetter soll schön werden. Kannst du mir bitte deine neue Adresse schicken? Ich freue mich auf unser Wochenende. Liebe Grüße, Alex';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-live-check]').click();
    return true;
  `);
  await cdp.waitFor(`!!document.querySelector('#w-result table')`, 5000, 'offline writing analysis');
  const registerCheck = await cdp.evaluate(`
    return [...document.querySelectorAll('#w-result tr')].map((el) => el.textContent).find((text) => /Register/.test(text)) || '';
  `);
  record('offline checker accepts the informal register', registerCheck.includes('✓') && registerCheck.includes('du'), registerCheck.replace(/\s+/g, ' ').trim());

  const second = await nextTask(2);
  record('next task is semi-formal with four points and a formal placeholder', second.register === 'halbformell · Sie' && second.points.length === 4 && second.placeholder.startsWith('Sehr geehrte/r'));
  const third = await nextTask(3);
  record('following task returns to a different informal scenario', third.register === 'informell · du' && third.situation !== first.situation && third.points.length === 4);

  await cdp.click('[data-view="home"]');
  await cdp.waitFor(`document.querySelector('#view-title')?.textContent === 'Übersicht'`, 5000, 'dashboard navigation');
  const revisited = await openWriting();
  record('returning to writing retains the current task without consuming a slot', revisited.index === third.index && revisited.situation === third.situation && JSON.stringify(revisited.points) === JSON.stringify(third.points));

  await cdp.evaluate(`return import('/js/store.js').then((store) => store.flushNow());`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor(`document.querySelector('#view-title')?.textContent === 'Übersicht' && !!document.querySelector('#view .card')`, 15000, 'dashboard after reload');
  const reloaded = await openWriting();
  record('rotation survives reload and next task is semi-formal', reloaded.register === 'halbformell · Sie' && reloaded.index === 4 && reloaded.points.length === 4);

  const errors = cdp.consoleErrors();
  record('writing flow produces no browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  record('browser writing checks complete', false, error.stack);
} finally {
  if (cdp) cdp.ws.close();
  if (cleanup) await cleanup();
}
process.exit(summary() ? 1 : 0);
