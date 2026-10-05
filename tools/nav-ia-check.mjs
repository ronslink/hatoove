/*
 * NAV-IA-CHECK — the focused gate for MIRROR-B1PREP-01 slice A (NAV-01).
 *
 * It asserts the contract's information architecture rather than describing it: the three sidebar groups
 * and their ten entries in order, that every entry resolves to a view the router knows, that every view
 * has a section element, that the retired routes still resolve through the alias layer, that every sidebar
 * label exists in all five locale objects, and that the "Ihre Vorbereitung" card is restricted to Heute.
 *
 * Paths are resolved from this file, so running a copy of the tool beside a mutated copy of the client
 * proves the legs: mutate a group, an entry, a locale key or the preparation-card rule in the copy and the
 * corresponding leg must fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shellMessages } from '../public/assets/i18n/shell-messages.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/app/index.html');
const app = read('../public/app/app.js');
const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];

/* The sidebar the contract fixes, in the contract's order. */
const CONTRACT_GROUPS = [
  { key: 'lernweg', label: 'm393', entries: ['heute', 'ueben', 'wortschatz', 'fehler'] },
  { key: 'pruefungstraining', label: 'm397', entries: ['pruefungsteile', 'hoeren', 'schreiben', 'probepruefung'] },
  { key: 'werkzeuge', label: 'm401', entries: ['nachschlagen', 'einstellungen'] },
];
const CONTRACT_ENTRY_COUNT = CONTRACT_GROUPS.reduce((sum, group) => sum + group.entries.length, 0);

const navStart = html.indexOf('<nav class="nav"');
assert.ok(navStart >= 0, 'the sidebar <nav class="nav"> is missing from index.html');
const navEnd = html.indexOf('</nav>', navStart);
assert.ok(navEnd > navStart, 'the sidebar <nav> is not closed');
const sidebar = html.slice(navStart, navEnd);

/** The object literal a `const NAME = { … }` declaration in app.js holds. */
function objectLiteral(name) {
  const start = app.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} is missing from app.js`);
  const end = app.indexOf('};', start);
  assert.ok(end > start, `${name} is not a closed object literal`);
  return app.slice(start, end);
}
/** `key: 'value'` pairs of such a literal, quoted keys included. */
function pairs(name) {
  return [...objectLiteral(name).matchAll(/(?:'([^']+)'|([a-z_]+)):\s*'([^']*)'/g)].map((m) => [m[1] || m[2], m[3]]);
}

const viewTitles = pairs('VIEW_TITLES');
const viewAliases = pairs('VIEW_ALIAS');
const navGroups = pairs('NAV_GROUP');
const groupLabels = pairs('GROUP_LABEL');
const deepLinks = pairs('DEEP_LINKS');

const sectionIds = new Set([...html.matchAll(/id="(view-[a-z-]+)"/g)].map((m) => m[1]));
const views = new Set(viewTitles.map(([key]) => key));
const sectionOf = (view) => view;

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`ok ${legs}. ${name}`); };

/* ---------------------------------------------------------------- the sidebar itself */

leg('the sidebar holds exactly the three contract groups in order', () => {
  const groups = [...sidebar.matchAll(/<div class="nav-group" data-nav-group="([a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(groups, CONTRACT_GROUPS.map((group) => group.key));
});

leg('each group carries its label key and its entries in contract order', () => {
  const chunks = sidebar.split(/<div class="nav-group" data-nav-group="/).slice(1);
  assert.equal(chunks.length, CONTRACT_GROUPS.length, 'a group is missing or an extra one was added');
  CONTRACT_GROUPS.forEach((group, index) => {
    const chunk = chunks[index];
    const label = /class="kicker nav-label"[\s\S]*?data-i18n="shell\.(m\d+)"/.exec(chunk);
    assert.ok(label, `group ${group.key} has no label`);
    assert.equal(label[1], group.label, `group ${group.key} is labelled ${label[1]}, expected ${group.label}`);
    const entries = [...chunk.matchAll(/<a href="#\/([a-z-]+)" data-view="([a-z-]+)"><svg/g)].map((m) => m[2]);
    assert.deepEqual(entries, group.entries, `group ${group.key} lists the wrong entries`);
  });
});

leg('the sidebar lists ten entries and no more', () => {
  const entries = [...sidebar.matchAll(/<a href="#\/([a-z-]+)" data-view="[a-z-]+"><svg/g)].map((m) => m[1]);
  assert.equal(entries.length, CONTRACT_ENTRY_COUNT, `the sidebar lists ${entries.length} entries`);
});

/* ---------------------------------------------------------------- routes resolve */

leg('every sidebar entry resolves to a view the router knows', () => {
  for (const view of [...sidebar.matchAll(/data-view="([a-z-]+)"><svg/g)].map((m) => m[1])) {
    assert.ok(views.has(view), `nav entry #/${view} has no VIEW_TITLES key`);
  }
});

leg('every view owns a #view-* section of its own', () => {
  for (const [view] of viewTitles) {
    assert.ok(sectionIds.has(`view-${view}`), `view ${view} has no #view-${view} section`);
  }
  assert.ok(!/const VIEW_SECTION/.test(app), 'VIEW_SECTION came back: a view must own its section');
});

