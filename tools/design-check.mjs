/**
 * Design-language consistency check (DESIGN-LANGUAGE.md).
 *
 * Ron, 2026-10-01: "we need to ensure we have a consistent page design or a design language
 * that is consistent throughout the app and is mobile friendly." A design language that is only
 * described in a document is not enforced, so this check makes its central rules mechanical:
 *
 *   1. NO RAW COLOUR IN A RULE. Every colour in public/styles.css must come from a custom
 *      property; `--name: value` declarations are the only place a literal may appear. One
 *      hard-coded #fff in a component rule is how dark mode breaks silently.
 *   2. NO RAW FONT FAMILY IN A RULE. The design language has exactly three faces.
 *   3. REQUIRED TOKENS EXIST, and the dark theme overrides the surface ones.
 *   4. MOBILE BREAKPOINTS EXIST (1100/860/600/480 px) and prefers-reduced-motion is honoured.
 *   5. THE SHELL IS THE VIEW HOST, and navigation uses the one .nav-item pattern.
 *
 * Inline corner radii are reported as WARN, not FAIL: `border-radius: 0 3px 3px 0` is
 * legitimate, and a check that cries wolf is worse than no check - this programme has been
 * bitten eight times by wrong checks rather than by wrong artifacts. The debt stays visible.
 *
 * What this does NOT prove: that a view looks right, that a touch target is 44 px, or that a
 * real phone behaves. Those need rendered evidence at 390 px in both themes; the real-device
 * gate stays open.
 *
 * Usage: node tools/design-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(ROOT, 'public', 'styles.css');
const APP_PATH = path.join(ROOT, 'public', 'js', 'app.js');
const SHELL_PATH = path.join(ROOT, 'public', 'js', 'shell.js');

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
/** Advisory only: a non-zero inline radius rather than one from --radius. */
const RADIUS_RE = /border(?:-[a-z]+)?-radius\s*:\s*[^;]*?\b\d+(?:\.\d+)?(?:px|rem|em)/i;
const FONT_RE = /font-family\s*:/i;
const CUSTOM_PROP_RE = /^\s*--[A-Za-z0-9-]+\s*:/;

/**
 * A `font-family` declaration that NAMES a family instead of using a token.
 *
 * The first version of this check matched every `font-family:` line, so it reported the 22
 * rules that already say `var(--serif|sans|mono)` as debt alongside the 4 `@font-face`
 * descriptors - 26 "raw" declarations, of which 0 were raw. A rule consuming a face must use
 * a token, so a bare `var(--serif)` passes; a `@font-face` block is the definition of the
 * face and CSS forbids `var()` there, so those descriptors are structural. Blank the
 * @font-face blocks (keeping line numbers) and then flag only a declaration whose value is
 * not one of the three type tokens.
 */
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;
const TOKEN_FONT_RE = /font-family\s*:\s*var\(--(?:serif|sans|mono)\)/i;
const fontFaceBlanked = (css) => css.replace(FONT_FACE_RE, (block) => block.replace(/[^\n]/g, ' '));

/** Tokens DESIGN-LANGUAGE.md section 2 promises, so a view can style itself from tokens alone. */
const REQUIRED_TOKENS = [
  'bg', 'line', 'fg', 'sidebar-bg',
  'accent', 'accent-soft', 'on-accent', 'brand-disc', 'gold', 'gold-soft',
  'good', 'good-soft', 'warn', 'warn-soft', 'bad', 'bad-soft',
  'radius', 'radius-sm', 'shadow-sm', 'shadow',
  'serif', 'sans', 'mono',
];

const REQUIRED_BREAKPOINTS = [1100, 860, 600, 480];

const checks = [];
const warnings = [];
const check = (name, run) => checks.push({ name, run });
const read = (file) => fs.readFileSync(file, 'utf8');
const nonTokenLines = (css) => css.split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => !CUSTOM_PROP_RE.test(line));

check('no-raw-colour-outside-a-token', () => {
  const offenders = nonTokenLines(read(CSS_PATH)).filter(({ line }) => HEX_RE.test(line));
  if (offenders.length) {
    throw new Error(`${offenders.length} hard-coded colour(s) outside a custom property, first at line ${offenders[0].number}: ${offenders[0].line.trim()}`);
  }
});

