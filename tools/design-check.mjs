#!/usr/bin/env node
/**
 * Design-language consistency — RETARGETED at the shell, 2 October 2026.
 *
 * WHAT CHANGED AND WHY. This check used to read `public/styles.css`, the retired Certa client's
 * stylesheet. That file goes with the SPA (SPA-RETIRE 2), so keeping the check alive by keeping the
 * stylesheet alive would have been exactly the wrong trade — an implementation kept to feed a check.
 * The design language did not disappear when the client did; it moved:
 *
 *   * `public/assets/design/hatoove.css` — the PINNED design system (tokens, dark theme, breakpoints,
 *     base elements). Read-only: its digests are the reviewed contract, so this check READS it.
 *   * `public/app/app.css` — the shell's OWN layer, the only stylesheet we may edit.
 *
 * The rules that survive are the ones that still describe a real failure:
 *
 *   D1 NO RAW COLOUR IN A RULE. One hard-coded #fff is how dark mode breaks silently.
 *   D2 NO RAW BRAND FACE. The system has two faces, reached through `--display` / `--font`.
 *   D3 EVERY TOKEN USED IS DEFINED. `var(--orange-dark)` with a typo in it renders as nothing at all,
 *      and nothing anywhere reports it. This is the rule worth having most: it is silent by nature.
 *   D4 THE PINNED SYSTEM STILL SUPPLIES WHAT THE SHELL RELIES ON, and still carries the dark theme and
 *      the reduced-motion block.
 *   D5 THE SHELL'S OWN BREAKPOINT IS THE SYSTEM'S BREAKPOINT (1100/860 px), not a second opinion.
 *   D6 THE SHELL IS THE VIEW HOST. Every route the router knows has a `#view-*` element. A route
 *      without a view is a blank screen that a `hidden` toggle cannot fix.
 *   D7 ONE NAVIGATION PATTERN. Navigation is `<a data-view="…">` and the router marks `aria-current`;
 *      a second pattern is how two "current" items appear at once.
 *
 * WARN, not FAIL, for two deliberate exceptions: the monospace stack on `<code>` (a code sample is not
 * brand copy) and inline corner radii (a pill is legitimately `999px`). A check that cries wolf is worse
 * than no check — this programme has been bitten more often by wrong checks than by wrong files.
 *
 * The form-language advisory that used to live here (a `language` reference in the exam modules) is
 * retired WITH those modules; its property — the interface is not translated by the explanation-language
 * setting — is now asserted in a browser, where it can actually fail: `tools/app-browser-check.mjs` L32.
 *
 * WHAT IT DOES NOT PROVE: that a view looks right, that a touch target is 44 px, or that a real phone
 * behaves. Those need rendered evidence (`tools/app-browser-check.mjs`, 390 px, both themes) and a real
 * device, which remains an open gate.
 *
 * Usage: node tools/design-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED = path.join(ROOT, 'public', 'assets', 'design', 'hatoove.css');
const APP_CSS = path.join(ROOT, 'public', 'app', 'app.css');
const SHELL_HTML = path.join(ROOT, 'public', 'app', 'index.html');
const SHELL_JS = path.join(ROOT, 'public', 'app', 'app.js');

const results = [];
const record = (name, ok, detail, level = 'FAIL') => {
  results.push({ name, ok, level });
  console.log(`${ok ? (level === 'WARN' ? 'WARN' : 'PASS') : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const fail = (name, detail) => record(name, false, detail, 'FAIL');
const pass = (name, detail) => record(name, true, detail);
const warn = (name, detail) => record(name, true, detail, 'WARN');

const read = (file) => fs.readFileSync(file, 'utf8');
const css = read(APP_CSS);
const pinned = read(PINNED);
const html = read(SHELL_HTML);
const js = read(SHELL_JS);

const definedTokens = (source) => new Set([...source.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedTokens = (source) => new Set([...source.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1]));

/* ------------------------------------------------------------------- D1/D2 */

