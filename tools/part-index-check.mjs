#!/usr/bin/env node
/**
 * PRACTICE-UI-01 (slice B) focused check — Prüfungsteile and Hören tiles.
 *
 * Offline and dependency-free; `--postgres` adds the route and evidence legs on a disposable database.
 *
 *   node tools/part-index-check.mjs
 *   OWNAPI_PG_ALLOW=1 OWNAPI_PG_DATABASE=<disposable> … node tools/part-index-check.mjs --postgres
 *
 * MUTATION PROOF (>=2 legs must fail; the copies live in %TEMP%, never in this worktree):
 *   node tools/part-index-check.mjs --parts=<copy of server/exam-parts.mjs>
 *   node tools/part-index-check.mjs --module=<copy of public/app/part-index.js>   (copy the whole public/ tree)
 *
 * WHAT IT PINS, AND WHY
 *  1. the assembler: the eight objective parts, item counts and HV playback from the blueprint payload, and
 *     a malformed blueprint refused rather than silently shortened;
 *  2. THE CITATION: the client's per-part constant equals BOTH cited sources (the listening package for
 *     items/playback, the reviewed draft for points). Amendment A6 allows a client constant only while it
 *     quotes those files, so an edit to either side must fail loudly here instead of drifting;
 *  3. the payload wins: a served `points`/`itemCount` value overrides the constant (forward compatibility);
 *  4. the tile set: eight tiles for Prüfungsteile, three (HV only) for the Hören host, exam order;
 *  5. own counts are COUNTS: rendered from attempts/correct, never a percentage, and an unknown count is
 *     "Angabe folgt" — not zero and not a section number attributed to a part;
 *  6. no per-set cards: no set id, no set-level control anywhere in the markup;
 *  7. D22: no prediction/forecast/probability/readiness vocabulary in any of the five locales;
 *  8. degradation: absent/failed parts payload renders no invented numbers;
 *  9. the stylesheet: tokens only, module-scoped, no extra breakpoint;
 * 10. (--postgres) the route serves all eight parts with the blueprint's numbers, refuses a mismatched or
 *     malformed examId, proves it does NOT come from the media-filtered objective catalogue, and runs
 *     READ ONLY; and `practice/progress` keeps its old shape while adding per-part counts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => {
  const flag = process.argv.find((value) => value.startsWith('--' + name + '='));
  const env = process.env['PART_INDEX_' + name.toUpperCase()];
  const value = flag ? flag.slice(name.length + 3) : env;
  return value ? path.resolve(value) : null;
};
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

const PARTS_PATH = arg('parts') ?? path.join(root, 'server', 'exam-parts.mjs');
const MODULE_PATH = arg('module') ?? path.join(root, 'public', 'app', 'part-index.js');
const CSS_PATH = arg('css') ?? path.join(root, 'public', 'app', 'part-index.css');

const partsModule = await import(pathToFileURL(PARTS_PATH).href);
const viewModule = await import(pathToFileURL(MODULE_PATH).href);
const { setLocale, getLocale } = await import(pathToFileURL(path.join(path.dirname(MODULE_PATH), '..', 'assets', 'i18n', 'core.js')).href);

const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];
let passed = 0; let failed = 0;
const leg = (name, run) => {
  try { run(); passed++; console.log('PASS  ' + name); }
  catch (error) { failed++; console.log('FAIL  ' + name + '  [' + String(error.message).slice(0, 240) + ']'); }
};
const aLeg = async (name, run) => {
  try { await run(); passed++; console.log('PASS  ' + name); }
  catch (error) { failed++; console.log('FAIL  ' + name + '  [' + String(error.message).slice(0, 240) + ']'); if (process.env.PART_INDEX_TRACE === '1') console.log(String(error.stack).split('\n').slice(0, 4).join('\n')); }
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI = { m002: 'Lesen', m003: 'Sprachbausteine', m004: 'Hören', m005: 'Schreiben' };
const uiText = (key) => UI[key] ?? key;
const textOf = (markup) => String(markup).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tilesOf = (markup) => [...String(markup).matchAll(/<li class="part-index-tile"[^>]*data-part="([A-Za-z0-9]+)"/g)].map((m) => m[1]);
const attrOf = (markup, family, attribute) => {
  const block = new RegExp('<li class="part-index-tile"[^>]*data-part="' + family + '"[^>]*>').exec(markup);
  const match = block && new RegExp(attribute + '="([^"]*)"').exec(block[0]);
  return match ? match[1] : null;
};

const blueprint = readJson('content/exams/telc-deutsch-b1/listening-package.json').blueprint;
const draft = readJson('docs/exam/telc-b1-written-draft.json');
const OBJECTIVE_FAMILIES = ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3'];

/* ------------------------------------------------------------ 1. the assembler */

