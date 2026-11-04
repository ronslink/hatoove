import { fixturePreparation, scopedFixtureRoute } from './browser-preparation-fixtures.mjs';
/**
 * REVIEW-UX browser evidence — invoked only by app-browser-check's disposable Compose stack.
 *
 * WHAT THIS PROVES, and why it is a separate vehicle.
 *
 *   1. THE WHOLE CHOICE IS ON THE SCREEN, NOT IN A TOOLTIP. The objective answer tiles used to render
 *      `label.slice(0, 40)` with the full option text in `title=`. On an LV3 situation — twelve ads the
 *      learner has to compare against one another — every tile was cut at the same column and the only
 *      way to read one was to hover it, which a phone cannot do. The legs below read the option text
 *      BACK out of the DOM and compare it, character for character, to the authored label the API
 *      served; they then measure the tile at desktop, 390 px and 320 px: the text wraps (more than one
 *      rendered line for a long label), nothing is clipped, the tile stays inside its card and the page
 *      gains no horizontal overflow.
 *
 *   2. CURRENT PART AND WRITING CONTROLS OPEN THEIR SERVED IDENTITIES. The redesign retired per-set
 *      catalogue buttons. Reading now opens one released part; the actual /practice/next response pins
 *      the set/version and the rendered feedback context must match it. The return-to-index control
 *      follows the checked set. Writing retains exact task/version/rubric bindings on its own catalogue.
 *
 *   3. A DOUBLE CLICK DOES NOT CREATE TWO DRAFTS. The writing leg dispatches two clicks in the same
 *      task and then asks the SERVER how many open attempts exist for that task: at most one more than
 *      before, and the attempt's own task/version/rubric binding is the one on the button.
 *
 * HONEST LIMITS, stated rather than implied.
 *   * Headless Chromium with emulated mobile metrics is NOT an iPhone or an Android device. It proves
 *     layout and rendered text; it does not replace a real-device keyboard, audio or Safari check, and
 *     it cannot see a font fallback that only that device has. Same limit as app-browser-check's.
 *   * This slice creates NO SQL fixture: no `query()` call is made and `query` is accepted only for
 *     harness parity. It uses the authored content the stack already serves. If the longest authored
 *     option is shorter than the wrap threshold the first leg FAILS and names the length it found, so
 *     the coordinator can supply a fixture rather than have the gap pass silently.
 *   * The legs run against a synthetic `browser-<n>@example.test` account on a disposable port; a
 *     persistent 4300/55440 install is refused, because the writing leg leaves (and then cleans up)
 *     a draft.
 *
 * No standalone entry point: the caller owns the stack, the account and the browser.
 */
import { launchBrowser, connectToPage, sleep } from './cdp.js';

/** The learner-facing option labels an objective payload offers, per family. Mirrors app.js's objectiveForm. */
function optionLabels(family, payload = {}) {
  const out = [];
  const push = (list, textKey) => {
    for (const entry of list || []) {
      const label = String(entry?.[textKey] ?? entry?.text ?? entry?.word ?? '');
      if (label) out.push({ id: String(entry.id ?? entry.n), label });
    }
  };
  if (family === 'LV1') push(payload.headlines, 'text');
  if (family === 'LV3') push(payload.ads, 'text');
  if (family === 'SB2') push(payload.bank, 'word');
  if (family === 'LV2') for (const q of payload.questions || []) for (const [id, label] of Object.entries(q.options || {})) out.push({ id: String(id), label: String(label) });
  if (family === 'SB1') for (const g of payload.gaps || []) for (const [id, label] of Object.entries(g.options || {})) out.push({ id: String(id), label: String(label) });
  return out;
}

/** A long authored option is what the wrapping legs need; below this the layout claim is untested. */
const LONG_OPTION_FLOOR = 60;

