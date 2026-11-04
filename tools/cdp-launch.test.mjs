import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { launchBrowser, connectToPage, waitForHttp } from './cdp.js';

// The injected child is a real isolated process. No installed Chrome, provider, app or DB is used.
const originalChrome = process.env.CHROME_PATH;
// Linux observed a 14,999 ms milestone: allow narrow timer/wall-clock rounding, not a different budget.
const TIMING_TOLERANCE_MS = 100;
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
const peer = (port, { delayMs = 0, silent = false } = {}) => String.raw`
  import http from 'node:http';import {createHash} from 'node:crypto';
  const own='ws://127.0.0.1:${port}/devtools/browser/owned', domains=[];
  const server=http.createServer((request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(request.url==='/json/version'?{webSocketDebuggerUrl:own}:[{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:${port}/devtools/page/owned'}]));
  });
  server.on('upgrade',(request,socket)=>{
    const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let pending=Buffer.alloc(0);
    socket.on('data',chunk=>{
      if(${silent})return;
      pending=Buffer.concat([pending,chunk]);
      while(pending.length>=2){
        const opcode=pending[0]&15, masked=Boolean(pending[1]&128);
        let length=pending[1]&127, offset=2;
        if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4;}
        if(length===127){socket.destroy();return;}
        if(pending.length<offset+(masked?4:0)+length)return;
        const mask=masked?pending.subarray(offset,offset+4):null;offset+=masked?4:0;
        const payload=Buffer.from(pending.subarray(offset,offset+length));pending=pending.subarray(offset+length);
        if(mask)for(let n=0;n<payload.length;n++)payload[n]^=mask[n%4];
        if(opcode===8){socket.end(Buffer.from([136,0]));return;}
        const message=JSON.parse(payload.toString('utf8'));
        if(message.method.endsWith('.enable'))domains.push(message.method);
        const data=Buffer.from(JSON.stringify({id:message.id,result:message.method==='Probe.marker'?{pid:process.pid,domains}: {}}));
        const header=data.length<126?Buffer.from([129,data.length]):Buffer.from([129,126,data.length>>8,data.length&255]);
        socket.write(Buffer.concat([header,data]));
      }
    });
    socket.on('error',()=>{});
  });
  setTimeout(()=>server.listen(${port},'127.0.0.1',()=>process.stderr.write('DevTools listening on '+own+'\n')),${delayMs});
`;
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

test('one delayed child connects after 16 seconds with its 15-second milestone retained', async () => {
  const port = await freePort(), injected = child(peer(port, { delayMs: 16000 }));
  let spawns = 0;
  const handle = await launchBrowser(port, {}, { spawnProcess: (...args) => { spawns++; return injected.spawnProcess(...args); } });
  let cdp;
  try {
    cdp = await connectToPage(port);
    const marker = await cdp.send('Probe.marker');
    assert.equal(spawns, 1, 'startup relaunched the child');
    assert.equal(marker.pid, handle.proc.pid, 'connected to a different process');
    assert.deepEqual(marker.domains, ['Runtime.enable', 'Page.enable', 'Log.enable']);
    const diagnostic = handle.diagnostics();
    console.log('Delayed child timing: ' + JSON.stringify(diagnostic));
    assert.ok(diagnostic.phaseTimings.connected >= 16000 && diagnostic.phaseTimings.connected < 30000);
    assert.equal(diagnostic.startupMilestone.pid, handle.proc.pid);
    assert.equal(diagnostic.startupMilestone.startupPhase, 'version');
    assert.ok(diagnostic.startupMilestone.elapsedMs >= 15000 - TIMING_TOLERANCE_MS && diagnostic.startupMilestone.elapsedMs < diagnostic.phaseTimings.connected);
    assert.equal(diagnostic.startupMilestone.announcedDebugger, false);
    assert.ok(Buffer.byteLength(diagnostic.startupMilestone.stderrTail) <= 2050);
  } finally { cdp?.ws.close(); await handle.cleanup(); }
  closed(handle);
});

test('a silent CDP socket cannot extend the single 30-second startup budget', async () => {
  const port = await freePort();
  const handle = await launchBrowser(port, {}, child(peer(port, { delayMs: 16000, silent: true })));
  const started = Date.now();
  await assert.rejects(connectToPage(port), error => {
    console.log('Silent child timing: ' + JSON.stringify(error.browserDiagnostics));
    assert.equal(error.browserDiagnostics.startupPhase, 'Runtime.enable');
    assert.equal(error.browserDiagnostics.startupMilestone.startupPhase, 'version');
    assert.ok(error.browserDiagnostics.elapsedMs >= 30000 - TIMING_TOLERANCE_MS && error.browserDiagnostics.elapsedMs < 33000);
    assert.equal(error.browserDiagnostics.cleanup.processClosed, true);
    assert.equal(error.browserDiagnostics.cleanup.profileRemoved, true);
    return /CDP timeout: Runtime.enable/.test(error.message);
  });
  assert.ok(Date.now() - started < 33000, 'CDP initialization exceeded the startup budget plus cleanup');
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