const lines = css.split(/\r?\n/);
const rawColour = [];
const rawFace = [];
const inlineRadius = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\s*(\/\*|\*)/.test(line)) continue; // a comment is not a declaration
  const value = line.includes(':') ? line.split(':').slice(1).join(':') : '';
  const isTokenDefinition = /^\s*--[A-Za-z0-9-]+\s*:/.test(line);
  if (!isTokenDefinition && /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value)) {
    rawColour.push(`line ${i + 1}: ${line.trim()}`);
  }
  const face = line.match(/font-family\s*:\s*([^;]+)/i);
  if (face) {
    const declared = face[1].trim();
    // A fallback is allowed: `var(--display, inherit)` is still the design face with a safety net.
    const tokenised = /var\(--(display|font)\s*[,)]/.test(declared);
    const monospace = /monospace|ui-monospace|SFMono|Menlo|Consolas/i.test(declared);
    if (!tokenised && !monospace) rawFace.push(`line ${i + 1}: ${declared}`);
    else if (monospace && !tokenised) warn('D2b monospace exception', `line ${i + 1}: ${declared}`);
  }
  if (/border(?:-[a-z]+)?-radius\s*:\s*[^;]*?\b\d+(?:\.\d+)?(?:px|rem|em)/i.test(line)) inlineRadius.push(i + 1);
}
if (rawColour.length) fail('D1 no raw colour in a rule', rawColour.join(' | '));
else pass('D1 no raw colour in a rule', `${lines.length} lines; every colour comes from a token`);
if (rawFace.length) fail('D2 no raw font family in a rule', rawFace.join(' | '));
else pass('D2 fonts come from the design faces', 'no un-tokenised brand face declared');
if (inlineRadius.length) warn('D2c inline corner radius', `${inlineRadius.length} rule(s), first at line ${inlineRadius[0]}`);

/* ---------------------------------------------------------------------- D3 */

const defined = definedTokens(pinned);
for (const token of definedTokens(css)) defined.add(token);
const undefinedTokens = [...usedTokens(css)].filter((token) => !defined.has(token));
if (undefinedTokens.length) fail('D3 every token used is defined', `undefined: ${undefinedTokens.join(', ')}`);
else pass('D3 every token used is defined', `${usedTokens(css).size} token(s) resolved against the pinned system`);

/* ---------------------------------------------------------------------- D4 */

const REQUIRED_IN_PINNED = ['--orange', '--orange-dark', '--peach', '--ink', '--paper', '--canvas', '--card',
  '--line', '--muted', '--red', '--red-bg', '--display', '--font', '--r-sm', '--r'];
const missingPinned = REQUIRED_IN_PINNED.filter((token) => !defined.has(token));
if (missingPinned.length) fail('D4 the pinned system supplies the shell tokens', `missing: ${missingPinned.join(', ')}`);
else pass('D4 the pinned system supplies the shell tokens', `${REQUIRED_IN_PINNED.length} required token(s) present`);
if (/prefers-color-scheme\s*:\s*dark/.test(pinned)) pass('D4b the pinned system carries a dark theme', 'prefers-color-scheme block present');
else fail('D4b the pinned system carries a dark theme', 'no prefers-color-scheme block in the pinned stylesheet');
/*
 * D4c — MOTION. The pinned `.btn` transitions background and transform in 150 ms, and the design system
 * carries no `prefers-reduced-motion` block at all. It is pinned, so the neutraliser belongs in the
 * shell's own layer, and the honest assertion is about the UNION: if the system animates, this layer
 * must switch it off for a learner who asked for less motion. A rule asserting the block exists in the
 * pinned file would be unpassable by design; a rule asserting nothing would be a check in name only.
 */
