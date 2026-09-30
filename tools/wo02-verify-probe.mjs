/**
 * tools/wo02-verify-probe.mjs — REVIEWER-AUTHORED independent probe for WRITING-OUTCOMES-02.
 *
 * Written by the independent reviewer (execution `wo02-verify-hermes-20261001-a`). It shares no
 * code with either candidate's checker: the CDP client, the fixtures and the assertions below are
 * this reviewer's own, and the module-level section drives the tree under test through its public
 * exports only. It is deliberately candidate-neutral, so the same file can be pointed at candidate
 * A, candidate B, or a mutated scratch tree:
 *
 *   node tools/wo02-verify-probe.mjs --tree /path/to/checkout [--port 4341] [--no-browser]
 *   node tools/wo02-verify-probe.mjs --self-mutate dead-new-mock-button --tree <scratch copy>
 *
 * What it measures (nothing here is copied from the candidate suites):
 *   M1  legitimate zero (assessed, points 0) vs missing writing (unassessed, points null)
 *   M2  whitespace-only / missing-analysis text stays unassessed
 *   M3  malformed provider replies of eight shapes stay unassessed with the text preserved
 *   M4  every summary key AND every summary string is scanned for a pass/grade/readiness claim
 *   M5  duplicate (timer+click) completion: one collect, one commit
 *   M6  a completion that is stale at call time is not collected or committed
 *   M7  a result that resolves after the block advanced is dropped
 *   M8  a collect that throws: does the block stay usable afterwards, or lock forever?
 *   B1  real headless Chromium run of the mock: writing unassessed, no whole-exam claim,
 *       learner text still visible, no "/ 300" whole-exam denominator, console clean
 *   B2  "Neuer Mocktest" really returns to the intro (click, then wait for [data-start-mock])
 *
 * Honesty: module + one headless page per run. No real device, no keyboard, no audio, no live
 * provider call, no credential. Every text is synthetic. No network beyond 127.0.0.1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
// Windows-safe root resolution. The reviewer's original used
// `new URL(import.meta.url).pathname`, which yields "/D:/..." on Windows and produced a
// doubled path (`D:/D:/...`) when passed to path.resolve. `fileURLToPath` is the correct
// conversion and behaves identically on Linux. Changed only for that; no measurement changed.
const TREE = path.resolve(flag('tree', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
const PORT = Number(flag('port', '4341'));
const SELF_MUTATE = flag('self-mutate', null);
const WITH_BROWSER = !argv.includes('--no-browser');
const SYNTHETIC = 'SYNTHETIC-WO02-VERIFY-PROBE';

const rows = [];
const record = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, label) => assert(JSON.stringify(a) === JSON.stringify(b), `${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ fixtures */

const TASK = {
  situation: 'Synthetic. Du hast eine Anfrage zur Kursanmeldung bekommen.',
  adressat: 'Kursleitung', register: 'du',
  leitpunkte: ['Danke sagen', 'Nach dem Termin fragen', 'Teilnahme bestätigen', 'Um Bestätigung bitten'],
};

function longText() {
  const s = ' Ich schreibe dir, weil ich mich über deine Nachricht vom letzten Dienstag sehr gefreut habe.';
  return `Hallo, vielen Dank für deine Nachricht.${s.repeat(12)} Bis bald, viele Grüße.`.trim();
}

/** A complete, internally consistent rubric reply. `total` decides the mark, including 0. */
function validReply(total) {
  const per = { aufgabe: 15, kommunikation: 10, richtigkeit: 12, ausdruck: 8 };
  const keys = Object.keys(per);
  const pts = keys.map((key) => Math.floor((total * per[key]) / 45));
  let rest = total - pts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < keys.length && rest > 0; i += 1) {
    const add = Math.min(per[keys[i]] - pts[i], rest);
    pts[i] += add;
    rest -= add;
  }
  return {
    total,
    criteria: keys.map((key, i) => ({ key, points: pts[i], score: Math.round((pts[i] / per[key]) * 100) })),
    corrections: [{ original: 'Synthetisch', corrected: 'Synthetisch', explanation: 'Synthetisch' }],
    strengths: ['synthetisch'], priorities: ['synthetisch'], modelAnswer: 'Synthetisch.',
  };
}