leg('1 assembler: the eight objective parts, item counts and HV playback from the blueprint', () => {
  const parts = partsModule.blueprintParts(blueprint);
  const byFamily = new Map(parts.map((part) => [part.family, part]));
  for (const family of OBJECTIVE_FAMILIES) assert.ok(byFamily.has(family), 'missing ' + family);
  for (const family of ['HV1', 'HV2', 'HV3']) {
    assert.ok(byFamily.get(family).mediaRequired === true, family + ' must be mediaRequired');
    assert.ok(byFamily.get(family).playback, family + ' must carry a playback rule');
  }
  /* The blueprint's own numbers, read here independently of the assembler. */
  for (const section of blueprint.sections) for (const part of section.parts) {
    const served = byFamily.get(part.family);
    assert.ok(served, part.family + ' is declared in the blueprint but not served');
    assert.equal(served.itemCount, part.itemCount, part.family + ' itemCount');
    assert.equal(served.section, section.id, part.family + ' section');
    assert.deepEqual(served.playback, part.playback ? { practice: part.playback.practice, mock: part.playback.mock ?? null } : null, part.family + ' playback');
  }
  assert.deepEqual(parts.map((part) => part.family).slice(0, 8), OBJECTIVE_FAMILIES, 'exam order first, extra families after');
  assert.ok(!parts.some((part) => 'points' in part && part.points !== null), 'no points may be invented from a blueprint that has none');
});

leg('1b assembler: a malformed blueprint is refused, not silently shortened', () => {
  assert.throws(() => partsModule.blueprintParts(null), /exam_blueprint_invalid/);
  assert.throws(() => partsModule.blueprintParts({ sections: [] }), /exam_blueprint_invalid/);
  assert.throws(() => partsModule.blueprintParts({ sections: [{ id: 'LV', parts: [{ family: 'LV1' }] }] }), /exam_blueprint_invalid/);
  assert.throws(() => partsModule.blueprintParts({ sections: [{ id: 'LV', parts: [{ family: 'LV1', itemCount: 5 }, { family: 'LV1', itemCount: 5 }] }] }), /exam_blueprint_invalid/);
});

/* ------------------------------------------------- 2-3. the constant and its sources */

