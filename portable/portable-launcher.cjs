'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const serverPath = path.join(root, 'server.js');
const usage = 'Usage: start.cmd [--no-browser] [--port 4381] [--progress-file ABSOLUTE_PATH]';

function parseOptions(args) {
  const options = { browser: true, port: 4381, progressFile: path.join(root, 'progress.json') };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-browser') options.browser = false;
    else if (arg === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) {
        throw new Error('--port must be a whole number from 1 to 65535.');
      }
      options.port = Number(value);
    } else if (arg === '--progress-file') {
      const value = args[++i];
      if (!value || !path.isAbsolute(value) || path.parse(value).root.length < 2) {
        throw new Error('--progress-file requires an absolute file path with a drive letter or UNC share.');
      }
      options.progressFile = path.resolve(value);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function launch(options) {
  if (process.platform !== 'win32') throw new Error('This portable package is for Windows 10/11 x64.');
  if (!fs.existsSync(serverPath)) throw new Error('server.js is missing. Keep the application files beside start.cmd.');
  if (!fs.existsSync(path.dirname(options.progressFile))) throw new Error('The progress file folder does not exist.');

  const url = `http://127.0.0.1:${options.port}`;
  console.log('\nB1 Prep Portable');
  console.log(`Application folder: ${root}`);
  console.log(`Progress file:      ${options.progressFile}`);
  console.log('Keep this window open while studying. Press Ctrl+C to stop.');
  console.log('Wait for your progress to save before stopping or ejecting the SSD.\n');

  // Use the executable that started this launcher: start.cmd selects the bundled
  // runtime, without requiring Node to be installed on the destination computer.
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      B1PREP_PORT: String(options.port),
      B1PREP_PROGRESS_FILE: options.progressFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let ready = false;
  let stopping = false;
  let failure = false;
  let pendingLine = '';
  let stopTimer;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    console.log('\nStopping B1 Prep Portable...');
    child.kill('SIGTERM');
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    stopTimer.unref();
  };

  const startupTimer = setTimeout(() => {
    failure = true;
    console.error('The server did not finish starting. No browser was opened.');
    stop();
  }, 30000);

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    pendingLine += chunk.toString();
    const lines = pendingLine.split(/\r?\n/);
    pendingLine = lines.pop();
    for (const line of lines) {
      // A listening callback in this exact child is the readiness signal. An
      // unrelated service on the chosen port must never get the browser opened.
      const match = line.match(/^\s*App:\s+http:\/\/127\.0\.0\.1:(\d+)\s*$/);
      if (!ready && !stopping && match && Number(match[1]) === options.port) {
        ready = true;
        clearTimeout(startupTimer);
        console.log(`\nPortable app ready: ${url}`);
        if (options.browser) {
          // The URL contains only a fixed loopback address and a validated port;
          // execFile avoids a shell and opens the user's default Windows browser.
          execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (error) => {
            if (error) console.error(`Could not open the browser automatically. Open ${url} in your browser.`);
          });
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('error', (error) => {
    failure = true;
    console.error(`Could not start the bundled runtime: ${error.message}`);
  });
  child.on('close', (code) => {
    clearTimeout(startupTimer);
    clearTimeout(stopTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGHUP', stop);
    if (!ready && !stopping) {
      failure = true;
      console.error(`Portable startup failed. If port ${options.port} is occupied, close the other copy or run start.cmd --port 4323.`);
    }
    process.exitCode = failure ? 1 : stopping ? 0 : code ?? 1;
    console.log('B1 Prep Portable stopped.');
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.on('exit', () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
}

try {
  launch(parseOptions(process.argv.slice(2)));
} catch (error) {
  console.error(`B1 Prep Portable: ${error.message}`);
  console.error(usage);
  process.exitCode = 1;
}