check('no-raw-font-family-outside-a-token', () => {
  const offenders = nonTokenLines(fontFaceBlanked(read(CSS_PATH)))
    .filter(({ line }) => FONT_RE.test(line) && !TOKEN_FONT_RE.test(line));
  if (offenders.length) {
    throw new Error(`${offenders.length} raw font family(ies) in a rule, first at line ${offenders[0].number}: ${offenders[0].line.trim()}`);
  }
});

check('every-required-token-is-declared', () => {
  const css = read(CSS_PATH);
  const declared = new Set([...css.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const missing = REQUIRED_TOKENS.filter((token) => !declared.has(`--${token}`));
  if (missing.length) throw new Error(`tokens promised by DESIGN-LANGUAGE.md are missing: ${missing.join(', ')}`);
});

check('dark-theme-overrides-the-surface-tokens', () => {
  const css = read(CSS_PATH);
  const marker = css.indexOf('prefers-color-scheme: dark');
  if (marker === -1) throw new Error('no prefers-color-scheme: dark block; dark mode is part of the design language');
  const dark = css.slice(marker);
  for (const token of ['--bg', '--fg', '--line']) {
    if (!dark.includes(`${token}:`)) throw new Error(`the dark block does not override ${token}`);
  }
});

check('raw-radius-usage-is-reported-not-failed', () => {
  const offenders = nonTokenLines(read(CSS_PATH)).filter(({ line }) => RADIUS_RE.test(line));
  if (offenders.length) {
    warnings.push(`${offenders.length} inline corner radius(es) outside a token, first at line ${offenders[0].number}: ${offenders[0].line.trim()}`);
  }
});

check('mobile-breakpoints-are-present', () => {
  const found = [...read(CSS_PATH).matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
  const missing = REQUIRED_BREAKPOINTS.filter((width) => !found.includes(width));
  if (missing.length) throw new Error(`missing responsive breakpoint(s): ${missing.map((w) => `${w}px`).join(', ')} (found: ${found.join(', ')})`);
});

check('reduced-motion-is-honoured', () => {
  if (!read(CSS_PATH).includes('prefers-reduced-motion')) {
    throw new Error('no prefers-reduced-motion block; DESIGN-LANGUAGE.md requires it');
  }
});

check('every-view-is-registered-in-the-shell', () => {
  const registered = [...read(APP_PATH).matchAll(/shell\.registerView\(\s*'([^']+)'/g)].map((m) => m[1]);
  if (registered.length < 15) {
    throw new Error(`only ${registered.length} views registered; the app has more, so this check is not measuring what it claims`);
  }
  const duplicates = [...new Set(registered.filter((id, index) => registered.indexOf(id) !== index))];
  if (duplicates.length) throw new Error(`view(s) registered twice: ${duplicates.join(', ')}`);
});

check('navigation-uses-the-one-nav-pattern', () => {
  const source = read(APP_PATH);
  if (!source.includes('nav-item')) throw new Error('app.js does not reference .nav-item; the navigation pattern is not the shell one');
  const entries = [...source.matchAll(/id:\s*'([a-z0-9-]+)',\s*label:\s*'[^']+',\s*ico:/g)].map((m) => m[1]);
  if (entries.length < 8) throw new Error(`only ${entries.length} navigation entries found in the expected shape`);
});

check('the-shell-is-the-view-host', () => {
  const shell = read(SHELL_PATH);
  for (const marker of ['registerView', 'render']) {
    if (!shell.includes(marker)) throw new Error(`shell.js does not implement '${marker}'; the shell is not the view host`);
  }
});

export async function runDesignChecks() {
  warnings.length = 0;
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error) });
    }
  }
  return { ok: results.every((r) => r.ok), results, warnings: [...warnings] };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('design-check.mjs');
if (invokedDirectly) {
  const report = await runDesignChecks();
  for (const result of report.results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n  ${result.detail}`}`);
  }
  for (const warning of report.warnings) console.log(`WARN ${warning}`);
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  console.log('NOTE stylesheet structure only. It does not prove a view looks right, that a touch target is 44 px,');
  console.log('     or that a real phone behaves. 390 px rendered evidence is still required; the real-device gate stays open.');
  process.exitCode = failed ? 1 : 0;
}