leg('2 citation: the client constant equals both cited sources (items, points, playback)', () => {
  const constant = new Map(viewModule.EXAM_PARTS.map((part) => [part.family, part]));
  const draftPoints = new Map();
  for (const section of draft.sections) for (const part of section.parts) {
    const id = String(part.id || '').replace(/^(lv|sb|hv|sa)-t(\d+)$/i, (all, kind, number) => kind.toUpperCase() + number);
    if (id) draftPoints.set(id, part.points);
  }
  const blueprintItems = new Map();
  for (const section of blueprint.sections) for (const part of section.parts) blueprintItems.set(part.family, part);
  const problems = [];
  for (const family of OBJECTIVE_FAMILIES) {
    const entry = constant.get(family);
    if (!entry) { problems.push(family + ': absent from EXAM_PARTS'); continue; }
    const cited = blueprintItems.get(family);
    if (!cited) { problems.push(family + ': absent from content/exams/telc-deutsch-b1/listening-package.json'); continue; }
    if (entry.itemCount !== cited.itemCount) problems.push(`${family}: EXAM_PARTS items ${entry.itemCount} != listening-package ${cited.itemCount}`);
    /*
     * REVIEW-PRACTICE-UI-01 F2: comparing only `practice` let a wrong `mock` allowance survive a mutation
     * (HV3 mock 99 passed 11/11). Both source files carry both numbers, so both are compared.
     */
    const citedPractice = cited.playback ? cited.playback.practice : null;
    const citedMock = cited.playback ? cited.playback.mock : null;
    if ((entry.playback?.practice ?? null) !== citedPractice) problems.push(`${family}: EXAM_PARTS practice plays ${entry.playback?.practice ?? null} != listening-package ${citedPractice}`);
    if ((entry.playback?.mock ?? null) !== citedMock) problems.push(`${family}: EXAM_PARTS mock plays ${entry.playback?.mock ?? null} != listening-package ${citedMock}`);
    const points = draftPoints.get(family);
    if (points === undefined) problems.push(family + ': absent from docs/exam/telc-b1-written-draft.json');
    else if (entry.points !== points) problems.push(`${family}: EXAM_PARTS points ${entry.points} != telc-b1-written-draft ${points}`);
  }
  assert.deepEqual(problems, [], problems.join(' | '));
  /* The subtest cards' own points, against the same draft. */
  const draftSectionPoints = new Map(draft.sections.map((section) => [section.id.toUpperCase(), section.points.max]));
  for (const subtest of viewModule.SUBTESTS) {
    const key = subtest.id === 'writing' ? 'SA' : subtest.id;
    assert.equal(subtest.points, draftSectionPoints.get(key), subtest.id + ' subtest points vs draft');
  }
});

leg('3 the payload wins: served values override the constant', () => {
  const model = viewModule.buildIndexModel({
    partsSource: 'payload',
    parts: [{ family: 'LV1', section: 'LV', part: 1, itemCount: 7, points: 31, playback: null },
      { family: 'HV2', section: 'HV', part: 2, itemCount: 11, points: 33, playback: { practice: 3, mock: 4 } }],
    counts: { source: 'parts', parts: new Map([['LV1', { attempts: 4, correct: 2 }]]), sections: null },
    filter: null,
  });
  const markup = viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model });
  assert.equal(attrOf(markup, 'LV1', 'data-items'), '7');
  assert.equal(attrOf(markup, 'LV1', 'data-points'), '31');
  assert.equal(attrOf(markup, 'HV2', 'data-plays'), '3');
  assert.ok(textOf(markup).includes('31'), 'the served points render');
  assert.ok(!textOf(markup).includes('25 Punkte'), 'the constant does not leak when the payload answers');
});

/* --------------------------------------------------------------- 4-6. tiles, counts */

const payloadParts = () => OBJECTIVE_FAMILIES.map((family, index) => ({
  family, section: family.slice(0, 2), part: Number(family.slice(2)), itemCount: 5 + index, points: 20 + index,
  playback: family.startsWith('HV') ? { practice: 1, mock: 2 } : null,
}));
/** A built model (the shape `indexMarkup` renders) from a synthetic payload. */
function payloadModel(extra = {}) {
  return viewModule.buildIndexModel({
    parts: payloadParts(),
    partsSource: 'payload',
    counts: { source: 'parts', parts: new Map([['LV1', { attempts: 4, correct: 3 }], ['HV1', { attempts: 0, correct: 0 }]]), sections: new Map([['LV', { attempts: 4, correct: 3 }]]) },
    filter: null,
    ...extra,
  });
}
setLocale('de');

leg('4 tile set: eight tiles in exam order; the Hören host shows HV only', () => {
  const all = viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: payloadModel() });
  assert.deepEqual(tilesOf(all), OBJECTIVE_FAMILIES);
  const hv = viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: payloadModel({ filter: 'HV' }) });
  assert.deepEqual(tilesOf(hv), ['HV1', 'HV2', 'HV3']);
  const cards = [...hv.matchAll(/data-subtest="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ['HV'], 'the Hören view shows one subtest card');
  assert.equal(viewModule.partFilterForHost({ id: 'hoeren-host' }), 'HV');
  assert.equal(viewModule.partFilterForHost({ id: 'part-index-host' }), null);
});

