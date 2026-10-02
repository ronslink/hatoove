#!/usr/bin/env node
/** COMPLETE-ENTRY: disposable Compose + Chromium checks for the public German entry and recovery.
 * Uses synthetic accounts only, no live provider calls. Captured operator links stay in memory.
 * Browser viewport evidence does not replace iPhone Safari / Android Chrome device acceptance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, connectToPage, sleep, makeRecorder } from './cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = 'hatoove-entry-check-' + Date.now();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), project + '-'));
const shots = path.join(root, '.qa', 'entry', project);
const envFile = path.join(scratch, 'compose.env');
const { record, summary } = makeRecorder();
const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
let appPort, dbPort, base, browser, cdp, started = false;
function compose(args) {
  const result = spawnSync('docker', ['compose', '--env-file', envFile, '-p', project, '-f', path.join(root, 'compose.yaml'), ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, HATOVE_APP_PORT: String(appPort), HATOVE_DB_PORT: String(dbPort), HATOVE_PUBLIC_ORIGIN: base } });
  // Do not print logs: this test's operator messages contain synthetic bearer tokens.
  if (result.error || result.status) throw new Error('Disposable Compose command failed: ' + args[0]);
  return result.stdout || '';
}
async function nav(route) {
  await cdp.send('Page.navigate', { url: base + route });
  await cdp.waitFor('document.readyState === "complete"', 15000, 'document load');
  await sleep(100);
}
async function fill(values) {
  await cdp.evaluate('for (const [id, value] of Object.entries(' + JSON.stringify(values) + ')) document.getElementById(id).value = value;');
}
async function submit(id) { await cdp.evaluate('document.getElementById(' + JSON.stringify(id) + ').requestSubmit();'); }
async function shown(id) { return cdp.evaluate('const el = document.getElementById(' + JSON.stringify(id) + '); return !!el && !el.hidden && el.getBoundingClientRect().height > 0;'); }
async function shot(name) {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function layout(route, width, scheme, name) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 700 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 700 });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await nav(route);
  const result = await cdp.evaluate('return { overflow: document.documentElement.scrollWidth > innerWidth + 1, font: getComputedStyle(document.body).fontFamily, bg: getComputedStyle(document.body).backgroundColor, language: document.documentElement.lang };');
  record(name + ' layout', !result.overflow && result.language === 'de' && result.font.includes('Source Sans'), JSON.stringify(result));
  await shot(name);
}
function deliveredLink(page) {
  const lines = compose(['logs', '--no-color', 'app']).split(/\r?\n/);
  const line = lines.filter(value => value.includes('[notify]') && value.includes('/' + page + '?token=')).at(-1);
  if (!line) throw new Error('No synthetic operator link was produced for ' + page);
  return new URL(line.match(/https?:\/\/\S+$/)[0]);
}
async function main() {
  appPort = await freePort(); dbPort = await freePort(); base = 'http://127.0.0.1:' + appPort;
  if (appPort === 4300 || dbPort === 55440 || appPort === dbPort) throw new Error('Unsafe fixture port');
  fs.writeFileSync(envFile, 'HATOVE_APP_PORT=' + appPort + '\nHATOVE_DB_PORT=' + dbPort + '\nHATOVE_PUBLIC_ORIGIN=' + base + '\n');
  fs.mkdirSync(shots, { recursive: true });
  try {
    console.log('Starting isolated source-only Compose project ' + project);
    started = true;
    compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
    const debugPort = await freePort();
    browser = await launchBrowser(debugPort);
    cdp = await connectToPage(debugPort);

    await cdp.send('Network.enable');
    for (const [route, label] of [['/', 'landing'], ['/signin', 'signin'], ['/reset-password', 'reset-request'], ['/verify-email', 'verify-request']]) {
      for (const [width, scheme] of [[1440, 'light'], [390, 'light'], [320, 'dark']]) await layout(route, width, scheme, label + '-' + width + '-' + scheme);
    }
    await nav('/');
    record('German front door links to registration and sign-in', await cdp.evaluate('return document.querySelector("#nav-start").getAttribute("href") === "/signin?mode=signup" && document.querySelector("#nav-signin").getAttribute("href") === "/signin";'));
    await cdp.click('#answer-options input[value="0"]');
    await submit('answer-form');
    record('landing sample produces German answer explanation', (await cdp.text()).includes('Genau. Alle Einzelheiten passen.'));
    await cdp.click('#tab-writing');
    await fill({ 'writing-response': 'Liebe Mila, ich helfe dir gern.' });
    await cdp.evaluate('document.querySelector("#writing-response").dispatchEvent(new Event("input"));');
    await cdp.click('#tab-reading'); await cdp.click('#tab-writing');
    record('preview draft survives practice-tab navigation', await cdp.evaluate('return document.querySelector("#writing-response").value === "Liebe Mila, ich helfe dir gern.";'));
    const email = 'entry-' + Date.now() + '@example.test';
    const password = 'synthetic-entry-initial-password';
    await nav('/signin?mode=signup');
    record('free-start route opens registration', await shown('form-signup') && !(await shown('form-signin')));
    await fill({ 'su-name': 'Synthetic Entry', 'su-email': email, 'su-password': password });
    await submit('form-signup');
    await cdp.waitFor('location.pathname === "/app/"', 15000, 'registration app redirect');
    record('registration lands inside app', true);
    await cdp.send('Network.clearBrowserCookies');
    await nav('/reset-password');
    await fill({ 'request-email': email }); await submit('form-request');
    await cdp.waitFor('document.querySelector("#status").textContent.includes("passenden Konto")', 10000, 'reset request');
    const knownMessage = await cdp.evaluate('return document.querySelector("#status").textContent;');
    record('reset request explains operator delivery', knownMessage.includes('Eine Person') && knownMessage.includes('keine automatische E-Mail'));
    const resetLink = deliveredLink('reset-password');
    await fill({ 'request-email': 'absent-' + Date.now() + '@example.test' }); await submit('form-request');
    await cdp.waitFor('document.querySelector("#status").textContent.includes("passenden Konto")', 10000, 'generic absent-account response');
    record('unknown account gets identical visible request response', knownMessage === await cdp.evaluate('return document.querySelector("#status").textContent;'));
    await nav(resetLink.pathname + resetLink.search);
    record('reset token removed from URL without storage', await cdp.evaluate('return !location.search && localStorage.length === 0 && sessionStorage.length === 0;'));
    record('reset token opens password form', await shown('form-reset') && !(await shown('form-request')));
    await fill({ 'new-password': 'synthetic-entry-new-password', 'confirm-password': 'different-password' });
    await submit('form-reset');
    record('mismatched passwords stay on form', (await cdp.text()).includes('stimmen nicht überein') && await shown('form-reset'));
    await fill({ 'confirm-password': 'synthetic-entry-new-password' }); await submit('form-reset');
    await cdp.waitFor('!document.querySelector("#success").hidden', 10000, 'reset success');
    record('real reset succeeds without automatic sign-in', (await cdp.text()).includes('Dein Passwort wurde geändert') && !(await shown('form-reset')));
    await shot('reset-success-320-dark');
    await nav(resetLink.pathname + resetLink.search);
    await fill({ 'new-password': 'another-password', 'confirm-password': 'another-password' }); await submit('form-reset');
    await cdp.waitFor('!document.querySelector("#error").hidden', 10000, 'used reset token refusal');
    record('used reset token has recovery path', (await cdp.text()).includes('abgelaufen') && await shown('request-another') && !(await shown('form-reset')));
    await shot('reset-invalid-320-dark');
    await nav('/signin');
    await fill({ 'si-email': email, 'si-password': 'synthetic-entry-new-password' }); await submit('form-signin');
    await cdp.waitFor('location.pathname === "/app/"', 15000, 'new password sign-in');
    record('new password actually signs in', true);
    await cdp.send('Network.clearBrowserCookies');
    await nav('/verify-email');
    await fill({ 'request-email': email }); await submit('form-request');
    await cdp.waitFor('document.querySelector("#status").textContent.includes("passenden Konto")', 10000, 'verify request');
    const verifyLink = deliveredLink('verify-email');
    await nav(verifyLink.pathname + verifyLink.search);
    record('verification waits for explicit action and scrubs token', await shown('form-verify') && await cdp.evaluate('return !location.search;'));
    await submit('form-verify');
    await cdp.waitFor('!document.querySelector("#success").hidden', 10000, 'verify success');
    record('verification succeeds without session', (await cdp.text()).includes('Deine E-Mail-Adresse ist bestätigt') && await cdp.evaluate('return fetch("/api/auth/get-session").then(r => r.json()).then(value => value === null);'));
    await shot('verify-success-320-dark');
    await nav(verifyLink.pathname + verifyLink.search); await submit('form-verify');
    await cdp.waitFor('!document.querySelector("#error").hidden', 10000, 'used verification refusal');
    record('used verification token can request another link', await shown('request-another'));
    await nav('/reset-password?token=');
    record('empty token reports invalid link', await shown('error') && await shown('request-another'));
    await nav('/reset-password');
    await cdp.evaluate('window.fetch = async () => { throw new TypeError("synthetic offline"); };');
    await fill({ 'request-email': email }); await submit('form-request');
    await cdp.waitFor('!document.querySelector("#error").hidden', 10000, 'offline feedback');
    record('offline request keeps inputs and allows retry', (await cdp.text()).includes('Keine Verbindung') && await cdp.evaluate('return !document.querySelector("#request-submit").disabled && document.querySelector("#request-email").value.length > 0;'));
    await nav('/verify-email');
    await cdp.evaluate('window.fetch = async () => new Response(JSON.stringify({error:"too_many_requests"}), {status:429, headers:{"content-type":"application/json"}});');
    await fill({ 'request-email': email }); await submit('form-request');
    await cdp.waitFor('!document.querySelector("#error").hidden', 10000, 'throttle feedback');
    record('throttling presents waiting guidance', (await cdp.text()).includes('Zu viele Anfragen'));
    await nav('/reset-password');
    await cdp.evaluate('window.fetch = () => new Promise(resolve => { window.finishRequest = resolve; });');
    await fill({ 'request-email': email }); await submit('form-request');
    record('pending requests visibly disable repeat submission', await cdp.evaluate('return document.querySelector("#request-submit").disabled && document.querySelector("#status").textContent.includes("übermittelt");'));
    await cdp.evaluate('window.finishRequest(new Response(JSON.stringify({error:"recovery_unavailable"}), {status:503, headers:{"content-type":"application/json"}}));');
    await cdp.waitFor('!document.querySelector("#error").hidden', 10000, 'unavailable feedback');
    record('unavailable recovery allows retry without false delivery claim', (await cdp.text()).includes('gerade nicht verfügbar') && !(await cdp.text()).includes('erhält das Pilotteam die Anfrage'));
    for (const [width, scheme] of [[1440, 'light'], [390, 'dark']]) {
      await layout('/', width, scheme, 'landing-final-' + width + '-' + scheme);
      await cdp.evaluate('document.querySelector("#angebot").scrollIntoView({behavior:"instant",block:"start"});');
      await shot('landing-offer-' + width + '-' + scheme);
      await cdp.evaluate('document.querySelector("#fragen").scrollIntoView({behavior:"instant",block:"start"});');
      await shot('landing-faq-' + width + '-' + scheme);
    }
    record('no uncaught browser exception', cdp.consoleErrors().length === 0, String(cdp.consoleErrors().length));
    console.log('Screenshots: ' + shots);
    process.exitCode = summary() ? 1 : 0;
  } finally {
    if (cdp) cdp.ws.close();
    if (browser) await browser.cleanup();
    if (started) compose(['down', '-v', '--remove-orphans']);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
