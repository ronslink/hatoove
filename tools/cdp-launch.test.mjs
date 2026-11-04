import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { launchBrowser, connectToPage, waitForHttp } from './cdp.js';

// The injected child is a real isolated process. No installed Chrome, provider, app or DB is used.
const originalChrome = process.env.CHROME_PATH;
process.env.CHROME_PATH = process.execPath;
after(() => { if (originalChrome === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = originalChrome; });
const freePort = async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const child = script => ({ spawnProcess: (_binary, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', script], options) });
const closed = handle => {
  assert.ok(handle.proc.exitCode !== null || handle.proc.signalCode !== null, 'owned child still alive');
  assert.equal(fs.existsSync(handle.profile), false, 'throwaway profile retained');
};

test('readiness deadline aborts a server that accepts but never answers', async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  try {
    await assert.rejects(waitForHttp(`http://127.0.0.1:${server.address().port}/json/version`, 150), /Timed out.*TimeoutError/);
    assert.ok(Date.now() - started < 2000, 'one fetch escaped the total budget');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('occupied port is rejected before spawning and its listener is preserved', async () => {
  const server = http.createServer((_request, response) => response.end('foreign'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let spawned = false;
  try {
    await assert.rejects(launchBrowser(server.address().port, {}, { spawnProcess: () => { spawned = true; } }), /unavailable: EADDRINUSE/);
    assert.equal(spawned, false);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'foreign');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('early exit fails promptly with bounded startup stderr and cleans its owned profile', async () => {
  const port = await freePort();
  const handle = await launchBrowser(port, {}, child(String.raw`process.stderr.write('界'.repeat(9000)+' fatal synthetic startup\n');process.exit(17);`));
  const started = Date.now();
  await assert.rejects(connectToPage(port), error => {
    assert.equal(error.browserDiagnostics.exitCode, 17);
    assert.ok(error.browserDiagnostics.stderrTail.endsWith('fatal synthetic startup\n'));
    assert.ok(error.browserDiagnostics.stderrTail.length <= 16384);
    assert.ok(Buffer.byteLength(error.browserDiagnostics.stderrTail) <= 16386, 'tail exceeded its byte bound plus one decoded boundary replacement');
    return /Chrome exited before connection/.test(error.message);
  });
  assert.ok(Date.now() - started < 4000, 'dead child waited for readiness timeout');
  closed(handle);
  await handle.cleanup(); // Caller finally remains safe after connect failure already cleaned it.
});

test('spawn errors are handled and reported rather than becoming uncaught events', async () => {
  const port = await freePort();
  const handle = await launchBrowser(port, {}, { spawnProcess: (_binary, _args, options) => spawn(process.execPath + '.missing', [], options) });
  await assert.rejects(connectToPage(port), error => error.browserDiagnostics.spawnError === 'ENOENT');
  assert.equal(fs.existsSync(handle.profile), false);
});

test('a responsive debugging endpoint with another browser identity is never attached', async () => {
  const port = await freePort();
  const own = `ws://127.0.0.1:${port}/devtools/browser/owned`;
  const handle = await launchBrowser(port, {}, child(String.raw`
    import http from 'node:http';
    const server=http.createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({webSocketDebuggerUrl:${JSON.stringify(own + '-foreign')}}));});
    server.listen(${port},'127.0.0.1',()=>process.stderr.write('DevTools listening on '+${JSON.stringify(own)}+'\n'));
  `));
  await assert.rejects(connectToPage(port), /does not belong to the spawned Chrome/);
  closed(handle);
});

test('page endpoint must stay on the owned port and later stderr is not retained', async () => {
  const port = await freePort();
  const own = `ws://127.0.0.1:${port}/devtools/browser/owned`;
  const handle = await launchBrowser(port, {}, child(String.raw`
    import http from 'node:http';
    const server=http.createServer((request,response)=>{
      response.setHeader('content-type','application/json');
      if(request.url==='/json/version')return response.end(JSON.stringify({webSocketDebuggerUrl:${JSON.stringify(own)}}));
      process.stderr.write('LATER-SYNTHETIC-APP-DATA\n');
      setTimeout(()=>response.end(JSON.stringify([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:1/devtools/page/foreign'}])),100);
    });
    server.listen(${port},'127.0.0.1',()=>process.stderr.write('DevTools listening on '+${JSON.stringify(own)}+'\n'));
  `));
  await assert.rejects(connectToPage(port), error => {
    assert.equal(error.browserDiagnostics.startupComplete, true);
    assert.ok(!error.browserDiagnostics.stderrTail.includes('LATER-SYNTHETIC-APP-DATA'));
    return /Unexpected page debugging endpoint/.test(error.message);
  });
  closed(handle);
});

test('connection requires a harness-owned launch, never an arbitrary existing browser', async () => {
  await assert.rejects(connectToPage(await freePort()), /No harness-owned Chrome launch/);
});

test('a silent CDP socket cannot extend the existing 15-second connection budget', async () => {
  const port = await freePort(), own = `ws://127.0.0.1:${port}/devtools/browser/owned`;
  const handle = await launchBrowser(port, {}, child(String.raw`
    import http from 'node:http';import {createHash} from 'node:crypto';
    const server=http.createServer((request,response)=>{
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify(request.url==='/json/version'?{webSocketDebuggerUrl:${JSON.stringify(own)}}:[{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:${port}/devtools/page/owned'}]));
    });
    server.on('upgrade',(request,socket)=>{
      const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
      socket.on('data',()=>{});socket.on('error',()=>{});
    });
    server.listen(${port},'127.0.0.1',()=>process.stderr.write('DevTools listening on '+${JSON.stringify(own)}+'\n'));
  `));
  const started = Date.now();
  await assert.rejects(connectToPage(port), /CDP timeout: Runtime.enable/);
  assert.ok(Date.now() - started < 18000, 'CDP initialization exceeded the connection budget plus cleanup');
  closed(handle);
});

test('POSIX cleanup terminates the owned descendant group and preserves a separate child', { skip: process.platform === 'win32' }, async () => {
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const port = await freePort();
  let descendant;
  try {
    const handle = await launchBrowser(port, {}, child(String.raw`
      import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      process.stderr.write('descendant:'+child.pid+'\n');
      setTimeout(()=>process.exit(17),100);
    `));
    await assert.rejects(connectToPage(port), error => {
      descendant = Number(error.browserDiagnostics.stderrTail.match(/descendant:(\d+)/)?.[1]);
      return error.browserDiagnostics.exitCode === 17 && Number.isInteger(descendant);
    });
    closed(handle);
    let running = false;
    try { running = !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${descendant}/status`, 'utf8')); } catch (error) { assert.equal(error.code, 'ENOENT'); }
    assert.equal(running, false, 'owned descendant survived cleanup');
    assert.equal(sibling.exitCode, null, 'unrelated child was terminated');
    process.kill(sibling.pid, 0);
  } finally { sibling.kill(); }
});