leg('5 own count is a count, and unknown is not zero', () => {
  const markup = viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: payloadModel() });
  assert.match(markup, /data-own-count="4\/3" data-attempts="4" data-correct="3"/);
  assert.ok(textOf(markup).includes('4 Aufgaben geübt · 3 richtig'), 'the count phrase renders');
  assert.ok(!/%|Prozent|percent|Wahrscheinlichkeit/i.test(textOf(markup)), 'no percentage or probability');
  assert.match(markup, /data-part="HV1"[^>]*>[\s\S]*?data-own-count="none"/, 'a part with zero attempts says so');
  assert.match(markup, /data-part="LV2"[^>]*>[\s\S]*?data-own-count="unknown"/, 'a part with no evidence says Angabe folgt');
  const sectionOnly = viewModule.buildIndexModel({
    parts: payloadParts(), partsSource: 'payload',
    counts: { source: 'sections', parts: null, sections: new Map([['LV', { attempts: 9, correct: 5 }]]) }, filter: null,
  });
  assert.equal(sectionOnly.tiles.find((tile) => tile.family === 'LV1').own, null, 'a section count is never attributed to a part');
  assert.ok(textOf(viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: sectionOnly })).includes('9 Aufgaben geübt · 5 richtig'), 'the section count still reaches the subtest card');
});

leg('6 no per-set cards: no set id and no set-level control in the markup', () => {
  const markup = viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: payloadModel() });
  for (const forbidden of ['set_id', 'data-set', 'data-open', 'data-version', 'telc-deutsch-b1.']) {
    assert.ok(!markup.includes(forbidden), 'markup must not carry ' + forbidden);
  }
  assert.equal(tilesOf(markup).length, 8, 'tiles are per part, not per set');
  assert.ok(!markup.includes('part-index-set'), 'no set card class');
});

/* ------------------------------------------------------------------- 7-9. safety */

const PREDICTION = ['prognose', 'vorhersage', 'wahrscheinlich', 'chance', 'schätzung', 'quote', 'bereitschaft',
  'erfolgsaussicht', 'aussicht', 'readiness', 'forecast', 'predict', 'prediction', 'probability', 'likelihood', 'odds',
  'прогноз', 'ймовірн', 'tahmin', 'olasılık', 'توقع', 'احتمال'];
const predictionPattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + PREDICTION.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');

leg('7 D22: no prediction, forecast, probability or readiness wording in five locales', () => {
  const previous = getLocale();
  const offenders = [];
  for (const locale of LOCALES) {
    setLocale(locale);
    const text = textOf(viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: payloadModel() }));
    const hit = predictionPattern.exec(text);
    if (hit) offenders.push(locale + ' -> ' + hit[0]);
  }
  setLocale(previous);
  assert.deepEqual(offenders, [], offenders.join(', '));
});

leg('7b D22: all five locales render, untranslated, with the tiles and the count', () => {
  const previous = getLocale();
  const titles = new Set();
  for (const locale of LOCALES) {
    setLocale(locale);
    const markup = viewModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: payloadModel() });
    const text = textOf(markup);
    assert.ok(!text.includes('Übersetzung nicht verfügbar') && !text.includes('Translation unavailable'), locale + ' leaked an unavailable message');
    assert.equal(tilesOf(markup).length, 8, locale + ' lost tiles');
    assert.ok(/data-own-count="4\/3"/.test(markup), locale + ' lost the own count');
    titles.add(textOf(/<h1 id="part-index-title">([\s\S]*?)<\/h1>/.exec(markup)[1]));
  }
  setLocale(previous);
  assert.equal(titles.size, LOCALES.length, 'five distinct titles');
});

