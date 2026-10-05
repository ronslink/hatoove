/*
 * PILOT-FEEDBACK-01 (slice FB-C) — the client's structural guarantees.
 *
 * WHAT THIS CAN AND CANNOT PROVE. It proves, from the source, the properties a reviewer would otherwise have to
 * take on trust: that the entry point exists on every signed-in view and cannot exist on a public page, that the
 * sheet cannot navigate or reach the listening controller, that the learner's own text is escaped, and that the
 * stylesheet stays RTL-safe. It CANNOT prove the rendered behaviour — that focus actually returns, that Escape
 * closes the dialog, or that audio keeps playing while the sheet is open. Those need a browser, and the
 * audio-interruption leg in particular is the one the 5 October incident is about. The header of
 * `app-browser-check.mjs` is where a rendered leg would live.
 *
 * A NOTE ON HOW IT READS THE FILES: comments are stripped before any pattern is tested. Without that, the
 * module's own documentation — which discusses `location` and the listening controller in order to explain why
 * it never touches them — fails the very leg it describes. That false red is the failure mode this program keeps
 * producing, so it is designed out here rather than discovered later.
 *
 * Usage: node tools/pilot-feedback-client-check.mjs   (exit 0 when every leg passes)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/** Strip block and line comments so a leg tests CODE, never the prose that explains it. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SHELL = 'public/app/index.html';
const SHEET = 'public/app/feedback.js';
const API = 'public/app/api.js';
const APP = 'public/app/app.js';
const CSS = 'public/app/feedback.css';
/** Documents a signed-out visitor can reach. None of them may carry the entry point. */
const PUBLIC_PAGES = ['public/index.html', 'public/signin.html', 'public/reset-password.html', 'public/verify-email.html'];

