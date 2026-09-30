/** Launch the explicitly authorized GreenPT benchmark; no secret values are logged. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--env-file');
if (fileIndex < 0 || !args[fileIndex + 1]) {
  console.error('Specify --env-file followed by the existing .env path.');
  process.exit(1);
}
const envPath = args[fileIndex + 1];
args.splice(fileIndex, 2);
const providerIndex = args.indexOf('--provider');
if (providerIndex >= 0 && args[providerIndex + 1] !== 'greenpt') {
  console.error('This launcher is restricted to the GreenPT EU benchmark.');
  process.exit(1);
}
let key = '';
try {
  const values = parseEnv(await fs.readFile(envPath, 'utf8'));
  key = (values.greenpt_api_key ?? values.GREENPT_API_KEY ?? '').trim();
  for (const name of Object.keys(values)) values[name] = '';
} catch {
  console.error('Unable to read or parse the specified credential file.');
  process.exit(1);
}
if (!key || key.length > 4096 || /\s/.test(key)) {
  console.error('The file must contain greenpt_api_key or GREENPT_API_KEY as one nonempty token.');
  process.exit(1);
}
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const child = spawn(process.execPath, [runner, '--live', '--key-stdin', ...args], {
  stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
});
child.stdin.on('error', () => {});
child.on('error', () => {
  key = '';
  console.error('Unable to start the benchmark process.');
  process.exitCode = 1;
});
child.stdin.end(key + '\n');
key = '';
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