await aLeg('8 degradation: absent, failed and count-less APIs never invent a number', async () => {
  const host = { id: 'part-index-host', innerHTML: '', hidden: false };
  const view = viewModule.createPartIndexView({ esc, uiText, examLanguage: 'de' });
  await view.mount(host);
  assert.deepEqual(Object.keys(view).sort(), ['mount', 'unmount']);
  assert.equal(tilesOf(host.innerHTML).length, 8, 'the documented constant still yields eight tiles');
  assert.match(host.innerHTML, /data-parts-source="documented"/);
  assert.match(host.innerHTML, /data-counts-source="unavailable"/);
  assert.ok(!/data-own-count="0\/0"/.test(host.innerHTML), 'an unavailable count is not rendered as zero');
  view.unmount();

  const failing = { id: 'part-index-host', innerHTML: '', hidden: false };
  const failedView = viewModule.createPartIndexView({
    esc, uiText, examLanguage: 'de',
    api: { examParts: { list: async () => ({ ok: false, status: 503, error: 'catalogue_unavailable' }) }, practice: { progress: async () => ({ ok: false, status: 503 }) } },
  });
  await failedView.mount(failing);
  assert.match(failing.innerHTML, /data-parts-source="unavailable"/);
  assert.equal(tilesOf(failing.innerHTML).length, 0, 'no tiles without a payload');
  assert.match(failing.innerHTML, /data-parts-empty/);
  assert.ok(!/\d+ Aufgaben geübt/.test(textOf(failing.innerHTML)), 'no count without evidence');
  assert.match(failing.innerHTML, /data-load-error/, 'the failure is visible');
  failedView.unmount();
  assert.equal(failing.innerHTML, '', 'unmount clears the host');

  const withPayload = { id: 'hoeren-host', innerHTML: '', hidden: false };
  const hvView = viewModule.createPartIndexView({
    esc, uiText, examLanguage: 'de',
    api: {
      examParts: { list: async () => ({ ok: true, status: 200, data: { parts: payloadParts() } }) },
      practice: { progress: async () => ({ ok: true, status: 200, data: { sections: [], parts: [{ family: 'HV2', attempts: 6, correct: 6 }] } }) },
    },
  });
  await hvView.mount(withPayload);
  assert.deepEqual(tilesOf(withPayload.innerHTML), ['HV1', 'HV2', 'HV3'], 'the host selects the filter');
  assert.match(withPayload.innerHTML, /data-own-count="6\/6"/);
  hvView.unmount();
});