const results = [];
function check(name, run) {
  try {
    run();
    results.push([name, true, '']);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const shell = read(SHELL);
const shellCode = stripComments(shell);
const sheetCode = stripComments(read(SHEET));
const apiCode = stripComments(read(API));
const appCode = stripComments(read(APP));

check('1. both openers exist in the shell and are wired by the installer', () => {
  for (const id of ['feedback-open', 'feedback-open-side']) {
    assert.ok(shellCode.includes(`id="${id}"`), `the shell has no #${id}, so one of the two entry points is absent`);
  }
  assert.ok(sheetCode.includes("wire('feedback-open')") && sheetCode.includes("wire('feedback-open-side')"),
    'installFeedbackEntryPoints must wire both ids, or one opener does nothing');
});

check('2. the sidebar entry is a BUTTON: a hash link would navigate', () => {
  const entry = shellCode.match(/<button[^>]*id="feedback-open-side"[^>]*>/);
  assert.ok(entry, 'the Werkzeuge entry is not a <button>, so it cannot be trusted not to navigate');
  assert.ok(!/<a[^>]*id="feedback-open-side"/.test(shellCode), 'the Werkzeuge entry is an anchor: it would change the route');
});

check('3. the top-bar button is labelled for assistive tech', () => {
  const entry = shellCode.match(/<button[^>]*id="feedback-open"[^>]*>/);
  assert.ok(entry, 'the top bar has no feedback button');
  assert.ok(/data-i18n-aria-label="shell\.feedbackOpen"/.test(entry[0]),
    'the icon-only button must carry a translating aria-label, or it is unlabelled for a screen reader');
});

check('4. no public page can show the entry point', () => {
  for (const page of PUBLIC_PAGES) {
    const html = read(page);
    assert.ok(!html.includes('feedback-open'), `${page} references the feedback entry: it must not appear before sign-in`);
    assert.ok(!/<script[^>]*src="\/app\/app\.js"/.test(html), `${page} loads the signed-in shell, which would expose the entry point`);
  }
});

check('5. the sheet cannot navigate and cannot reach the listening controller', () => {
  /*
   * THE 5 OCTOBER RULE, as a source property. The module must have no way to change the route, reload, or call
   * into playback — the incident was a form whose mount re-rendered the run and flushed the controller.
   */
  const forbidden = [
    [/\blocation\s*(\.|\[)?\s*(hash|href|assign|replace|reload)?\s*=/, 'assigns to location'],
    [/\bhistory\s*\./, 'touches history'],
    [/\blistening\b/i, 'references the listening controller'],
    [/\bflush\s*\(/, 'calls a flush helper'],
    [/\bdispatchEvent\s*\(/, 'dispatches an event onto the page'],
  ];
  for (const [pattern, what] of forbidden) {
    const hit = sheetCode.match(pattern);
    assert.ok(!hit, `feedback.js ${what}: ${hit && hit[0]}`);
  }
});

check('6. the learner\'s own text is escaped, never interpolated raw', () => {
  assert.ok(/esc\(row\.body\)/.test(sheetCode), 'the report body must be escaped before it reaches innerHTML');
  assert.ok(!/\$\{row\.body\}/.test(sheetCode), 'the report body is interpolated raw into markup');
});

check('7. the sheet is a labelled modal that closes on Escape and returns focus', () => {
  assert.ok(/role="dialog"/.test(sheetCode) && /aria-modal="true"/.test(sheetCode), 'the sheet must be a modal dialog');
  assert.ok(/aria-labelledby="feedback-title"/.test(sheetCode), 'the dialog must name its own title');
  assert.ok(/event\.key === 'Escape'/.test(sheetCode), 'Escape must close the sheet');
  assert.ok(/invoker\.focus\(\)/.test(sheetCode), 'focus must return to the button that opened the sheet');
  assert.ok(/event\.key !== 'Tab'/.test(sheetCode), 'Tab must be trapped inside a modal dialog');
});

check('8. the client calls the four routes the contract defines', () => {
  for (const [needle, why] of [
    ["feedback: '/api/v1/feedback'", 'the feedback path'],
    ["surveyCurrent: '/api/v1/survey/current'", 'the survey-current path'],
    ["surveyRound: '/api/v1/survey'", 'the survey submission path'],
  ]) assert.ok(apiCode.includes(needle), `api.js is missing ${why}`);
  for (const method of ['create:', 'list:', 'currentSurvey:', 'submitSurvey:']) {
    assert.ok(apiCode.includes(method), `api.js has no feedback ${method.replace(':', '')} method`);
  }
});

check('9. the sheet is installed only after a successful boot, and cannot break it', () => {
  const bootAt = appCode.indexOf('async function boot()');
  const fnAt = appCode.indexOf('async function installFeedback()');
  const installAt = appCode.indexOf('await installFeedback();');
  assert.ok(bootAt >= 0 && installAt > bootAt, 'installFeedback must be called from boot(), so it appears only once signed in');
  assert.ok(fnAt >= 0, 'installFeedback must exist as its own function');
  /*
   * THE WHOLE BODY MUST BE GUARDED, not just the import. This call sits inside `boot()`'s `try`, so a synchronous
   * throw in the feature — a renamed export, a null element — would send the learner to the boot-error screen and
   * take the app down. An earlier version guarded only the `import`, which is why this leg checks the body.
   */
  const body = appCode.slice(fnAt, appCode.indexOf('\n}', fnAt));
  assert.ok(/try \{/.test(body) && /catch/.test(body), 'the install body must be wrapped, or a feature failure takes boot down with it');
  assert.ok(/await import\('\.\/feedback\.js'\)/.test(body), 'the module must be imported lazily');
});

check('10. the stylesheet stays RTL-safe', () => {
  const css = stripComments(read(CSS));
  for (const physical of [/\bleft\s*:/, /\bright\s*:/, /\bmargin-left\s*:/, /\bpadding-right\s*:/]) {
    const hit = css.match(physical);
    assert.ok(!hit, `feedback.css uses a physical property (${hit && hit[0]}): Arabic RTL would mirror it wrongly`);
  }
  assert.ok(/padding-inline|inline-size|margin-inline/.test(css), 'feedback.css declares no logical property, so it was not reviewed for RTL at all');
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n---- pilot-feedback-client-check: ${results.length - failed.length}/${results.length} passed ----`);
if (failed.length) {
  for (const [name, , detail] of failed) console.log(`  FAIL  ${name}: ${detail}`);
  process.exit(1);
}
console.log('all legs passed');
