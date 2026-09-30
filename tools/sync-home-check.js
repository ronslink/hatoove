/** All fixtures are generated under .qa; never reads or writes learner progress. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { syncHome } from './sync-home.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, '.qa');
await fs.mkdir(qa, { recursive: true });
const suiteRoot = await fs.mkdtemp(path.join(qa, 'sync-home-check-'));
const computerName = 'B1PREP-FIXTURE-HOME';
let passed = 0;

async function listen(port = 0) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
async function close(server) { await new Promise((resolve) => server.close(resolve)); }
async function unusedPort() {
  const server = await listen();
  const port = server.address().port;
  await close(server);
  return port;
}
const record = (id, stamp) => ({
  version: 1, createdAt: 1, updatedAt: stamp,
  settings: { dailyGoal: id === 'ssd' ? 30 : 20 },
  nodes: { [`tag:${id}`]: { theta: 55, n: 1, correct: 1 } },
  history: [{ t: stamp, partId: 'SB1', difficulty: 55, correct: true, itemRef: id }],
  errors: [], srs: {}, days: {}, planDone: {},
  counters: { attempts: 1, correct: 1, aiCalls: 0, aiFailures: 0 },
});

async function fixture(name) {
  const sourceRoot = path.join(suiteRoot, name, 'portable folder');
  const homeRoot = path.join(suiteRoot, name, 'home folder');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(homeRoot, { recursive: true });
  const homePort = await unusedPort();
  let portablePort = await unusedPort();
  while (portablePort === homePort) portablePort = await unusedPort();
  const config = { homePath: homeRoot, homeComputer: computerName, portablePort };
  const configPath = path.join(sourceRoot, 'sync-home.json');
  await fs.writeFile(configPath, `\uFEFF${JSON.stringify(config)}`);
  await fs.writeFile(path.join(homeRoot, 'package.json'), JSON.stringify({ name: 'b1-prep', type: 'module' }));
  await fs.writeFile(path.join(homeRoot, '.env'), `DEEPSEEK_API_KEY=fixture-only-private\nPORT="${homePort}"\n`);
  await fs.writeFile(path.join(homeRoot, 'server.js'), '// fixture app remains unchanged\n');
  await fs.writeFile(path.join(sourceRoot, 'progress.json'), JSON.stringify(record('ssd', 20)));
  await fs.writeFile(path.join(homeRoot, 'progress.json'), JSON.stringify(record('home', 10)));
  return {
    sourceRoot, homeRoot, homePort, portablePort, config, configPath,
    sourcePath: path.join(sourceRoot, 'progress.json'),
    homePath: path.join(homeRoot, 'progress.json'),
    markerPath: path.join(sourceRoot, '.sync-home-complete.json'),
    run: (extra = {}) => syncHome({ sourceRoot, computerName, ...extra }),
  };
}

async function snapshot(directory) {
  const output = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const target = path.join(directory, name);
    const stat = await fs.stat(target);
    output[name] = stat.isFile() ? (await fs.readFile(target)).toString('base64') : '<directory>';
  }
  return output;
}
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test('dry run accepts BOM config and changes no files', async () => {
  const f = await fixture('dry-run');
  const beforeSource = await snapshot(f.sourceRoot);
  const beforeHome = await snapshot(f.homeRoot);
  assert.equal((await f.run({ dryRun: true })).status, 'dry-run');
  assert.deepEqual(await snapshot(f.sourceRoot), beforeSource);
  assert.deepEqual(await snapshot(f.homeRoot), beforeHome);
});

await test('SSD-to-home merge preserves source, home settings file, app, and backup bytes', async () => {
  const f = await fixture('direction');
  const source = await fs.readFile(f.sourcePath);
  const originalHome = await fs.readFile(f.homePath);
  const envBefore = await fs.readFile(path.join(f.homeRoot, '.env'));
  const appBefore = await fs.readFile(path.join(f.homeRoot, 'server.js'));
  const result = await f.run();
  assert.equal(result.status, 'synced');
  assert.equal(result.markerWritten, true);
  assert.deepEqual(await fs.readFile(f.sourcePath), source);
  assert.deepEqual(await fs.readFile(result.backupPath), originalHome);
  assert.deepEqual(await fs.readFile(path.join(f.homeRoot, '.env')), envBefore);
  assert.deepEqual(await fs.readFile(path.join(f.homeRoot, 'server.js')), appBefore);
  const home = JSON.parse(await fs.readFile(f.homePath, 'utf8'));
  assert.deepEqual(home.history.map((row) => row.itemRef), ['home', 'ssd']);
  assert.deepEqual(Object.keys(home.nodes).sort(), ['tag:home', 'tag:ssd']);
  assert.equal(home.settings.dailyGoal, 30);
  assert.ok(home.updatedAt > 20);
  const marker = JSON.parse(await fs.readFile(f.markerPath, 'utf8'));
  assert.equal(marker.homeComputer, computerName);
  assert.equal(marker.backupPath, result.backupPath);
});

await test('one-time marker makes a second run a complete no-op', async () => {
  const f = await fixture('one-time');
  await f.run();
  const source = await snapshot(f.sourceRoot);
  const home = await snapshot(f.homeRoot);
  assert.equal((await f.run()).status, 'already-complete');
  assert.deepEqual(await snapshot(f.sourceRoot), source);
  assert.deepEqual(await snapshot(f.homeRoot), home);
});

await test('retry merge is idempotent and makes a separate unique backup', async () => {
  const f = await fixture('retry');
  const first = await f.run();
  const afterFirst = JSON.parse(await fs.readFile(f.homePath, 'utf8'));
  // Fixture-only simulation of a missing completion marker after SSD trouble.
  await fs.unlink(f.markerPath);
  const second = await f.run();
  const afterSecond = JSON.parse(await fs.readFile(f.homePath, 'utf8'));
  assert.notEqual(second.backupPath, first.backupPath);
  assert.deepEqual(afterSecond.history, afterFirst.history);
  assert.deepEqual(afterSecond.nodes, afterFirst.nodes);
  assert.ok(afterSecond.updatedAt > afterFirst.updatedAt);
  assert.equal((await fs.readdir(f.homeRoot)).filter((name) => name.startsWith('progress.json.before-ssd-sync-')).length, 2);
});

await test('merged timestamp is newer than either record, including future timestamps', async () => {
  const f = await fixture('timestamps');
  const now = Date.now();
  await fs.writeFile(f.homePath, JSON.stringify(record('home', now + 10000)));
  await fs.writeFile(f.sourcePath, JSON.stringify(record('ssd', now + 20000)));
  await f.run();
  const home = JSON.parse(await fs.readFile(f.homePath, 'utf8'));
  assert.ok(home.updatedAt > now + 20000);
  assert.ok(home.updatedAt > now);
});

for (const badSide of ['source', 'home']) {
  await test(`invalid ${badSide} JSON is rejected without any writes`, async () => {
    const f = await fixture(`invalid-${badSide}`);
    await fs.writeFile(badSide === 'source' ? f.sourcePath : f.homePath, '{broken');
    const source = await snapshot(f.sourceRoot);
    const home = await snapshot(f.homeRoot);
    await assert.rejects(f.run(), /invalid JSON/);
    assert.deepEqual(await snapshot(f.sourceRoot), source);
    assert.deepEqual(await snapshot(f.homeRoot), home);
  });
}

await test('structurally invalid progress is rejected without any writes', async () => {
  const f = await fixture('bad-shape');
  await fs.writeFile(f.sourcePath, JSON.stringify({ nodes: [] }));
  const source = await snapshot(f.sourceRoot);
  const home = await snapshot(f.homeRoot);
  await assert.rejects(f.run(), /valid B1 Prep progress/);
  assert.deepEqual(await snapshot(f.sourceRoot), source);
  assert.deepEqual(await snapshot(f.homeRoot), home);
});

await test('wrong computer is rejected without any writes', async () => {
  const f = await fixture('wrong-computer');
  const source = await snapshot(f.sourceRoot);
  const home = await snapshot(f.homeRoot);
  await assert.rejects(f.run({ computerName: 'OFFICE-FIXTURE' }), /home computer only/);
  assert.deepEqual(await snapshot(f.sourceRoot), source);
  assert.deepEqual(await snapshot(f.homeRoot), home);
});

await test('wrong destination package is rejected without any writes', async () => {
  const f = await fixture('wrong-app');
  await fs.writeFile(path.join(f.homeRoot, 'package.json'), JSON.stringify({ name: 'other-app' }));
  const source = await snapshot(f.sourceRoot);
  const home = await snapshot(f.homeRoot);
  await assert.rejects(f.run(), /not the B1 Prep home application/);
  assert.deepEqual(await snapshot(f.sourceRoot), source);
  assert.deepEqual(await snapshot(f.homeRoot), home);
});

for (const liveSide of ['home', 'portable']) {
  await test(`listening ${liveSide} port prevents sync without any writes`, async () => {
    const f = await fixture(`live-${liveSide}`);
    const server = await listen(liveSide === 'home' ? f.homePort : f.portablePort);
    try {
      const source = await snapshot(f.sourceRoot);
      const home = await snapshot(f.homeRoot);
      await assert.rejects(f.run(), /still listening/);
      assert.deepEqual(await snapshot(f.sourceRoot), source);
      assert.deepEqual(await snapshot(f.homeRoot), home);
    } finally { await close(server); }
  });
}

console.log(`\n${passed} home-sync checks passed. Generated fixtures: ${suiteRoot}`);
