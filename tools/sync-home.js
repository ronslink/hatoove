/** One-time, explicit SSD -> home progress merge. Never writes SSD progress. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeProgress } from '../public/js/progress-merge.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER_NAME = '.sync-home-complete.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function readJSON(file, label) {
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch { throw new Error(`${label} cannot be read: ${file}`); }
  let value;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${label} contains invalid JSON. No progress was changed.`); }
  return { bytes, value, hash: hash(bytes) };
}

function validateProgress(record, label) {
  if (!isObject(record) || !isObject(record.nodes)) throw new Error(`${label} is not a valid B1 Prep progress record.`);
  for (const key of ['settings', 'counters', 'srs', 'days', 'planDone']) {
    if (record[key] !== undefined && !isObject(record[key])) throw new Error(`${label} has an invalid ${key} field.`);
  }
  for (const key of ['history', 'errors']) {
    if (record[key] !== undefined && !Array.isArray(record[key])) throw new Error(`${label} has an invalid ${key} field.`);
  }
  if (record.updatedAt !== undefined && (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 || record.updatedAt >= Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} has an invalid updatedAt timestamp.`);
  }
}

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be a port between 1 and 65535.`);
  return value;
}

async function readHomePort(homeRoot) {
  let text;
  try { text = await fs.readFile(path.join(homeRoot, '.env'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return 4321;
    throw new Error('The home app configuration could not be read. No progress was changed.');
  }
  let value;
  // Only inspect PORT. API keys and all other configuration remain private and
  // are never copied, rewritten, or included in results and console output.
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^PORT\s*=(.*)$/);
    if (!match) continue;
    value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  }
  if (!value) return 4321;
  return validatePort(Number(value), 'The home app PORT setting');
}

async function portIsListening(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let finished = false;
    const done = (error, listening) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(listening);
    };
    socket.setTimeout(1500, () => done(new Error(`Could not verify that port ${port} is stopped. Close both app tabs and server consoles, then retry.`)));
    socket.once('connect', () => done(null, true));
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') done(null, false);
      else done(new Error(`Could not check port ${port}. Close both app tabs and server consoles, then retry.`));
    });
  });
}

async function requireStopped(ports) {
  for (const port of new Set(ports)) {
    if (await portIsListening(port)) {
      throw new Error(`Port ${port} is still listening. Close BOTH the home and SSD browser tabs and server consoles, then run Sync-to-Home.cmd again. No progress was changed.`);
    }
  }
}

async function writeNewFile(file, bytes) {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Exported so checks can use generated fixtures instead of learner files. */
export async function syncHome({ sourceRoot = APP_ROOT, configPath, dryRun = false, computerName = process.env.COMPUTERNAME } = {}) {
  sourceRoot = await fs.realpath(sourceRoot);
  const configFile = configPath ? path.resolve(configPath) : path.join(sourceRoot, 'sync-home.json');
  const { value: config } = await readJSON(configFile, 'The home-sync configuration');
  if (!isObject(config) || typeof config.homePath !== 'string' || !path.isAbsolute(config.homePath) ||
      typeof config.homeComputer !== 'string' || !config.homeComputer.trim()) {
    throw new Error('The home-sync configuration must identify an absolute homePath and homeComputer.');
  }
  if (!computerName || computerName.toLowerCase() !== config.homeComputer.toLowerCase()) {
    throw new Error('This sync is configured for your home computer only. It cannot update an office or other computer.');
  }
  const portablePort = validatePort(config.portablePort, 'The portable app port');
  let homeRoot;
  try { homeRoot = await fs.realpath(config.homePath); }
  catch { throw new Error('The configured home application folder cannot be found.'); }
  if (samePath(sourceRoot, homeRoot)) throw new Error('The SSD source and home destination must be different application folders.');
  const { value: homePackage } = await readJSON(path.join(homeRoot, 'package.json'), 'The home application package');
  if (homePackage?.name !== 'b1-prep') throw new Error('The destination is not the B1 Prep home application.');

  const markerPath = path.join(sourceRoot, MARKER_NAME);
  try {
    await fs.access(markerPath);
    return { status: 'already-complete', homeRoot, markerPath };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The one-time completion marker could not be checked.');
  }

  const sourcePath = path.join(sourceRoot, 'progress.json');
  const homePath = path.join(homeRoot, 'progress.json');
  const source = await readJSON(sourcePath, 'SSD progress');
  const home = await readJSON(homePath, 'Home progress');
  validateProgress(source.value, 'SSD progress');
  validateProgress(home.value, 'Home progress');
  const homePort = await readHomePort(homeRoot);
  await requireStopped([homePort, portablePort]);

  const merged = mergeProgress(home.value, source.value);
  merged.updatedAt = Math.max(Date.now() + 1, (home.value.updatedAt || 0) + 1, (source.value.updatedAt || 0) + 1);
  const mergedBytes = Buffer.from(JSON.stringify(merged));
  const mergedHash = hash(mergedBytes);
  if (dryRun) return { status: 'dry-run', sourcePath, homePath, updatedAt: merged.updatedAt };

  const unique = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = path.join(homeRoot, `progress.json.before-ssd-sync-${unique}.bak`);
  const tempPath = path.join(homeRoot, `.progress-ssd-sync-${unique}.tmp`);
  const lockPath = path.join(homeRoot, '.b1prep-sync-home.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another home sync may be running. The home-sync lock already exists; no progress was changed.');
    throw new Error('The home application folder is not writable. No progress was changed.');
  }

  let committed = false;
  try {
    // Take a byte-for-byte backup, never replacing an earlier backup.
    await writeNewFile(tempPath, mergedBytes);
    await writeNewFile(backupPath, home.bytes);
    if (hash(await fs.readFile(backupPath)) !== home.hash) throw new Error('The home backup did not verify. No progress was changed.');
    await requireStopped([homePort, portablePort]);

    // Check both originals immediately before the atomic replacement. A study
    // session or another writer changing either file makes this sync abort.
    const currentSource = await fs.readFile(sourcePath);
    const currentHome = await fs.readFile(homePath);
    if (hash(currentSource) !== source.hash || hash(currentHome) !== home.hash) {
      throw new Error('Progress changed while the sync was preparing. Close both apps and try again. Home progress was not replaced.');
    }
    await fs.rename(tempPath, homePath);
    committed = true;
    if (hash(await fs.readFile(homePath)) !== mergedHash) {
      throw new Error(`Home progress was replaced but readback verification failed. Preserve the backup: ${backupPath}`);
    }

    const marker = {
      completedAt: new Date().toISOString(),
      homeComputer: config.homeComputer,
      homePath: homeRoot,
      sourceHash: source.hash,
      homeHash: mergedHash,
      backupPath,
    };
    const markerTemp = path.join(sourceRoot, `.sync-home-complete-${unique}.tmp`);
    try {
      await writeNewFile(markerTemp, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`));
      await fs.rename(markerTemp, markerPath);
    } catch {
      // A partial marker never occupies the completion path, so a safe,
      // idempotent retry remains possible after an interrupted SSD write.
      await fs.unlink(markerTemp).catch(() => {});
      return {
        status: 'synced', sourcePath, homePath, backupPath, markerWritten: false,
        warning: 'Home progress was updated and verified, but the SSD completion marker could not be saved. You can retry safely; the merge will not duplicate study attempts.',
      };
    }
    return { status: 'synced', sourcePath, homePath, backupPath, markerWritten: true };
  } catch (error) {
    if (committed && !error.message.includes('was replaced')) {
      throw new Error(`Home progress may already have been updated. Preserve the backup ${backupPath}. ${error.message}`);
    }
    throw error;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
    await lock.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dry-run') options.dryRun = true;
    else if (args[index] === '--config' && args[index + 1]) options.configPath = args[++index];
    else if (args[index] === '--help') {
      console.log('Usage: Sync-to-Home.cmd [--dry-run] [--config PATH]');
      return;
    } else throw new Error('Use --dry-run, --config PATH, or --help.');
  }
  const result = await syncHome(options);
  if (result.status === 'already-complete') console.log('This one-time SSD-to-home sync has already completed. Nothing was changed.');
  else if (result.status === 'dry-run') {
    console.log('Dry run passed. No files were changed.');
    console.log(`Source: ${result.sourcePath}`);
    console.log(`Home destination: ${result.homePath}`);
  } else {
    console.log('Your SSD progress has been merged into the home app. SSD study progress is unchanged.');
    console.log(`Home progress: ${result.homePath}`);
    console.log(`Original home backup: ${result.backupPath}`);
    if (result.warning) { console.error(result.warning); process.exitCode = 1; }
    else console.log('The one-time sync is complete. You can now start the home app.');
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`Home sync stopped: ${error.message}`); process.exitCode = 1; });
}
