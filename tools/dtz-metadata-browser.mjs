/** Selected-exam display regression in the existing isolated S6 source fixture. */
export async function verifyDtzMetadata({ c, base, prep, fixture, availableVersion, api, nav, ready, viewport, theme, shot, overflow, clickSel }) {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message + ': ' + JSON.stringify(actual));
  const path = route => base + '/app/#/prep/' + prep.id + '/' + route;
  const openIndex = async () => {
    await nav(c, path('pruefungsteile'));
    await ready(c);
    await c.waitFor("document.querySelectorAll('#part-index-host [data-part]').length === 9", 15000);
  };
  const openIntro = async () => {
    await nav(c, path('probepruefung'));
    await ready(c);
    await c.waitFor("document.querySelector('#mock-intro-host [data-mock-intro-start]') && document.querySelectorAll('#mock-intro-host tbody [data-mock-intro-block]').length === 3", 15000);
  };
  const locale = async language => {
    await c.waitFor("document.querySelector('#header-language') && !document.querySelector('#header-language').disabled", 12000);
    await c.evaluate(`const input=document.querySelector('#header-language');input.value=${JSON.stringify(language)};input.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    await c.waitFor(`document.documentElement.lang===${JSON.stringify(language)} && !document.querySelector('#header-language').disabled`, 12000);
    assert((await api(c, '/api/v1/settings')).data.settings.language === language, 'Locale must be saved on the synthetic account');
  };
  const layout = async (label, selector) => {
    for (const width of [1440, 390, 320]) {
      await viewport(c, width, width === 1440 ? 900 : 844, width !== 1440);
      await theme(c, width === 320 ? 'dark' : 'light');
      await shot(c, label + '-' + width, selector);
      if (label === 'dtz-metadata-parts-de' && width === 320) {
        const headingsFit = await c.evaluate("return [...document.querySelectorAll('#part-index-host .card-head h2')].every(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).fontSize) * 1.5);");
        assert(headingsFit, 'The unknown-points badge must not split the German section heading');
        await shot(c, 'dtz-metadata-tiles-top-320', '#part-index-host .part-index-parts');
        await shot(c, 'dtz-metadata-tiles-LV5-320', '#part-index-host [data-part="LV5"]');
      }
      const size = await overflow(c);
      assert(size.offenderCount === 0 && size.scrollWidth <= size.innerWidth + 2, 'Metadata layout overflow: ' + JSON.stringify(size));
    }
    await viewport(c, 1440, 900, false);
    await theme(c, 'light');
  };

  const response = await api(c, '/api/v1/exam-parts?preparationId=' + prep.id);
  assert(response.status === 200 && response.data.exam_id === 'dtz-a2-b1', 'Selected DTZ metadata identity');
  assert(response.data.release_version === availableVersion && response.data.blueprint_version === fixture.blueprint.version, 'Metadata must identify the selected published blueprint');
  const expected = fixture.blueprint.sections.flatMap(section => section.parts.filter(part => part.family !== 'writing').map(part => ({ family: part.family, items: part.itemCount, plays: part.playback?.mock ?? null })));
  same(expected.map(part => part.family), ['HV1', 'HV2', 'HV3', 'HV4', 'LV1', 'LV2', 'LV3', 'LV4', 'LV5'], 'Discriminating complete DTZ fixture');
  same(response.data.parts.map(part => part.family), expected.map(part => part.family), 'Server must preserve all released DTZ parts in package order');
  same(response.data.time_groups, fixture.blueprint.timeGroups, 'Metadata timing is the published blueprint timing');
  const forms = (await api(c, '/api/v1/mock-forms?preparationId=' + prep.id)).data.forms;
  same(forms[0].time_groups, fixture.blueprint.timeGroups, 'Mock schedule is the validated released form schedule');

  await openIndex();
  const inspectTiles = async () => {
    const rendered = await c.evaluate("return [...document.querySelectorAll('#part-index-host [data-part]')].map(el=>({family:el.dataset.part,items:Number(el.dataset.items),plays:el.dataset.plays ? Number(el.dataset.plays) : null,points:el.dataset.points,heading:el.querySelector('h3').textContent}));");
    same(rendered.map(({ family, items, plays }) => ({ family, items, plays })), expected, 'Rendered DTZ facts must equal its own package');
    assert(rendered.every(part => part.points === '' && part.heading.trim() && !/partSkill|undefined|null/.test(part.heading)), 'No telc points or untranslated family labels on DTZ');
    const sections = await c.evaluate("return [...document.querySelectorAll('#part-index-host [data-subtest]')].map(el=>el.dataset.subtest);");
    same(sections, fixture.blueprint.sections.map(section => section.id), 'DTZ section cards omit telc language elements');
  };
  await inspectTiles();
  await layout('dtz-metadata-parts-de', '#part-index-host');
  for (const family of ['LV5', 'HV4']) {
    await clickSel(c, '[data-part-open="' + family + '"]');
    await c.waitFor(`document.querySelector('[data-part-runner][data-runner-family="${family}"][data-runner-phase="answering"]')`, 15000);
    await shot(c, 'dtz-metadata-open-' + family, '[data-part-runner]');
    // Opening a part composes into the same route. Navigate away before returning to its index.
    await clickSel(c, 'a[data-view="heute"]');
    await c.waitFor("document.querySelector('#view-heute') && !document.querySelector('#view-heute').hidden", 15000);
    await openIndex();
  }
  const inspectIntro = async () => {
    const rows = await c.evaluate("return [...document.querySelectorAll('#mock-intro-host tbody [data-mock-intro-block]')].map(el=>({id:el.dataset.mockIntroBlock,minutes:Number(el.dataset.minutes),points:el.dataset.points}));");
    same(rows.map(({ id, minutes }) => ({ id, minutes })), fixture.blueprint.timeGroups.map(group => ({ id: group.id, minutes: group.seconds / 60 })), 'Rendered DTZ schedule must be 25/45/30 in its own order');
    assert(rows.every(row => row.points === ''), 'DTZ intro must not invent telc point weights');
    const summary = await c.evaluate("return {total:document.querySelector('#mock-intro-host tfoot [data-mock-intro-block]')?.dataset.minutes,note:document.querySelector('#mock-intro-host [data-mock-intro-total-note]')?.textContent,rule:document.querySelector('#mock-intro-host [data-mock-intro-rule]')?.textContent};");
    assert(Number(summary.total) === 100 && !summary.note && !/60\s*%/.test(summary.rule || ''), 'No telc 150-minute/300-point/60-percent statement on DTZ');
  };
  await openIntro();
  await inspectIntro();
  await layout('dtz-metadata-intro-de', '#mock-intro-host');
  for (const language of ['en', 'uk', 'ar', 'tr', 'de']) {
    await locale(language);
    await openIndex();
    await inspectTiles();
    await viewport(c, 320, 844, true);
    const direction = await c.evaluate("return document.querySelector('#part-index-host [data-part-index]').dir;");
    assert(direction === (language === 'ar' ? 'rtl' : 'ltr'), 'Selected interface direction');
    await shot(c, 'dtz-metadata-parts-' + language + '-320', '#part-index-host');
    const size = await overflow(c);
    assert(size.offenderCount === 0 && size.scrollWidth <= size.innerWidth + 2, 'Localized DTZ tiles overflow');
    await openIntro();
    await inspectIntro();
    await shot(c, 'dtz-metadata-intro-' + language + '-320', '#mock-intro-host');
    const introSize = await overflow(c);
    assert(introSize.offenderCount === 0 && introSize.scrollWidth <= introSize.innerWidth + 2, 'Localized DTZ introduction overflows');
  }
  const telc = (await api(c, '/api/v1/preparations')).data.preparations.find(row => row.exam_id === 'telc-deutsch-b1');
  assert(telc, 'Existing telc preparation is required for the switching discriminator');
  await c.evaluate(`const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(telc.id)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
  await c.waitFor(`document.querySelector('#preparation-picker').value===${JSON.stringify(telc.id)} && !document.querySelector('#preparation-picker').disabled`, 15000);
  await nav(c, base + '/app/#/prep/' + telc.id + '/pruefungsteile');
  await ready(c);
  await c.waitFor("document.querySelector('#part-index-host [data-part=LV1]') && !document.querySelector('#part-index-host [data-part=LV5]')", 15000);
  const telcTile = await c.evaluate("const tile=document.querySelector('#part-index-host [data-part=LV1]');return {items:tile.dataset.items,points:tile.dataset.points};");
  assert(telcTile.items === '5' && telcTile.points === '25', 'Switching back must restore telc facts: ' + JSON.stringify(telcTile));
  await layout('dtz-metadata-switched-telc', '#part-index-host');
  await c.evaluate(`const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(prep.id)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
  await c.waitFor(`document.querySelector('#preparation-picker').value===${JSON.stringify(prep.id)} && !document.querySelector('#preparation-picker').disabled`, 15000);
  await openIndex();
  await inspectTiles();
  await openIntro();
  await inspectIntro();
  await viewport(c, 1440, 900, false);
  await theme(c, 'light');
}