const pinnedMotion = [...pinned.matchAll(/(transition|animation)\s*:\s*([^;}]+)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
const reducedBlock = /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
if (pinnedMotion.length === 0) {
  pass('D4c motion is honoured', 'the pinned system declares no transition or animation');
} else if (!reducedBlock) {
  fail('D4c motion is honoured', `the pinned system animates (${pinnedMotion.length} declaration(s)) and the shell adds no prefers-reduced-motion block`);
} else if (!/transition-duration|animation-duration|transition\s*:\s*none|animation\s*:\s*none/.test(reducedBlock[1])) {
  fail('D4c motion is honoured', 'the prefers-reduced-motion block does not neutralise transition or animation duration');
} else {
  pass('D4c motion is honoured', `${pinnedMotion.length} pinned motion declaration(s) neutralised by the shell's reduce block`);
}

/* ---------------------------------------------------------------------- D5 */

const BREAKPOINTS = [1100, 860];
const missingBreakpoints = BREAKPOINTS.filter((px) => !new RegExp(`max-width\\s*:\\s*${px}px`).test(pinned));
if (missingBreakpoints.length) fail('D5 the system keeps its breakpoints', `missing ${missingBreakpoints.join(', ')}px in the pinned stylesheet`);
else pass('D5 the system keeps its breakpoints', `${BREAKPOINTS.join('/')}px present in the pinned stylesheet`);
const appBreakpoints = [...css.matchAll(/max-width\s*:\s*(\d+)px/g)].map((m) => Number(m[1]));
const offSystem = appBreakpoints.filter((px) => !BREAKPOINTS.includes(px));
if (offSystem.length) fail('D5b the shell uses the system breakpoint', `app.css adds ${offSystem.join(', ')}px, which is a second opinion`);
else pass('D5b the shell uses the system breakpoint', appBreakpoints.length ? `app.css: ${appBreakpoints.join('/')}px` : 'no breakpoint of its own');

/* ---------------------------------------------------------------------- D6 */

const titles = (js.match(/const VIEW_TITLES = \{([\s\S]*?)\};/) || [])[1] || '';
const routes = [...titles.matchAll(/(?:^|\s)([a-z]+)\s*:/g)].map((m) => m[1]);
const declaredViews = [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]);
const routesWithoutView = routes.filter((key) => !declaredViews.includes(key));
if (!routes.length) fail('D6 the shell is the view host', 'no VIEW_TITLES map found in app.js');
else if (routesWithoutView.length) fail('D6 every route has a view', `no #view-* element for: ${routesWithoutView.join(', ')}`);
else pass('D6 every route has a view', `${routes.length} route(s), ${declaredViews.length} view section(s), all matched`);

/* ---------------------------------------------------------------------- D7 */

const destinations = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
const unknownDestinations = [...new Set(destinations)].filter((key) => !routes.includes(key));
if (unknownDestinations.length) fail('D7 navigation names real routes', `data-view points at: ${unknownDestinations.join(', ')}`);
else pass('D7 navigation names real routes', `${new Set(destinations).size} destination(s), all routable`);
const navsWithoutViews = [...html.matchAll(/<nav[^>]*>([\s\S]*?)<\/nav>/g)]
  .map((m) => m[1])
  .filter((body) => !/data-view=/.test(body));
if (navsWithoutViews.length) fail('D7b one navigation pattern', `${navsWithoutViews.length} <nav> with no data-view links`);
else pass('D7b one navigation pattern', 'every nav destination is an <a data-view>');
if (/aria-current/.test(js)) pass('D7c the router marks the current view', 'aria-current is set from the route');
else fail('D7c the router marks the current view', 'app.js never sets aria-current');

/* ------------------------------------------------------------------- report */

const failed = results.filter((r) => !r.ok).length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n${results.length - failed} passed, ${failed} failed${warns ? `, ${warns} warning(s)` : ''}\n`);
console.log('NOTE stylesheet structure and shell wiring only. It does not prove a view looks right, that a');
console.log('     touch target is 44 px, or that a real phone behaves. Rendered evidence comes from');
console.log('     tools/app-browser-check.mjs (390 px, both themes); the real-device gate stays open.\n');
process.exit(failed ? 1 : 0);
