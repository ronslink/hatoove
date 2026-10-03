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
 *   2. THE CATALOGUE OPENS ITS OWN ENTRIES, BY EXACT IDENTITY, AND TAKES YOU BACK. The Üben catalogue
 *      listed sets and tasks that nothing could open. The legs click a catalogue control, assert that
 *      exactly ONE read was made for THAT set id and THAT version (the request URL is inspected, not
 *      the intent), assert the catalogue steps aside while the task is open, and assert closing restores
 *      it — with the same control still present.
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
    const request = async (route, method = 'GET', body) => {
      const res = await fetch(base + route, {
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

    // The longest authored option the stack already serves. Zero SQL: the payload comes from the API.
    let target = null;
    for (const set of catalogue.data) {
      if (!['LV1', 'LV2', 'LV3', 'SB1', 'SB2'].includes(set.family) || !set.set_id || !set.version) continue;
      const read = await request(`/api/v1/objective-sets/${encodeURIComponent(set.set_id)}?version=${encodeURIComponent(set.version)}`);
      if (read.status !== 200) continue;
      for (const option of optionLabels(set.family, read.data?.payload)) {
        if (!target || option.label.length > target.label.length) {
          target = { ...option, setId: set.set_id, version: set.version, family: set.family, label: option.label };
        }
      }
    }
    if (!target) throw new Error('REVIEW-UX precondition: no authored option label could be read from the API');
    const expectedText = `${target.id}) ${target.label}`;
    const longEnough = target.label.length >= LONG_OPTION_FLOOR;

    /* -------------------------------------------------------------- the visible catalogue */

    const apiVersions = new Map(catalogue.data.map((s) => [s.set_id, String(s.version)]));
    const apiBinding = new Map(tasks.data.map((t) => [t.task_id, t]));

    const openUeben = async () => {
      /*
       * A DIFFERENT HASH FIRST. `#/ueben` → `#/ueben` is not a route change, so the router would not
       * re-render and a task opened by an earlier leg would stay on screen — the same trap
       * learner-completion-browser.mjs records for the Schreiben view.
       */
      await nav(cdp, base + '/app/#/heute');
      await sleep(120);
      await nav(cdp, base + '/app/#/ueben');
      await cdp.waitFor("document.querySelector('#task-list [data-open]') || document.querySelector('#task-list [data-write]')", 15000);
      await sleep(200);
    };

    await checks('RUX1 the Üben catalogue offers a control for every entry, carrying its exact identity', async () => {
      await openUeben();
      const seen = await cdp.evaluate(`
        const box = document.getElementById('task-list');
        const opens = [...box.querySelectorAll('[data-open]')].map((b) => ({ id: b.dataset.open, version: b.dataset.version, text: b.textContent.trim() }));
        const writes = [...box.querySelectorAll('[data-write]')].map((b) => ({ id: b.dataset.write, version: b.dataset.version, rubric: b.dataset.rubric, rubricVersion: b.dataset.rubricVersion, text: b.textContent.trim() }));
        return { opens, writes, cards: box.querySelectorAll('.card').length };
      `);
      const mismatched = seen.opens.filter((b) => apiVersions.get(b.id) !== b.version);
      const writingWrong = seen.writes.filter((b) => !apiBinding.has(b.id)
        || String(apiBinding.get(b.id).version) !== b.version
        || String(apiBinding.get(b.id).rubric_id) !== b.rubric
        || String(apiBinding.get(b.id).rubric_version) !== b.rubricVersion);
      const labelled = [...seen.opens, ...seen.writes].every((b) => b.text.length > 0);
      record('RUX1 the Üben catalogue offers a control for every entry, carrying its exact identity',
        seen.opens.length > 0 && seen.writes.length > 0 && mismatched.length === 0
          && writingWrong.length === 0 && labelled,
        `${seen.opens.length} Üben + ${seen.writes.length} Schreiben control(s) for ${seen.cards} card(s);`
          + ` version mismatches ${JSON.stringify(mismatched)}; writing binding mismatches ${JSON.stringify(writingWrong.map((b) => b.id))}`);
    });

    /* --------------------------------------------------- objective set: exact version, open + return */

    let catalogueHiddenWhileOpen = null;
    await checks('RUX2 an objective set opens by its exact version and the catalogue steps aside', async () => {
      if (!longEnough) {
        record('RUX2 a long authored option is available to wrap', false,
          `longest authored option in this stack is ${target.label.length} char(s), below the ${LONG_OPTION_FLOOR}-char floor; a coordinator fixture is required`);
      }
      const selector = `#task-list [data-open="${target.setId}"]`;
      await cdp.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 12000);
      const mark = cdp.events.length;
      await clickSel(cdp, selector);
      await cdp.waitFor("document.querySelector('.view:not([hidden]) .skill-practice [data-item]')", 15000);
      await sleep(200);
      const reads = cdp.events.slice(mark)
        .filter((e) => e.method === 'Network.requestWillBeSent')
        .map((e) => e.params.request)
        .filter((r) => r.method === 'GET' && new URL(r.url).pathname === `/api/v1/objective-sets/${target.setId}`);
      const versioned = reads.length === 1 && new URL(reads[0].url).searchParams.get('version') === target.version;
      const state = await cdp.evaluate(`
        const host = document.querySelector('.view:not([hidden]) .skill-practice');
        const list = document.querySelector('.view:not([hidden]) .stack[id^="skill-"]');
        const box = host ? host.getBoundingClientRect() : null;
        return {
          hostShown: Boolean(host) && !host.hidden,
          catalogueHidden: Boolean(list) && list.hidden,
          catalogueHeight: list ? Math.round(list.getBoundingClientRect().height) : null,
          chip: (host?.querySelector('.card-head .chip')?.textContent || '').trim(),
          items: host ? host.querySelectorAll('[data-item]').length : 0,
          onScreen: Boolean(box) && box.top >= -4 && box.top < window.innerHeight * 0.9,
        };
      `);
      catalogueHiddenWhileOpen = state.catalogueHidden;
      record('RUX2 an objective set opens by its exact version and the catalogue steps aside',
        versioned && state.hostShown && state.catalogueHidden && state.items >= 1 && state.onScreen
          && state.chip.includes(`Fassung ${target.version}`),
        `${reads.length} read(s) for ${target.setId}; version param ${reads.length ? new URL(reads[0].url).searchParams.get('version') : 'none'}`
          + ` (expected ${target.version}); chip "${state.chip}"; catalogue hidden=${state.catalogueHidden} (height ${state.catalogueHeight});`
          + ` ${state.items} item(s); on screen=${state.onScreen}`);
      await shot(cdp, 'review-ux-objective-open-desktop');
    });

    /* ------------------------------------------------------------- the full option text, measured */

    const measureOption = async () => cdp.evaluate(`
      const id = ${JSON.stringify(target.id)};
      const host = document.querySelector('.view:not([hidden]) .skill-practice');
      const el = host ? host.querySelector('[data-answer="' + id + '"]') : null;
      if (!el) return { missing: true };
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      const box = el.getBoundingClientRect();
      const card = el.closest('.card');
      const cardBox = card ? card.getBoundingClientRect() : null;
      const cs = getComputedStyle(el);
      return {
        text: el.textContent,
        tag: el.tagName,
        type: el.getAttribute('type'),
        focusable: el.tabIndex >= 0 && !el.disabled,
        title: el.getAttribute('title'),
        lines: new Set(rects.map((r) => Math.round(r.top))).size,
        whiteSpace: cs.whiteSpace,
        wrap: cs.overflowWrap || cs.wordWrap,
        clipped: el.scrollWidth > el.clientWidth + 1,
        right: Math.round(box.right),
        cardRight: cardBox ? Math.round(cardBox.right) : null,
        viewport: window.innerWidth,
      };
    `);

    await checks('RUX3 the complete option text is visible, wrapped and unclipped at desktop width', async () => {
      const probe = await measureOption();
      const page = await overflow(cdp);
      record('RUX3 the complete option text is visible, wrapped and unclipped at desktop width',
        !probe.missing && probe.text === expectedText && probe.tag === 'BUTTON' && probe.type === 'button'
          && probe.focusable && !probe.title && probe.clipped === false
          && probe.right <= probe.viewport + 1 && probe.cardRight !== null && probe.right <= probe.cardRight + 1
          && page.offenderCount === 0,
        `rendered ${probe.text ? probe.text.length : 0} char(s) of the authored ${target.label.length};`
          + ` rendered text matches the API label exactly=${probe.text === expectedText}; tag=${probe.tag}/${probe.type};`
          + ` keyboard-focusable=${probe.focusable}; title attribute=${probe.title === null ? 'absent' : JSON.stringify(probe.title)};`
          + ` lines=${probe.lines}; white-space=${probe.whiteSpace}; overflow-wrap=${probe.wrap}; clipped=${probe.clipped};`
          + ` tile right=${probe.right} of card ${probe.cardRight} and viewport ${probe.viewport};`
          + ` page overflow offenders=${page.offenderCount}`);
    });

    await checks('RUX4 closing the task returns to the catalogue', async () => {
      await clickSel(cdp, '#practice-close');
      await cdp.waitFor("document.querySelector('#ueben-practice')?.hidden && !document.querySelector('#skill-ueben-catalogue')?.hidden", 12000);
      const state = await cdp.evaluate(`
        const host = document.getElementById('ueben-practice');
        const list = document.getElementById('skill-ueben-catalogue');
        return {
          hostHidden: host.hidden, hostEmpty: host.children.length === 0 && host.textContent.trim() === '',
          catalogueShown: Boolean(list) && !list.hidden,
          controls: list ? list.querySelectorAll('[data-open], [data-write]').length : 0,
          formGone: !document.querySelector('[data-item]'),
        };
      `);
      record('RUX4 closing the task returns to the catalogue',
        catalogueHiddenWhileOpen === true && state.hostHidden && state.catalogueShown && state.controls > 0 && state.formGone,
        JSON.stringify({ ...state, catalogueHiddenWhileOpen }));
      await shot(cdp, 'review-ux-catalogue-return-desktop');
    });

    /* ------------------------------------------- writing: exact binding, one draft per double click */

    await checks('RUX5 a writing card opens its exact task binding and a double click cannot create two drafts', async () => {
      await openUeben();
      const button = await cdp.evaluate(`
        const b = document.querySelector('#task-list [data-write]');
        return b ? { id: b.dataset.write, version: b.dataset.version, rubric: b.dataset.rubric, rubricVersion: b.dataset.rubricVersion } : null;
      `);
      if (!button) throw new Error('no writing control in the catalogue');
      const openFor = async () => {
        const res = await request('/api/v1/attempts?open=1');
        const list = Array.isArray(res.data?.attempts) ? res.data.attempts : [];
        return list.filter((a) => a.task_id === button.id);
      };
      const before = await openFor();
      // Two clicks in ONE task, before the first can resolve: the case a per-click guard would miss.
      await cdp.evaluate(`
        const b = document.querySelector(${JSON.stringify(`#task-list [data-write="${button.id}"]`)});
        if (!b) return false;
        b.click(); b.click();
        return true;
      `);
      await cdp.waitFor("document.querySelector('#writing-text')", 15000);
      // Let a racing second create land before counting, so the server is asked after the dust settles.
      await sleep(500);
      const after = await openFor();
      const opened = after.length === 1 ? (await request('/api/v1/attempts/' + after[0].id)).data : null;
      const binding = opened ? String(opened.task_version) === button.version
        && String(opened.rubric_id) === button.rubric && String(opened.rubric_version) === button.rubricVersion
        && opened.task_id === button.id : false;
      const editors = await cdp.evaluate("return document.querySelectorAll('#writing-text').length");
      record('RUX5 a writing card opens its exact task binding and a double click cannot create two drafts',
        after.length - before.length <= 1 && after.length <= 1 && binding && editors === 1,
        `${before.length} open draft(s) before, ${after.length} after two clicks;`
          + ` binding task/version/rubric=${opened ? `${opened.task_id}@${opened.task_version}/${opened.rubric_id}@${opened.rubric_version}` : 'none'}`
          + ` vs button ${button.id}@${button.version}/${button.rubric}@${button.rubricVersion}; editors=${editors}`);
      await shot(cdp, 'review-ux-writing-binding-desktop');
      await clickSel(cdp, '#writing-close');
      await cdp.waitFor("document.querySelector('#ueben-practice')?.hidden && !document.querySelector('#skill-ueben-catalogue')?.hidden", 12000);
      const returned = await cdp.evaluate("return Boolean(document.querySelector('#task-list [data-write]'))");
      record('RUX5b closing the letter returns to the catalogue', returned, `catalogue writing control present=${returned}`);
      // Leave the stack as it was found, so a later leg or check does not inherit this draft.
      if (before.length === 0 && after.length === 1) {
        const removed = await request('/api/v1/attempts/' + after[0].id, 'DELETE', {});
        record('RUX5c the draft created by this check is cleaned up', removed.status === 200 || removed.status === 204,
          `DELETE attempts/${String(after[0].id).slice(0, 8)}… -> ${removed.status}`);
      }
    });

    /* ------------------------------------------------------------------ mobile and narrow */

    for (const [width, height, tag] of [[390, 844, 'mobile'], [320, 568, 'narrow']]) {
      await checks(`RUX6 ${tag} (${width}px): full option text wraps with no overflow and the catalogue returns`, async () => {
        await viewport(cdp, width, height, true);
        await theme(cdp, tag === 'mobile' ? 'dark' : 'light');
        await openUeben();
        const catalogue = await overflow(cdp);
        await cdp.waitFor(`document.querySelector('#task-list [data-open="${target.setId}"]')`, 12000);
        await clickSel(cdp, `#task-list [data-open="${target.setId}"]`);
        await cdp.waitFor("document.querySelector('.view:not([hidden]) .skill-practice [data-item]')", 15000);
        await sleep(200);
        const probe = await measureOption();
        const page = await overflow(cdp);
        await shot(cdp, `review-ux-long-options-${tag}`);
        record(`RUX6 ${tag} (${width}px): full option text wraps with no overflow and the catalogue returns`,
          !probe.missing && probe.text === expectedText && probe.clipped === false && probe.lines >= 2
            && probe.right <= probe.viewport + 1 && probe.cardRight !== null && probe.right <= probe.cardRight + 1
            && page.offenderCount === 0 && catalogue.offenderCount === 0,
          `lines=${probe.lines} for ${target.label.length} authored char(s); clipped=${probe.clipped};`
            + ` tile right=${probe.right} of card ${probe.cardRight} and viewport ${probe.viewport};`
            + ` page offenders=${page.offenderCount}; catalogue offenders=${catalogue.offenderCount}`);
        await clickSel(cdp, '#practice-close');
        await cdp.waitFor("document.querySelector('#ueben-practice')?.hidden && !document.querySelector('#skill-ueben-catalogue')?.hidden", 12000);
        const back = await cdp.evaluate(`
          const b = document.querySelector('#task-list [data-open="${target.setId}"]');
          return { control: Boolean(b) && b.getBoundingClientRect().height >= 44, formGone: !document.querySelector('[data-item]') };
        `);
        record(`RUX6b ${tag} closing returns to a tappable catalogue control`, back.control && back.formGone, JSON.stringify(back));
        await shot(cdp, `review-ux-catalogue-return-${tag}`);
      });
    }

    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');
  } finally {
    if (cdp) cdp.ws.close();
    await browser.cleanup();
  }
}