export async function verifyReviewUx({ base, email, password, freePort, record, shot, viewport, theme, nav, setInputs, clickSel, overflow, query }) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
      || !origin.port || ['4300', '55440'].includes(origin.port) || origin.origin !== base
      || !/^browser-\d+@example\.test$/.test(email)) {
    throw new Error('REVIEW-UX requires app-browser-check disposable ports and a synthetic browser-<n>@example.test account');
  }
  if (typeof query !== 'undefined' && query !== null && typeof query !== 'function') {
    throw new Error('REVIEW-UX: the harness query callback must be a function when supplied');
  }

  const port = await freePort();
  const browser = await launchBrowser(port);
  let cdp;
  const checks = async (name, run) => {
    try {
      await run();
    } catch (error) {
      record(name, false, error.message);
    }
  };

  try {
    cdp = await connectToPage(port);
    await cdp.send('Network.enable');
    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');
    await nav(cdp, base + '/signin');
    await setInputs(cdp, { 'si-email': email, 'si-password': password });
    await clickSel(cdp, '#si-submit');
    await cdp.waitFor("location.pathname.startsWith('/app') && document.querySelector('#account-email')?.textContent.includes('@')", 15000);
    const cookie = (await cdp.send('Network.getCookies', { urls: [base] })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const prepResponse=await fetch(base+'/api/v1/preparations',{headers:{cookie:cookie}});
    if (!prepResponse.ok) throw new Error('synthetic preparation lookup failed');
    const preparationId=fixturePreparation(await prepResponse.json());
    const request = async (route, method = 'GET', body) => {
      const res = await fetch(base + scopedFixtureRoute(route, preparationId), {
        method,
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, data: await res.json() };
    };

    /* ---------------------------------------------------- the fixture this run needs */

    const catalogue = await request('/api/v1/objective-sets');
    if (catalogue.status !== 200 || !Array.isArray(catalogue.data) || !catalogue.data.length) {
      throw new Error('REVIEW-UX precondition: the synthetic stack serves no objective catalogue');
    }
    const tasks = await request('/api/v1/tasks?family=writing');
    if (tasks.status !== 200 || !Array.isArray(tasks.data) || !tasks.data.length) {
      throw new Error('REVIEW-UX precondition: the synthetic stack serves no writing task');
    }

    const identity = (id, version) => JSON.stringify([id, String(version)]);
    const apiVersions = new Set(catalogue.data.map(set => identity(set.set_id, set.version)));
    const apiBinding = new Map(tasks.data.map(task => [task.task_id, task]));
    let target, served;

    const openReading = async () => {
      await nav(cdp, base + '/app/#/heute');
      await nav(cdp, base + '/app/#/lesen');
      await cdp.waitFor("document.querySelector('#lesen-host [data-part-open=LV3]')", 15000);
    };
    const openWriting = async () => {
      await nav(cdp, base + '/app/#/heute');
      await nav(cdp, base + '/app/#/schreiben');
      await cdp.waitFor("document.querySelector('#skill-schreiben [data-write]')", 15000);
    };
    const openPart = async () => {
      const mark = cdp.events.length;
      await clickSel(cdp, '#lesen-host [data-part-open=LV3]');
      await cdp.waitFor("document.querySelector('#lesen-host [data-runner-phase=answering] select[data-answer-item]')", 15000);
      const responses = cdp.events.slice(mark).filter(event => event.method === 'Network.responseReceived'
        && new URL(event.params.response.url).pathname === '/api/v1/practice/next');
      if (responses.length !== 1) throw new Error('Expected one current part response, got ' + responses.length);
      const body = await cdp.send('Network.getResponseBody', { requestId: responses[0].params.requestId });
      served = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body);
      if (served.family !== 'LV3' || !apiVersions.has(identity(served.set?.set_id, served.set?.version))) {
        throw new Error('The part response is not an exact released LV3 catalogue identity');
      }
      const exact = await request('/api/v1/objective-sets/' + encodeURIComponent(served.set.set_id)
        + '?version=' + encodeURIComponent(served.set.version));
      if (exact.status !== 200) throw new Error('The exact served objective version cannot be read');
      target = optionLabels('LV3', exact.data.payload).sort((a, b) => b.label.length - a.label.length)[0];
      if (!target || target.label.length < LONG_OPTION_FLOOR) {
        throw new Error('The served LV3 fixture has no option reaching the ' + LONG_OPTION_FLOOR + '-character wrap floor');
      }
      return cdp.evaluate("const host=document.querySelector('#lesen-host [data-part-runner]');"
        + "const context=JSON.parse(host.dataset.feedbackContext);const rect=host.getBoundingClientRect();"
        + "return {context,visible:rect.height>0,onScreen:rect.top>=-4&&rect.top<innerHeight*.9,"
        + "indexGone:!document.querySelector('#lesen-host [data-part-index]'),"
        + "items:host.querySelectorAll('select[data-answer-item]').length};");
    };
    const returnToIndex = async () => {
      // The current runner returns to its index after completing the set, through its visible action.
      await cdp.evaluate("for(const control of document.querySelectorAll('#lesen-host select[data-answer-item]')) {"
        + "control.value=[...control.options].find(option=>option.value).value;control.dispatchEvent(new Event('change',{bubbles:true}));}return true;");
      await clickSel(cdp, '#lesen-host [data-runner-evaluate]');
      await cdp.waitFor("document.querySelector('#lesen-host [data-runner-phase=review] [data-runner-action=index]')", 15000);
      await clickSel(cdp, '#lesen-host [data-runner-action=index]');
      await cdp.waitFor("document.querySelector('#lesen-host [data-part-open=LV3]')", 15000);
      return cdp.evaluate("const button=document.querySelector('#lesen-host [data-part-open=LV3]');"
        + "return {control:button.getBoundingClientRect().height>=44,formGone:!document.querySelector('#lesen-host [data-part-runner]')};");
    };

    await checks('RUX1 current reading parts and writing controls match released catalogue identities', async () => {
      await openReading();
      const parts = await cdp.evaluate("return [...document.querySelectorAll('#lesen-host [data-part-open]')]"
        + ".map(button=>({family:button.dataset.partOpen,label:button.textContent.trim(),visible:button.getBoundingClientRect().height>0}));");
      const expected = [...new Set(catalogue.data.filter(set => set.section === 'LV').map(set => set.family))].sort();
      await openWriting();
      const writes = await cdp.evaluate("return [...document.querySelectorAll('#skill-schreiben [data-write]')]"
        + ".map(button=>({id:button.dataset.write,version:button.dataset.version,rubric:button.dataset.rubric,"
        + "rubricVersion:button.dataset.rubricVersion,label:button.textContent.trim(),visible:button.getBoundingClientRect().height>0}));");
      const bindings = writes.every(button => {
        const task = apiBinding.get(button.id);
        return task && String(task.version) === button.version && String(task.rubric_id) === button.rubric
          && String(task.rubric_version) === button.rubricVersion && button.label && button.visible;
      });
      record('RUX1 current reading parts and writing controls match released catalogue identities',
        parts.length > 0 && JSON.stringify(parts.map(part => part.family).sort()) === JSON.stringify(expected)
          && parts.every(part => part.label && part.visible) && writes.length === tasks.data.length && bindings,
        JSON.stringify({ parts: parts.map(part => part.family), expected, writingControls: writes.length, bindings }));
    });

    await checks('RUX2 a current part opens the exact served version and replaces its index', async () => {
      await openReading();
      const state = await openPart();
      record('RUX2 a current part opens the exact served version and replaces its index',
        state.visible && state.onScreen && state.indexGone && state.items > 0
          && state.context.setId === served.set.set_id && String(state.context.version) === String(served.set.version),
        JSON.stringify({ ...state, setId: served.set.set_id, version: served.set.version }));
      await shot(cdp, 'review-ux-objective-open-desktop');
    });

    // Long authored options live in the visible option bank; the corresponding labelled native selects
    // provide keyboard access. This replaces the retired truncated answer-button implementation.
    const measureOption = async () => cdp.evaluate(
      "const item=document.querySelector('#lesen-host [data-bank-key='+CSS.escape(" + JSON.stringify(target.id) + ")+']');"
      + "const label=item?.querySelector('span:nth-child(2)');if(!label)return {missing:true};"
      + "const bank=item.closest('[data-layout-bank]');const rect=label.getBoundingClientRect(),bankRect=bank.getBoundingClientRect();"
      + "const range=document.createRange();range.selectNodeContents(label);"
      + "const controls=[...document.querySelectorAll('#lesen-host select[data-answer-item]')];"
      + "return {text:label.textContent,title:label.getAttribute('title'),visible:rect.height>0,"
      + "lines:new Set([...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>Math.round(r.top))).size,"
      + "clipped:label.scrollWidth>label.clientWidth+1,right:rect.right,bankRight:bankRect.right,viewport:innerWidth,"
      + "keyboardChoice:controls.some(control=>control.tabIndex>=0&&!control.disabled&&[...control.options].some(option=>option.value==="
      + JSON.stringify(target.id) + "&&option.textContent.includes(" + JSON.stringify(target.label) + ")))};");
    const matches = (probe, page, wrapped = false) => !probe.missing && probe.text === target.label
      && probe.visible && probe.keyboardChoice && probe.title === null && !probe.clipped
      && probe.right <= probe.viewport + 1 && probe.right <= probe.bankRight + 1
      && page.offenderCount === 0 && (!wrapped || probe.lines >= 2);

    await checks('RUX3 full authored option text is visible and keyboard-selectable without clipping', async () => {
      const probe = await measureOption(), page = await overflow(cdp);
      record('RUX3 full authored option text is visible and keyboard-selectable without clipping',
        matches(probe, page), JSON.stringify({ ...probe, expectedLength: target.label.length, overflow: page.offenderCount }));
    });

    await checks('RUX4 the checked set returns to a visible part index', async () => {
      const state = await returnToIndex();
      record('RUX4 the checked set returns to a visible part index', state.control && state.formGone, JSON.stringify(state));
      await shot(cdp, 'review-ux-catalogue-return-desktop');
    });

    await checks('RUX5 writing opens its exact binding and a double click cannot create two drafts', async () => {
      await openWriting();
      const button = await cdp.evaluate("const button=document.querySelector('#skill-schreiben [data-write]');"
        + "return {id:button.dataset.write,version:button.dataset.version,rubric:button.dataset.rubric,rubricVersion:button.dataset.rubricVersion};");
      const openFor = async () => {
        const response = await request('/api/v1/attempts?open=1');
        return (response.data?.attempts ?? []).filter(attempt => attempt.task_id === button.id);
      };
      const before = await openFor();
      await cdp.evaluate("const button=document.querySelector('#skill-schreiben [data-write]');button.click();button.click();return true;");
      await cdp.waitFor("document.querySelector('#writing-text')", 15000);
      await sleep(500);
      const after = await openFor();
      const opened = after.length === 1 ? (await request('/api/v1/attempts/' + after[0].id)).data : null;
      const binding = opened && String(opened.task_version) === button.version && String(opened.rubric_id) === button.rubric
        && String(opened.rubric_version) === button.rubricVersion && opened.task_id === button.id;
      const editor = await cdp.evaluate("const editors=[...document.querySelectorAll('#writing-text')];return {count:editors.length,visible:editors[0]?.getBoundingClientRect().height>0};");
      record('RUX5 writing opens its exact binding and a double click cannot create two drafts',
        after.length - before.length <= 1 && after.length === 1 && binding && editor.count === 1 && editor.visible,
        JSON.stringify({ before: before.length, after: after.length, binding, editor }));
      await shot(cdp, 'review-ux-writing-binding-desktop');
      await clickSel(cdp, '#writing-close');
      await cdp.waitFor("document.querySelector('#skill-schreiben [data-write]') && !document.querySelector('#writing-text')", 12000);
      record('RUX5b closing writing restores its visible catalogue', await cdp.evaluate(
        "return document.querySelector('#skill-schreiben [data-write]').getBoundingClientRect().height>0;"));
      if (before.length === 0 && after.length === 1) {
        const removed = await request('/api/v1/attempts/' + after[0].id, 'DELETE', {});
        record('RUX5c the draft created by this check is cleaned up', removed.status === 200 || removed.status === 204,
          'DELETE synthetic draft -> ' + removed.status);
      }
    });

    for (const [width, height, tag] of [[390, 844, 'mobile'], [320, 568, 'narrow']]) {
      await checks('RUX6 ' + tag + ': full options wrap without overflow and the index returns', async () => {
        await viewport(cdp, width, height, true);
        await theme(cdp, tag === 'mobile' ? 'dark' : 'light');
        await openReading();
        const index = await overflow(cdp);
        await openPart();
        const probe = await measureOption(), page = await overflow(cdp);
        record('RUX6 ' + tag + ': full options wrap without overflow and remain selectable',
          matches(probe, page, true) && index.offenderCount === 0,
          JSON.stringify({ ...probe, expectedLength: target.label.length, overflow: page.offenderCount, indexOverflow: index.offenderCount }));
        await shot(cdp, 'review-ux-long-options-' + tag);
        const back = await returnToIndex();
        record('RUX6b ' + tag + ' returns to a tappable part control', back.control && back.formGone, JSON.stringify(back));
        await shot(cdp, 'review-ux-catalogue-return-' + tag);
      });
    }

    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');
  } finally {
    if (cdp) cdp.ws.close();
    await browser.cleanup();
  }
}