const mod = (await import(pathToFileURL(path.join(TREE, 'public/js/mock-outcome.js')).href));
const engine = await import(pathToFileURL(path.join(TREE, 'public/js/engine.js')).href);
const assess = (o) => mod.assessMockWriting({ task: TASK, ...o });
// Candidate-neutral: B exports summarizeMockOutcome, A exports buildMockSummary.
const summarize = mod.summarizeMockOutcome || mod.buildMockSummary;

console.log(`probe tree: ${TREE}`);
console.log(`exports seen: ${Object.keys(mod).sort().join(', ')}\n`);

/* ------------------------------------------------------- M1 legitimate zero */

try {
  const text = longText();
  const analysis = engine.analyseWriting(text, TASK);
  const zero = await assess({ text, analysis, configured: true, grade: async () => validReply(0) });
  const missing = await assess({ text: '', analysis: engine.analyseWriting('', TASK), configured: true, grade: async () => validReply(45) });
  assert(zero.points === 0, `an assessed zero must keep points 0, got ${JSON.stringify(zero.points)}`);
  assert(missing.points === null, `missing writing must keep points null, got ${JSON.stringify(missing.points)}`);
  assert(zero.points !== missing.points, 'zero and missing must not collapse to one value');
  assert(zero.status !== missing.status, `zero status ${zero.status} must differ from missing status ${missing.status}`);
  record('M1-assessed-zero-is-not-missing', true,
    `zero: status=${zero.status} points=${JSON.stringify(zero.points)}; missing: status=${missing.status} points=${JSON.stringify(missing.points)} reason=${JSON.stringify(missing.reason)}`);
} catch (err) { record('M1-assessed-zero-is-not-missing', false, err.message); }

/* ------------------------------------------------- M2 empty / odd analysis */

try {
  const out = [];
  const blank = await assess({ text: '   \n\t  ', analysis: engine.analyseWriting('', TASK), configured: true, grade: async () => validReply(30) });
  out.push(['whitespace-only', blank.status, blank.points]);
  const noWords = await assess({ text: longText(), analysis: {}, configured: true, grade: async () => validReply(30) });
  out.push(['analysis-without-words', noWords.status, noWords.points]);
  const noAnalysis = await assess({ text: longText(), analysis: null, configured: true, grade: async () => validReply(30) });
  out.push(['analysis-null', noAnalysis.status, noAnalysis.points]);
  for (const [label, status, points] of out) {
    assert(status === 'unassessed', `${label} must stay unassessed, got ${status}`);
    assert(points === null, `${label} must keep points null, got ${JSON.stringify(points)}`);
  }
  record('M2-degenerate-inputs-stay-unassessed', true, out.map(([l, s, p]) => `${l}=${s}/${JSON.stringify(p)}`).join(' '));
} catch (err) { record('M2-degenerate-inputs-stay-unassessed', false, err.message); }

/* ------------------------------------------------ M3 malformed provider reply */