leg('9 stylesheet: tokens only, module-scoped, no extra breakpoint', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const defined = new Set();
  for (const file of ['public/assets/design/hatoove.css', 'public/app/app.css']) {
    for (const match of read(file).matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) defined.add(match[1]);
  }
  const undefinedTokens = [...new Set([...css.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1]))].filter((token) => !defined.has(token));
  assert.deepEqual(undefinedTokens, [], 'undefined tokens: ' + undefinedTokens.join(', '));
  assert.ok(!/(?:^|[:\s(,])(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/m.test(css), 'no raw colour');
  for (const match of css.matchAll(/font-family\s*:\s*([^;]+)/gi)) assert.match(match[1], /var\(--(display|font)\s*[,)]/, 'un-tokenised font');
  const breakpoints = [...new Set([...css.matchAll(/max-width\s*:\s*(\d+)px/g)].map((m) => Number(m[1])))];
  assert.deepEqual(breakpoints.filter((px) => ![1100, 860].includes(px)), [], 'no breakpoint beyond the design system');
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@') || selector.startsWith('/*') || selector.includes('%')) continue;
    for (const one of selector.split(',')) assert.ok(one.trim().startsWith('.part-index'), 'module-scoped selector expected: ' + one.trim());
  }
});

/* ------------------------------------------------------------------- PostgreSQL */

if (process.argv.includes('--postgres')) {
  assert.equal(process.env.OWNAPI_PG_ALLOW, '1', 'OWNAPI_PG_ALLOW=1 required');
  for (const key of ['OWNAPI_PG_HOST', 'OWNAPI_PG_PORT', 'OWNAPI_PG_DATABASE', 'OWNAPI_PG_USER']) assert.ok(process.env[key], key + ' required');
  assert.ok(!['postgres', 'template0', 'template1'].includes(process.env.OWNAPI_PG_DATABASE));
  assert.notEqual(process.env.OWNAPI_PG_PORT, '55440', 'refuse the learner installation port');

  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const { createPostgresDatastore } = await import('../server/owned-postgres/adapter.mjs');
  const { createOwnedApi } = await import('../server/owned-api.mjs');
  const { randomUUID } = await import('node:crypto');

  let db = null;
  try {
    db = await createFixture();
    console.log(`Synthetic slice-B fixture: ${db.schema}`);
    const statements = [];
    const observed = { connect: async () => {
      const client = await db.learner.connect();
      const query = client.query.bind(client);
      client.query = (text, values) => { statements.push(typeof text === 'string' ? text : text?.text ?? ''); return query(text, values); };
      return client;
    } };
    const world = await createPostgresWorld({ fixture: db });
    const signup = await world.sessions.signUp({ name: 'Synthetic slice B', email: `part-index-${randomUUID()}@example.invalid`, password: 'synthetic-part-index-password' });
    const cookie = String(signup.setCookie).split(';')[0];
    const call = async (api, url) => {
      const response = await api.handle({ method: 'GET', path: url, headers: { cookie }, originChecked: true });
      return { status: response.status, data: response.body ? JSON.parse(response.body) : null };
    };
    /* A datastore on an OBSERVED learner pool, so the READ ONLY claim is evidence rather than a comment. */
    const observedApi = createOwnedApi({ datastore: createPostgresDatastore({ pool: observed, onCall: () => {} }), sessions: world.sessions, settings: world.settings });
    const get = (url) => call(world.api, url);
    /* Every scoped catalogue route needs the active preparation, exactly as the api client sends it. */
    const preparationList = await get('/api/v1/preparations');
    const prepId = (preparationList.data?.preparations ?? []).find((row) => row.state === 'active')?.id
      ?? (preparationList.data?.preparations ?? [])[0]?.id;
    assert.ok(prepId, 'the fixture must provision one preparation');
    const scope = '?preparationId=' + encodeURIComponent(prepId);
    const scoped = (url) => get(url + (url.includes('?') ? '&' : '?') + 'preparationId=' + encodeURIComponent(prepId));

    await aLeg('10 postgres: the route serves all eight parts with the blueprint numbers, HV included', async () => {
      const response = await scoped('/api/v1/exam-parts');
      assert.equal(response.status, 200);
      assert.equal(response.data.parts.length >= 8, true, 'eight parts: ' + response.data.parts.length);
      const byFamily = new Map(response.data.parts.map((part) => [part.family, part]));
      for (const family of OBJECTIVE_FAMILIES) assert.ok(byFamily.has(family), 'route is missing ' + family);
      /* The fixture publishes its OWN blueprint; the route must equal THAT, not a repository file. */
      const fixtureBlueprint = (await db.admin.query(`SELECT payload FROM "${db.schema}".exam_blueprint LIMIT 1`)).rows[0]?.payload;
      assert.ok(fixtureBlueprint, 'the fixture must publish a blueprint');
      const expected = new Map(partsModule.blueprintParts(fixtureBlueprint).map((part) => [part.family, part]));
      for (const family of OBJECTIVE_FAMILIES) {
        const wanted = expected.get(family);
        assert.ok(wanted, 'the fixture blueprint must declare ' + family);
        const served = byFamily.get(family);
        assert.equal(served.itemCount, wanted.itemCount, family + ' itemCount vs the fixture blueprint');
        assert.equal(served.section, wanted.section, family + ' section');
        assert.equal(served.mediaRequired, wanted.mediaRequired, family + ' mediaRequired');
        assert.deepEqual(served.playback, wanted.playback, family + ' playback vs the fixture blueprint');
      }
      /* The media filter is exactly why HV was missing from the objective catalogue; prove the two differ. */
      const sets = await scoped('/api/v1/objective-sets');
      assert.equal(sets.status, 200);
      assert.ok(!(sets.data ?? []).some((row) => row.media_required === true || String(row.family).startsWith('HV')), 'the objective catalogue really excludes HV');
      assert.ok(byFamily.has('HV1'), 'and the parts route really includes it');
      assert.ok(!('points' in (response.data.parts[0] ?? {}) ) || response.data.parts[0].points === null, 'no points are invented server-side');
    });

    await aLeg('10b postgres: a malformed or mismatching examId is refused', async () => {
      assert.equal((await scoped('/api/v1/exam-parts?examId=NOT-VALID')).status, 422);
      assert.equal((await scoped('/api/v1/exam-parts?examId=' + encodeURIComponent('nope-not-an-exam'))).status, 422);
      assert.equal((await scoped('/api/v1/exam-parts?examId=' + encodeURIComponent('telc-deutsch-b1'))).status, 200, 'the preparation\'s own exam is accepted');
      /* Without a preparation context the scoped route refuses, exactly as its neighbours do. */
      assert.equal((await get('/api/v1/exam-parts')).status, 422);
    });

    await aLeg('10c postgres: the parts read is READ ONLY and takes no write path', async () => {
      statements.length = 0;
      const response = await call(observedApi, '/api/v1/exam-parts' + scope);
      assert.equal(response.status, 200);
      const sql = statements.join('\n');
      assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/, 'the parts read must open a read-only snapshot');
      assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(sql), 'the parts read must not write: ' + sql.slice(0, 200));
    });

    await aLeg('11 postgres: progress keeps its old shape and adds per-part counts', async () => {
      const preparation = (await db.admin.query(`SELECT owner_id, exam_id FROM "${db.schema}".learner_preparation WHERE id = $1`, [prepId])).rows[0];
      assert.ok(preparation, 'the fixture must hold the preparation row');
      const owner = preparation.owner_id; const examId = preparation.exam_id;
      /* The write path is owner-scoped by FORCE RLS, so the session setting must be bound first — the same
         transaction shape the adapter's `settle` uses. */
      const client = await db.migration.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        await client.query(`DELETE FROM "${db.schema}".item_evidence WHERE owner_id = $1 AND preparation_id = $2`, [owner, prepId]);
        for (const [family, item, correct] of [['LV1', 'a1', true], ['LV1', 'a2', false], ['LV2', 'a3', true]]) {
          await client.query(
            `INSERT INTO "${db.schema}".item_evidence (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct, preparation_id)
             VALUES (gen_random_uuid(), $1, $2, $3, 'v1', $4, $5, $6, '"a"'::jsonb, $7, $8)`,
            [owner, examId, 'telc-deutsch-b1.' + family.toLowerCase() + '.01', item, family, family.slice(0, 2), correct, prepId]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      const progress = await scoped('/api/v1/practice/progress');
      assert.equal(progress.status, 200);
      for (const key of ['totals', 'sections']) assert.ok(key in progress.data, 'existing member missing: ' + key);
      assert.ok(Array.isArray(progress.data.parts), 'parts must be an array');
      const byFamily = new Map(progress.data.parts.map((row) => [row.family, row]));
      assert.deepEqual([...byFamily.keys()].sort(), ['LV1', 'LV2'], 'families are the parts that have evidence');
      assert.equal(byFamily.get('LV1').attempts, 2);
      assert.equal(byFamily.get('LV1').correct, 1);
      assert.equal(byFamily.get('LV2').attempts, 1);
      assert.equal(byFamily.get('LV2').correct, 1);
      const lv = progress.data.sections.find((row) => row.section === 'LV');
      assert.equal(lv.attempts, 3, 'the section count is unchanged');
      assert.ok(!progress.data.parts.some((row) => row.family === 'LV3'), 'a part with no evidence is absent, not zero');
    });

    process.env.B1PREP_CONTENT_MODE = 'internal-preview';
    const partsReadSource = await import('../server/exam-parts.mjs');
    await aLeg('11b postgres: the served parts equal the assembler on the published blueprint', () => {
      const response = partsReadSource.blueprintParts(blueprint);
      assert.equal(response.length >= 8, true);
      assert.deepEqual(OBJECTIVE_FAMILIES.filter((family) => !response.some((part) => part.family === family)), []);
    });
  } finally {
    if (db) await db.cleanup();
  }
}

console.log(`\n${passed} passed, ${failed} failed  (${path.basename(PARTS_PATH)}, ${path.basename(MODULE_PATH)}, ${path.basename(CSS_PATH)})`);
if (failed) process.exit(1);