leg('the retired routes stay resolvable, and none of them is a sidebar entry', () => {
  const aliasOf = (view) => (viewAliases.find(([key]) => key === view) || [])[1];
  assert.equal(aliasOf('fortschritt'), 'verlauf', 'Fortschritt must fold into Heute as the Verlauf sub-page');
  assert.equal(aliasOf('woerterbuch'), 'wortschatz', 'Wörterbuch must become Wortschatz');
  assert.equal(aliasOf('verlauf'), undefined, 'verlauf is canonical and must not alias itself away');
  for (const [from, to] of viewAliases) {
    assert.ok(!views.has(from), `the retired view ${from} is still routable on its own`);
    assert.ok(views.has(to), `the alias ${from} points at unknown view ${to}`);
  }
  assert.ok(deepLinks.some(([from, to]) => from === 'nachschlagen/satzbau' && to === 'satzbau'),
    'the #/nachschlagen/satzbau deep link is missing');
  assert.ok(/info\.view === 'abschnitt' && !info\.runId/.test(app), 'the bare saved-runs route no longer becomes Probeprüfung');
  for (const kept of ['lesen', 'sprachbausteine', 'abschnitt', 'satzbau', 'checkout', 'mehr']) {
    assert.ok(views.has(kept), `the deep link ${kept} stopped resolving`);
  }
  const listed = new Set([...sidebar.matchAll(/data-view="([a-z-]+)"><svg/g)].map((m) => m[1]));
  for (const retired of ['fortschritt', 'woerterbuch', 'satzbau', 'abschnitt', 'lesen', 'sprachbausteine']) {
    assert.ok(!listed.has(retired), `${retired} is still a sidebar entry`);
  }
});

leg('the breadcrumb carries a group for every sidebar entry', () => {
  for (const group of CONTRACT_GROUPS) {
    assert.ok(groupLabels.some(([key, label]) => key === group.key && label === group.label),
      `GROUP_LABEL has no ${group.key} → ${group.label}`);
    for (const entry of group.entries) {
      const mapped = (navGroups.find(([view]) => view === entry) || [])[1];
      assert.equal(mapped, group.key, `${entry} is not mapped to group ${group.key} for the breadcrumb`);
    }
  }
  assert.ok(/crumb-group-name/.test(html) && /crumb-root/.test(html), 'the breadcrumb group markup is missing');
});

/* ---------------------------------------------------------------- copy and the shell */

leg('every sidebar label exists in all five locales', () => {
  const labelKeys = [...sidebar.matchAll(/data-i18n="shell\.(m\d+)"/g)].map((m) => m[1]);
  assert.ok(labelKeys.length >= CONTRACT_ENTRY_COUNT, 'the sidebar is missing label keys');
  for (const key of labelKeys) {
    for (const locale of LOCALES) {
      const value = shellMessages[locale]?.[key];
      assert.ok(typeof value === 'string' && value.trim().length > 0, `shell.${key} is empty or missing in ${locale}`);
    }
  }
});

leg('the new navigation labels are translated, not copied from German', () => {
  const newKeys = CONTRACT_GROUPS.flatMap((group) => [group.label, ...group.entries]).length;
  assert.ok(newKeys >= 10, 'the contract groups did not parse');
  for (const key of ['m393', 'm394', 'm395', 'm396', 'm397', 'm398', 'm399', 'm400', 'm401']) {
    const values = LOCALES.map((locale) => shellMessages[locale]?.[key]);
    assert.ok(values.every((value) => typeof value === 'string' && value.length > 0), `shell.${key} is incomplete`);
    assert.equal(new Set(values).size, values.length, `shell.${key} repeats one string across locales`);
  }
});

leg('the "Ihre Vorbereitung" card is restricted to Heute', () => {
  assert.ok(/id="preparation-context"/.test(html), 'the preparation card has no id to target');
  assert.ok(/preparationCard\.hidden = view !== 'heute'/.test(app),
    'app.js no longer hides the preparation card outside Heute');
});

/*
 * REVIEW-NAV-01 R1, fixed 5 October 2026. §4.1 moves the writing-feedback allowance to Schreiben. The only
 * allowance element is #preparation-credits, and restricting the card to Heute would otherwise have made
 * the allowance *less* reachable than before the slice. This leg pins the move, so a later refactor cannot
 * quietly undo it by putting the card back or by dropping the refresh.
 */
leg('the writing-feedback allowance lives with the Schreiben view, not the card', () => {
  const schreiben = html.slice(html.indexOf('id="view-schreiben"'), html.indexOf('id="view-fehler"'));
  assert.ok(/id="preparation-credits"/.test(schreiben), 'the allowance is not inside #view-schreiben');
  const card = html.slice(html.indexOf('id="preparation-context"'), html.indexOf('id="view-heute"'));
  assert.ok(!/id="preparation-credits"/.test(card), 'the allowance is still inside the preparation card');
  assert.ok(/guard\(refreshCredits\(\)\)/.test(app), 'route() no longer refreshes the allowance');
  assert.ok(!/<a[^>]+href="#\/abschnitt"/.test(html), 'a link still targets the retired bare #/abschnitt');
});

leg('the shell mounts module views through the frozen interface', () => {
  assert.ok(/const MODULE_VIEWS = \{/.test(app), 'MODULE_VIEWS is missing');
  assert.ok(/createLibraryView/.test(app) && /createMockIntroView/.test(app),
    'a module factory from docs/contracts §4.2 is missing');
  assert.ok(/id="library-host"/.test(html) && /id="mock-intro-host"/.test(html),
    'a module host element is missing from index.html');
  assert.ok(/host\.hidden = true;[\s\S]{0,200}return false;/.test(app),
    'mountModule no longer falls back to the interim view');
});

console.log(`Nav IA check passed: ${legs} legs.`);