try {
  const text = longText();
  const analysis = engine.analyseWriting(text, TASK);
  const good = validReply(42);
  const shapes = {
    not_json_string: '{"total": 42, oops',
    null: null,
    undefined_reply: undefined,
    empty_object: {},
    total_only: { total: 42 },
    truncated_criteria: { ...good, criteria: good.criteria.slice(0, 2) },
    total_disagrees_with_criteria: { ...good, total: 45 },
    non_string_correction_field: { ...good, corrections: [{ original: 'a', corrected: 'b', explanation: 7 }] },
    points_above_maximum: { ...good, criteria: good.criteria.map((c, i) => (i === 0 ? { ...c, points: 99 } : c)) },
    duplicate_criterion: { ...good, criteria: [good.criteria[0], good.criteria[0], good.criteria[2], good.criteria[3]] },
    numeric_string_total: { ...good, total: '42' },
  };
  const bad = [];
  for (const [name, value] of Object.entries(shapes)) {
    const entry = await assess({ text, analysis, configured: true, grade: async () => value });
    if (entry.status !== 'unassessed' || entry.points !== null || entry.aiResult !== null) {
      bad.push(`${name}->${entry.status}/${JSON.stringify(entry.points)}`);
    }
    if (entry.text !== text) bad.push(`${name}->text lost`);
  }
  assert(bad.length === 0, `not fail-closed: ${bad.join(', ')}`);
  const ok = await assess({ text, analysis, configured: true, grade: async () => good });
  assert(ok.status === 'provisional' && ok.points === 42, `a valid reply must still be accepted (got ${ok.status}/${ok.points})`);
  record('M3-malformed-replies-fail-closed', true, `${Object.keys(shapes).length} malformed shapes -> unassessed/null, text kept; valid reply still accepted`);
} catch (err) { record('M3-malformed-replies-fail-closed', false, err.message); }

/* ------------------------------------------- M4 no pass/grade/readiness claim */

try {
  const text = longText();
  const analysis = engine.analyseWriting(text, TASK);
  const zeroEntry = await assess({ text, analysis, configured: true, grade: async () => validReply(0) });
  const unassessedEntry = await assess({ text, analysis, configured: false, grade: async () => validReply(45) });
  const results = [
    { partId: 'LV1', correct: 20, total: 25 },
    { partId: 'HV1', correct: 10, total: 15 },
    { partId: 'SB1', correct: 12, total: 20 },
    unassessedEntry,
    zeroEntry,
  ];
  // A whole-exam claim is a pass/fail, band, grade or readiness field. A per-part percentage
  // (`objective.byPart.*.percent`) or a per-criterion rubric score (`criteria[].score`) is that
  // part's own denominator, which the slice is required to show - so those are not claim keys.
  const FORBIDDEN_KEY = /^(pass|passed|bestanden|band|grade|grading|readiness|readinessPercent|prognose|note|gesamt|overall|result|verdict)$/i;
  const FORBIDDEN_SCOPED = /^(percent|percentage|score|band|note|grade)$/i;
  const FORBIDDEN_TEXT = /bestanden|notenband|gesamtnote|prognose|readiness/i;
  const summary = summarize(results, { objectiveMax: 180 });
  const keyHits = [];
  const textHits = [];
  const walk = (v, at = '$') => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        const scoped = /\.byPart\.|\bcriteria\[/.test(at);
        if (FORBIDDEN_KEY.test(k) || (!scoped && FORBIDDEN_SCOPED.test(k))) keyHits.push(`${at}.${k}=${JSON.stringify(child)}`);
        walk(child, `${at}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && FORBIDDEN_TEXT.test(v)) textHits.push(`${at}="${v.slice(0, 60)}"`);
  };
  walk(summary);
  assert(summary && summary.objective, 'summary.objective is required');
  assert(summary.objective.correct === 42 && summary.objective.total === 60, `objective must be objective-only (got ${summary.objective.correct}/${summary.objective.total})`);
  record('M4-summary-carries-no-whole-exam-claim', keyHits.length === 0 && textHits.length === 0,
    keyHits.length === 0 && textHits.length === 0
      ? `objective ${summary.objective.correct}/${summary.objective.total}; no forbidden key and no forbidden wording anywhere in the summary`
      : `forbidden keys: [${keyHits.join(' | ')}] forbidden wording: [${textHits.join(' | ')}]`);
} catch (err) { record('M4-summary-carries-no-whole-exam-claim', false, err.message); }

/* -------------------------------------------------- M5..M8 completion gate */

try {
  const gate = mod.createCompletionGate();
  let collect = 0; let commit = 0;
  const call = () => gate({ isCurrent: () => true, collect: async () => { collect += 1; return ['e']; }, commit: () => { commit += 1; } });
  const [a, b] = await Promise.all([call(), call()]);
  assert(collect === 1 && commit === 1, `timer+click race: collect=${collect} commit=${commit}`);
  assert(a === true && b === true, `both callers must see the single completion (got ${a}/${b})`);
  record('M5-duplicate-completion-commits-once', true, 'collect 1, commit 1, both callers see true');
} catch (err) { record('M5-duplicate-completion-commits-once', false, err.message); }

try {
  const gate = mod.createCompletionGate();
  let collect = 0; let commit = 0;
  const value = await gate({ isCurrent: () => false, collect: async () => { collect += 1; return ['e']; }, commit: () => { commit += 1; } });
  assert(value === false && collect === 0 && commit === 0, `stale completion: value=${value} collect=${collect} commit=${commit}`);
  record('M6-stale-completion-is-dropped', true, 'stale at call time: no collect, no commit, returns false');
} catch (err) { record('M6-stale-completion-is-dropped', false, err.message); }

try {
  const gate = mod.createCompletionGate();
  let current = true; let committed = false;
  const value = await gate({ isCurrent: () => current, collect: async () => { current = false; return ['old']; }, commit: () => { committed = true; } });
  assert(committed === false && value === false, `late result: committed=${committed} value=${value}`);
  record('M7-late-result-after-advance-is-dropped', true, 'in-flight result is dropped once the block advanced (returns false)');
} catch (err) { record('M7-late-result-after-advance-is-dropped', false, err.message); }

try {
  const gate = mod.createCompletionGate();
  let commits = 0;
  let firstRejected = false;
  try {
    await gate({ isCurrent: () => true, collect: async () => { throw new Error('synthetic collect failure'); }, commit: () => { commits += 1; } });
  } catch { firstRejected = true; }
  assert(firstRejected, 'a failing collect must reject, not silently succeed');
  assert(commits === 0, `a failing collect must not commit (commits=${commits})`);
  let retry = null;
  let retryRejected = null;
  try {
    retry = await gate({ isCurrent: () => true, collect: async () => ['recovered'], commit: () => { commits += 1; } });
  } catch (err) { retryRejected = err.message; }
  const recovered = retry === true && commits === 1;
  record('M8-block-recovers-after-a-failed-collect', recovered,
    recovered
      ? 'a second attempt after a throwing collect commits normally'
      : `the block is locked after a failed collect: the retry returned ${JSON.stringify(retry)}${retryRejected ? ` and rejected again with "${retryRejected}"` : ''}, commits=${commits} - the learner cannot finish that block without reloading`);
} catch (err) { record('M8-block-recovers-after-a-failed-collect', false, `probe error: ${err.message}`); }

/* ---------------------------------------------------- self-mutation (scratch) */

if (SELF_MUTATE === 'dead-new-mock-button') {
  const target = path.join(TREE, 'public/js/exam.js');
  const before = fs.readFileSync(target, 'utf8');
  const after = before
    .replace(/on\(actions\?\.querySelector\('\[data-new-mock\]'\)/, "on(el.querySelector('[data-new-mock]')")
    .replace(/on\(document\.querySelector\('\[data-new-mock\]'\)/, "on(el.querySelector('[data-new-mock]')");
  if (after === before) throw new Error('self-mutation matched nothing; the wiring form is unknown');
  fs.writeFileSync(target, after);
  console.log(`\n[self-mutation] rewired [data-new-mock] through #view instead of the action bar in ${target}`);
  console.log('[self-mutation] this file is a scratch copy; the reviewed trees are untouched\n');
}

/* ------------------------------------------------------------------ browser */

async function cdpClient(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evaluate = async (expr) => {
    // `expr` is always a template literal built from this file's own JS and from values serialized with
    // JSON.stringify (the synthetic constants above). No value from the page, the network or the tree under
    // test is ever concatenated into an evaluated expression; the only inputs are reviewer-authored fixtures.
    const r = await send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evaluate(`return !!(${expr});`)) return true;
      await sleep(150);
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const click = (sel) => evaluate(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true;`);
  return { send, evaluate, waitFor, click, errors, close: () => ws.close() };
}

function materialize(tree) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'wo02-verify-'));
  const skipTop = new Set(['.git', '.openclaw', 'node_modules', 'portable', 'data']);
  const skipName = new Set(['.env', 'progress.json']);
  fs.cpSync(tree, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(tree, src);
      if (!rel) return true;
      if (skipTop.has(rel.split(path.sep)[0])) return false;
      return !skipName.has(path.basename(src));
    },
  });
  const work = path.join(dest, '.openclaw', 'tmp');
  fs.mkdirSync(work, { recursive: true });
  const envPath = path.join(work, 'verify.env');
  const progressPath = path.join(work, 'verify-progress.json');
  fs.writeFileSync(envPath, '# reviewer probe: deliberately no provider key\n');
  fs.writeFileSync(progressPath, '{}\n');
  return { dest, envPath, progressPath };
}

if (WITH_BROWSER) {
  const chrome = (process.env.CHROME_PATH || '').trim();
  if (!chrome || !fs.existsSync(chrome)) {
    record('B0-browser-available', false, `set CHROME_PATH to a headless-capable browser (got ${JSON.stringify(chrome)})`);
  } else {
    const checkout = materialize(TREE);
    const debugPort = PORT + 1;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wo02-verify-prof-'));
    const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--mute-audio',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const server = spawn(process.execPath, ['server.js'], {
      cwd: checkout.dest,
      env: { ...process.env, B1PREP_ENV_FILE: checkout.envPath, B1PREP_PROGRESS_FILE: checkout.progressPath, B1PREP_FORCE_OFFLINE: '1', B1PREP_PORT: String(PORT) },
      stdio: 'ignore',
    });
    let cdp = null;
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i += 1) {
        try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch { await sleep(200); }
      }
      assert(up, `the disposable copy on 127.0.0.1:${PORT} never answered`);
      cdp = await cdpClient(debugPort);
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await cdp.waitFor(`document.querySelector('#view')`, 20000, 'app boot');
      await cdp.waitFor(`document.querySelector('[data-view="mock"]')`, 20000, 'nav');
      await cdp.click('[data-view="mock"]');
      await cdp.waitFor(`document.querySelector('[data-start-mock]')`, 15000, 'mock intro');
      await cdp.click('[data-start-mock]');
      await cdp.waitFor(`document.querySelector('#mock-parts')`, 40000, 'block 1');
      await cdp.click('[data-end-block]');
      await cdp.waitFor(`document.querySelector('#mock-parts') && document.body.innerText.includes('Hörverstehen')`, 25000, 'block 2');
      await cdp.click('[data-end-block]');
      await cdp.waitFor(`document.querySelector('#mock-writing')`, 25000, 'writing block');
      const brief = `${SYNTHETIC} Hallo, vielen Dank für deine Nachricht. Ich habe mich über die Einladung gefreut und habe drei Fragen. Zuerst: Wann beginnt der Kurs am Montag und wo findet er statt? Außerdem möchte ich wissen, ob ich die Materialien vorher bekomme. Ich kann an allen Terminen teilnehmen, weil ich meinen Urlaub schon verschoben habe. Bitte schick mir noch eine schriftliche Bestätigung mit der Adresse. Viele Grüße`;
      await cdp.evaluate(`const t = document.querySelector('#mock-writing'); t.focus(); t.value = ${JSON.stringify(brief)}; t.dispatchEvent(new Event('input', { bubbles: true })); return t.value.length;`);
      await cdp.click('[data-end-block]');
      await cdp.waitFor(`document.querySelector('[data-new-mock]')`, 30000, 'mock result');
      await sleep(400);
      const facts = await cdp.evaluate(`
        const t = document.body.innerText;
        const tc = document.body.textContent || '';
        const writingCard = [...document.querySelectorAll('.card')].find((c) => /^Schreiben\\b/m.test(c.querySelector('h3')?.textContent || ''));
        return {
          hasUnassessed: /nicht bewertet|unbewertet/i.test(t),
          hasBestandenQuestion: t.includes('Bestanden?'),
          anyBestanden: (t.match(/[^\\n]*[Bb]estanden[^\\n]*/g) || []),
          wholeExamDenominator: (t.match(/\\/\\s*(225|300)\\b/g) || []),
          objectiveOwnDenominator: /\\/\\s*180\\b/.test(t) || /\\/\\s*1[0-9]{2}\\b/.test(t),
          learnerTextVisible: t.includes(${JSON.stringify(SYNTHETIC)}),
          learnerTextInDom: tc.includes(${JSON.stringify(SYNTHETIC)}),
          learnerTextInOpenDom: [...document.querySelectorAll('.passage, p, div, td')]
            .filter((n) => n.textContent?.includes(${JSON.stringify(SYNTHETIC)}) && !n.closest('details:not([open])')).length > 0,
          writingCard: (writingCard?.innerText || '').slice(0, 400),
          writingCardHasNumber: /\\d+\\s*\\/\\s*45/.test(writingCard?.innerText || ''),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          fullText: t.slice(0, 2500),
        };
      `);
      record('B1-result-shows-writing-unassessed-and-keeps-the-text',
        facts.hasUnassessed && facts.learnerTextVisible && !facts.writingCardHasNumber,
        `unassessed label=${facts.hasUnassessed} textVisibleWithoutExpanding=${facts.learnerTextVisible} textPresentButHidden=${facts.learnerTextInDom && !facts.learnerTextVisible} writingCardShowsAPointValue=${facts.writingCardHasNumber}`);
      record('B1-result-makes-no-whole-exam-claim',
        !facts.hasBestandenQuestion && facts.wholeExamDenominator.length === 0,
        `"Bestanden?"=${facts.hasBestandenQuestion} whole-exam denominator=${JSON.stringify(facts.wholeExamDenominator)}; residual "Bestanden" wording=${JSON.stringify(facts.anyBestanden)}`);
      record('B1-objective-summary-has-its-own-denominator', facts.objectiveOwnDenominator,
        `a "N / <objective-max>" figure is rendered=${facts.objectiveOwnDenominator}`);
      record('B1-no-horizontal-overflow-at-1440', facts.scrollWidth <= facts.clientWidth + 8,
        `scrollWidth ${facts.scrollWidth} vs clientWidth ${facts.clientWidth}`);
      await cdp.click('[data-new-mock]');
      let restarted = false;
      try { await cdp.waitFor(`document.querySelector('[data-start-mock]')`, 12000, 'intro after restart'); restarted = true; } catch { restarted = false; }
      record('B2-new-mock-button-returns-to-the-intro', restarted,
        restarted ? 'clicking Neuer Mocktest really re-renders the mock intro' : 'clicking Neuer Mocktest did nothing');
      record('B3-console-clean', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | ') || 'no console errors or exceptions');
      console.log(`\n===== full result text as rendered (innerText, first 2500 chars) =====\n${facts.fullText}\n===== end =====\n`);
      console.log(`writing card as rendered:\n${facts.writingCard}\n`);
    } catch (err) {
      record('B-browser-run', false, err.message);
    } finally {
      try { cdp?.close(); } catch { /* ignore */ }
      try { server.kill('SIGTERM'); } catch { /* ignore */ }
      try { browser.kill(); } catch { /* ignore */ }
      await sleep(300);
      fs.rmSync(checkout.dest, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length} passed, ${failed.length} failed (reviewer probe, tree ${TREE})`);
console.log('NOTE  module + one headless page. No real device, keyboard, audio or live provider call.');
process.exit(failed.length === 0 ? 0 : 1);
