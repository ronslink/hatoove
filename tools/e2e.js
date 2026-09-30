/**
 * End-to-end browser test for B1 Prep.
 *
 * Drives headless Chrome over the DevTools Protocol using Node's built-in
 * WebSocket, so it needs no packages. Verifies that the app boots, navigates,
 * runs a drill, loads a full paper part from the offline content pack, and
 * collects no console errors along the way.
 *
 * Usage: node tools/e2e.js [baseUrl]
 * Requires: the server running, and Chrome installed.
 */

import { findBrowser, launchBrowser, connectToPage, makeRecorder, sleep } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const PORT = 9222;

const { record, summary } = makeRecorder();

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chrome/Edge found. Skipping browser test.');
    process.exit(2);
  }
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error(`Server not reachable at ${BASE}. Start it with "npm start" first.`);
    process.exit(2);
  }

  // With no key configured the proxy must refuse rather than fail silently.
  const noKeyRes = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
  });
  const noKeyBody = await noKeyRes.json().catch(() => ({}));
  record(
    'the AI proxy refuses to call out without a key',
    noKeyRes.status === 400 && noKeyBody.code === 'NO_KEY',
    `status=${noKeyRes.status} code=${noKeyBody.code || 'none'}`
  );

  const { cleanup } = await launchBrowser(PORT);

  let cdp = null;
  try {
    cdp = await connectToPage(PORT);

    /* ---------------------------------------------------------- boot */
    await cdp.send('Page.navigate', { url: BASE });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 15000, 'dashboard to render');

    const title = await cdp.evaluate(`return document.getElementById('view-title').textContent`);
    record('app boots and renders the dashboard', title === 'Übersicht', `title="${title}"`);

    const navCount = await cdp.evaluate(`return document.querySelectorAll('#nav .nav-item').length`);
    record('navigation has all 12 views', navCount === 12, `found ${navCount}`);

    const hasReadiness = await cdp.evaluate(`return document.getElementById('view').textContent.includes('Prognose gesamt')`);
    record('dashboard shows the exam forecast', hasReadiness === true);

    // The exam date lives in server config, so accept either valid state:
    // a live countdown, or the prompt telling the learner to set one.
    const dashboardText = await cdp.evaluate(`return document.getElementById('view').textContent`);
    const hasCountdown = dashboardText.includes('Tage bis zur Prüfung');
    const hasPrompt = dashboardText.includes('Kein Prüfungsdatum');
    record(
      'dashboard surfaces exam timing (countdown or a prompt to set the date)',
      hasCountdown || hasPrompt,
      hasCountdown ? 'countdown shown' : hasPrompt ? 'no date set, prompt shown' : 'neither found'
    );

    /* --------------------------------------------------------- drill */
    await cdp.evaluate(`document.querySelector('[data-view="drill"]').click(); return true`);
    await cdp.waitFor(`!!document.querySelector('.drill-prompt')`, 12000, 'drill card');

    const optionCount = await cdp.evaluate(`return document.querySelectorAll('#options .option').length`);
    record('drill renders a multiple-choice question with 3 options', optionCount === 3, `options=${optionCount}`);

    const firstPrompt = await cdp.evaluate(`return document.querySelector('.drill-prompt').textContent`);
    record('drill question has German content', /[a-zA-ZäöüßÄÖÜ]/.test(firstPrompt) && firstPrompt.includes('___'), `"${firstPrompt.slice(0, 60)}…"`);

    // Answer it and check the feedback loop.
    await cdp.evaluate(`document.querySelector('#options .option').click(); return true`);
    await cdp.waitFor(`!!document.querySelector('.feedback')`, 8000, 'answer feedback');

    const feedback = await cdp.evaluate(`return document.querySelector('.feedback').textContent`);
    record('answering produces a verdict', /Richtig|Leider falsch/.test(feedback), `"${feedback.slice(0, 46).trim()}…"`);

    const explained = await cdp.evaluate(`return document.querySelector('.feedback').textContent.length > 40`);
    record('feedback includes an explanation', explained === true);

    // Move to the next card and confirm the prompt advanced.
    await cdp.evaluate(`document.querySelector('[data-next]').click(); return true`);
    await sleep(400);
    const secondPrompt = await cdp.evaluate(`return document.querySelector('.drill-prompt')?.textContent || ''`);
    record('the drill advances to a new question', secondPrompt !== firstPrompt && secondPrompt.length > 0);

    // Finish the session and check the summary.
    for (let i = 0; i < 14; i++) {
      const done = await cdp.evaluate(`return !!document.querySelector('.feedback') || document.body.textContent.includes('Session beendet')`);
      if (await cdp.evaluate(`return document.body.textContent.includes('Session beendet')`)) break;
      if (!done) {
        const hasOption = await cdp.evaluate(`return !!document.querySelector('#options .option')`);
        if (hasOption) await cdp.evaluate(`document.querySelector('#options .option').click(); return true`);
        else {
          const hasInput = await cdp.evaluate(`return !!document.querySelector('#type-answer')`);
          if (hasInput) {
            await cdp.evaluate(`document.querySelector('#type-answer').value='test'; return true`);
            await cdp.evaluate(`document.querySelector('[data-submit-type]').click(); return true`);
          }
        }
      }
      const hasNext = await cdp.evaluate(`return !!document.querySelector('[data-next]')`);
      if (hasNext) await cdp.evaluate(`document.querySelector('[data-next]').click(); return true`);
      await sleep(250);
    }
    const summary = await cdp.evaluate(`return document.body.textContent.includes('Session beendet')`);
    record('drill session reaches a summary screen', summary === true);

    const adaptive = await cdp.evaluate(`return document.body.textContent.includes('Der Trainer passt sich an')`);
    record('summary reports the adapted weakness list', adaptive === true);

    /* ------------------------------------------------- paper part (offline) */
    await cdp.evaluate(`document.querySelector('[data-view="paper"]').click(); return true`);
    await cdp.waitFor(`return document.querySelectorAll('[data-part]').length >= 8`, 10000, 'paper part index');
    record('paper index lists the exam parts', true);

    await cdp.evaluate(`document.querySelector('[data-part="LV1"]').click(); return true`);
    await cdp.waitFor(`!!document.querySelector('.headline')`, 15000, 'LV1 set from the offline pack');

    const headlines = await cdp.evaluate(`return document.querySelectorAll('.headline').length`);
    const selects = await cdp.evaluate(`return document.querySelectorAll('select[data-item]').length`);
    record('LV1 renders 10 headlines and 5 answer selects', headlines === 10 && selects === 5, `headlines=${headlines} selects=${selects}`);

    const hint = await cdp.evaluate(`return document.body.textContent.includes('Leseverstehen')`);
    record('LV1 shows the exam part briefing', hint === true);

    // The index lists all twelve parts, but only the receptive ones are generated
    // "sets". The oral parts and the writing task have their own views, and sending
    // them to the paper runner used to end in "SP1 hat keinen Aufgabengenerator".
    const destinations = [
      { id: 'SA1', view: 'writing' },
      { id: 'SP1', view: 'speaking' },
      { id: 'SP2', view: 'speaking' },
      { id: 'SP3', view: 'speaking' },
    ];
    for (const d of destinations) {
      await cdp.evaluate(`document.querySelector('[data-view="paper"]').click(); return true`);
      await cdp.waitFor(`return !!document.querySelector('[data-part="${d.id}"]')`, 10000, `${d.id} card`);
      await cdp.evaluate(`document.querySelector('[data-part="${d.id}"]').click(); return true`);
      await cdp.waitFor(`return document.getElementById('view').textContent.length > 60`, 20000, `${d.id} opened`);
      const res = await cdp.evaluate(`
        const t = document.getElementById('view').textContent.replace(/\\s+/g, ' ');
        return {
          error: /konnte nicht erstellt werden/.test(t),
          speaking: t.includes('Dein Beitrag'),
          writing: t.includes('Leitpunkte') || t.includes('Dein Brief'),
          heading: document.querySelector('#view h3')?.textContent || '',
        };
      `);
      record(
        `${d.id} opens its own view from the Prüfungsteile index`,
        !res.error && (d.view === 'speaking' ? res.speaking : res.writing),
        `error=${res.error} heading="${res.heading}"`
      );
    }

    /* ------------------------------------------------------ SB1 letters */
    await cdp.evaluate(`document.querySelector('[data-view="paper"]').click(); return true`);
    await cdp.waitFor(`return document.querySelectorAll('[data-part]').length >= 8`, 10000, 'paper index again');
    await cdp.evaluate(`document.querySelector('[data-part="SB1"]').click(); return true`);
    await cdp.waitFor(`!!document.querySelector('.letter-body')`, 15000, 'SB1 letter');

    const gaps = await cdp.evaluate(`return document.querySelectorAll('.letter-body select[data-gap]').length`);
    const placeholders = await cdp.evaluate(`return (document.querySelector('.letter-body').textContent.match(/\\{\\d+\\}/g) || []).length`);
    record('SB1 letter has 10 inline gaps and no raw placeholders', gaps === 10 && placeholders === 0, `gaps=${gaps} raw={${placeholders}}`);

    /* ------------------------------------------------------------- vocab */
    await cdp.evaluate(`document.querySelector('[data-view="vocab"]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Prüfungskern')`, 12000, 'vocab view');
    record('vocabulary view puts the exam core first', true);

    // The core pack is the highest-yield material and must be separately drillable.
    const coreBlocks = await cdp.evaluate(`return document.querySelectorAll('[data-core-tier]').length`);
    record('exam core is split into drillable blocks', coreBlocks >= 6, `blocks=${coreBlocks}`);

    const coreTotals = await cdp.evaluate(`
      const cells = [...document.querySelectorAll('table.plain tbody tr td.num')].map((td) => parseInt(td.textContent, 10)).filter(Number.isFinite);
      return Math.max(0, ...cells);
    `);
    record('exam core pack is substantial', coreTotals >= 20, `largest block=${coreTotals}`);

    await cdp.click('[data-core-tier="verbpraeposition"]');
    await cdp.waitFor(`!!document.querySelector('.drill-prompt')`, 12000, 'core drill card');
    const corePrompt = await cdp.evaluate(`return document.querySelector('.drill-prompt')?.textContent || ''`);
    record('a core block drills its own items', corePrompt.trim().length > 3, `"${corePrompt.slice(0, 52)}…"`);

    await cdp.evaluate(`document.querySelector('[data-view="vocab"]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Allgemeiner Wortschatz')`, 10000, 'vocab view again');
    const deck = await cdp.evaluate(`return document.body.textContent.includes('300')`);
    record('vocabulary view also keeps the 300-word general deck', deck === true);

    await cdp.evaluate(`document.querySelector('[data-vocab-start]').click(); return true`);
    await cdp.waitFor(`!!document.querySelector('.drill-prompt')`, 10000, 'vocab card');
    const vocabProgress = await cdp.evaluate(`return document.querySelector('.progress-line')?.textContent || ''`);
    record('vocabulary drill starts a card session', vocabProgress.includes('/'), `"${vocabProgress.trim()}"`);

    /* ---------------------------------------------------------- writing */
    await cdp.evaluate(`document.querySelector('[data-view="writing"]').click(); return true`);
    await cdp.waitFor(`return !!document.querySelector('#writing-text')`, 12000, 'writing view');
    const leitpunkte = await cdp.evaluate(`return document.querySelectorAll('.card ol li').length`);
    record('writing task shows four Leitpunkte', leitpunkte === 4, `found ${leitpunkte}`);

    await cdp.evaluate(`
      const t = document.querySelector('#writing-text');
      t.value = 'Sehr geehrte Frau Berger, ich möchte mich herzlich für den Kurs bedanken, weil er mir sehr geholfen hat. Leider konnte ich an den letzten beiden Terminen nicht teilnehmen, denn ich war krank. Deshalb möchte ich Sie fragen, ob ich die Unterlagen noch bekommen könnte. Außerdem würde ich gern wissen, wann der nächste Kurs beginnt. Über eine kurze Antwort würde ich mich sehr freuen. Mit freundlichen Grüßen Sara';
      t.dispatchEvent(new Event('input'));
      return true
    `);
    await cdp.evaluate(`document.querySelector('[data-live-check]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Automatischer Check')`, 8000, 'offline writing check');
    const checkText = await cdp.evaluate(`return document.body.textContent`);
    record('offline writing check detects the formal register', checkText.includes('Register: Sie'));
    record('offline writing check detects greeting and closing', checkText.includes('Anrede vorhanden') && checkText.includes('Grußformel vorhanden'));

    // The 30-minute exam timer had never actually been exercised.
    const timerBefore = await cdp.evaluate(`return document.querySelector('#w-timer').textContent`);
    await cdp.click('[data-toggle-timer]');
    await sleep(2300);
    const timerAfter = await cdp.evaluate(`return document.querySelector('#w-timer').textContent`);
    await cdp.click('[data-toggle-timer]'); // pause
    record(
      'writing view runs a 30-minute exam timer',
      timerBefore === '30:00' && timerAfter !== timerBefore && /^29:5\d$/.test(timerAfter),
      `${timerBefore} -> ${timerAfter}`
    );

    /* --------------------------------------------------------- speaking */
    await cdp.evaluate(`document.querySelector('[data-view="speaking"]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Aufgabenkarte')`, 12000, 'speaking view');
    const redemittel = await cdp.evaluate(`return document.querySelectorAll('[data-say]').length`);
    record('speaking view offers Redemittel', redemittel >= 5, `found ${redemittel}`);

    /* ------------------------------------------------------------- mock */
    await cdp.evaluate(`document.querySelector('[data-view="mock"]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Mocktest')`, 10000, 'mock intro');
    const mockInfo = await cdp.evaluate(`return document.body.textContent.includes('150 Minuten')`);
    record('mock exam explains its 150-minute structure', mockInfo === true);

    /* ----------------------------------------------------------- notebook */
    await cdp.evaluate(`document.querySelector('[data-view="notebook"]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Fehlerheft')`, 10000, 'notebook');
    const notebookHasEntries = await cdp.evaluate(`return document.body.textContent.includes('offene Fehler')`);
    record('mistakes from the drill landed in the error notebook', notebookHasEntries === true);

    // Review mode: due errors come back as self-graded cards.
    await cdp.click('[data-review]');
    await cdp.waitFor(`return document.body.textContent.includes('Wiederholung')`, 12000, 'review session');
    const reviewPrompt = await cdp.evaluate(`return document.querySelector('.drill-prompt')?.textContent || ''`);
    record('the notebook starts a spaced-repetition review session', reviewPrompt.length > 0, `"${reviewPrompt.slice(0, 44)}…"`);
    await cdp.click('[data-reveal]');
    const selfGrade = await cdp.waitFor(`return !!document.querySelector('[data-self]')`, 8000, 'self-grade buttons');
    record('review cards can be self-graded after revealing the answer', selfGrade === true);

    /* ------------------------------------------------------------- plan */
    await cdp.evaluate(`document.querySelector('[data-view="plan"]').click(); return true`);
    await cdp.waitFor(`return document.body.textContent.includes('Lernplan')`, 10000, 'plan');
    const planText = await cdp.evaluate(`return document.body.textContent`);
    // Plan days are labelled with real dates (e.g. "Mo 21.09."), not "Tag N".
    const dayBlocks = (planText.match(/\b(?:Mo|Di|Mi|Do|Fr|Sa|So)\s+\d{2}\.\d{2}\./g) || []).length;

    // Assert the real invariant - one block per day remaining until the exam - rather
    // than a fixed number, which rots as the exam approaches.
    const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json()).catch(() => ({}));
    let expectedDays = null;
    if (cfg.examDate) {
      const [y, m, d] = cfg.examDate.split('-').map(Number);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      expectedDays = Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86400000);
    }
    record(
      'study plan has exactly one dated block per remaining day',
      expectedDays === null ? dayBlocks >= 1 : dayBlocks === expectedDays,
      `${dayBlocks} blocks, ${expectedDays ?? '?'} days remaining`
    );
    record('study plan ends with a rehearsal and a taper day', planText.includes('Generalprobe') && planText.includes('Tapering'));
    record(
      'the plan never schedules the exam day itself',
      !planText.includes(cfg.examDate),
      cfg.examDate ? `exam ${cfg.examDate} must not appear as a study day` : 'no exam date set'
    );

    /* ------------------------------------------- plan completion and return */

    // The plan mixes listening, speaking, writing and drill tasks. A speaking or
    // writing task still carries a partId, so routing on partId alone sent it to the
    // written paper view. Nothing that needs the paper runner may be an oral part.
    const planButtons = await cdp.evaluate(`
      const v = document.getElementById('view');
      return {
        parts: [...v.querySelectorAll('[data-part]')].map((b) => b.dataset.part),
        speak: [...v.querySelectorAll('[data-speak]')].map((b) => b.dataset.speak),
        write: v.querySelectorAll('[data-write]').length,
      };
    `);
    const misrouted = planButtons.parts.filter((id) => id === 'SA1' || /^SP/.test(id));
    record(
      'the plan never sends an oral or writing task to the written paper view',
      misrouted.length === 0,
      `misrouted=[${misrouted.join(',')}] paperParts=[${planButtons.parts.join(',')}]`
    );
    record(
      'the plan gives speaking tasks a part-specific button',
      planButtons.speak.length === 0 || planButtons.speak.every((p) => /^SP[123]$/.test(p)),
      `speak=[${planButtons.speak.join(',')}]`
    );

    // And opening one really does land in the Sprechen view.
    if (planButtons.speak.length) {
      await cdp.evaluate(`document.querySelector('[data-speak]').click(); return true`);
      await cdp.waitFor(`return document.getElementById('view').textContent.length > 60`, 20000, 'speaking task from plan');
      const fromPlan = await cdp.evaluate(`
        const t = document.getElementById('view').textContent.replace(/\\s+/g, ' ');
        return {
          error: /konnte nicht erstellt werden/.test(t),
          speaking: t.includes('Dein Beitrag'),
          heading: document.querySelector('#view h3')?.textContent || '',
          back: !!document.querySelector('[data-return-to]'),
        };
      `);
      record(
        'a speaking task opened from the plan reaches the Sprechen view',
        !fromPlan.error && fromPlan.speaking && fromPlan.back,
        `error=${fromPlan.error} heading="${fromPlan.heading}" back=${fromPlan.back}`
      );
      await cdp.evaluate(`document.querySelector('[data-return-to]').click(); return true`);
      await cdp.waitFor(`return document.body.textContent.includes('Lernplan')`, 10000, 'back to plan');
    }
    const todayPanel = await cdp.evaluate(`
      const m = document.body.innerText.match(/(\\d+) von (\\d+) erledigt/);
      return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
    `);
    record('the plan shows how much of today is done', todayPanel && todayPanel.total > 0,
      todayPanel ? `${todayPanel.done} von ${todayPanel.total}` : 'no today panel');

    const controls = await cdp.evaluate(`return document.querySelectorAll('[data-task-toggle]').length`);
    record('every plan task has a completion control', controls >= 4, `controls=${controls}`);

    // Ticking a task by hand must persist across the re-render.
    const ticked = await cdp.evaluate(`
      const btn = [...document.querySelectorAll('[data-task-toggle]')].find((b) => !b.disabled && b.textContent.trim() === '\u25cb');
      if (!btn) return null;
      const info = { key: btn.dataset.taskToggle, day: btn.dataset.taskDay };
      btn.click();
      return info;
    `);
    record('an open plan task can be ticked by hand', Boolean(ticked), ticked ? ticked.day : 'no open task found');
    if (ticked) {
      await cdp.waitFor(`return document.body.innerText.includes('Lernplan')`, 10000, 'plan re-render');
      const now = await cdp.evaluate(`
        const btn = [...document.querySelectorAll('[data-task-toggle]')].find(
          (b) => b.dataset.taskToggle === ${JSON.stringify(ticked.key)} && b.dataset.taskDay === ${JSON.stringify(ticked.day)}
        );
        return btn ? btn.textContent.trim() : null;
      `);
      record('the tick survives the re-render', now === '\u2713', `now "${now}"`);
    }

    // Opening a task from the plan must offer a way straight back to it.
    await cdp.click('[data-drill]');
    await cdp.waitFor(`return !!document.querySelector('[data-return-to]')`, 12000, 'back link');
    const backLabel = await cdp.evaluate(`return document.querySelector('[data-return-to]').textContent.trim()`);
    record('opening a plan task offers a route back', /Lernplan/.test(backLabel), `"${backLabel}"`);
    await cdp.click('[data-return-to]');
    await cdp.waitFor(`return document.body.innerText.includes('Lernplan')`, 12000, 'back on the plan');
    record('the back link actually returns to the plan', true);

    /* ---------------------------------------------------- reference guides */
    // Note: headings are styled uppercase, and innerText reflects that, so these
    // word checks use textContent, which is not affected by text-transform.
    // The reference areas now live behind a single "Nachschlagen" index.
    await cdp.click('[data-view="reference"]');
    await cdp.waitFor(`return document.querySelectorAll('[data-open-area]').length >= 5`, 15000, 'reference index');
    const hub = await cdp.evaluate(`
      const v = document.getElementById('view');
      return {
        areas: v.querySelectorAll('[data-open-area]').length,
        enabled: [...v.querySelectorAll('[data-open-area]')].filter((b) => !b.disabled).length,
        cards: v.textContent,
      };
    `);
    record('the reference index lists every area', hub.areas >= 6, `areas=${hub.areas}`);
    record('every reference area is available offline', hub.enabled >= 6, `enabled=${hub.enabled}`);

    const openArea = async (id, waitFor) => {
      await cdp.click('[data-view="reference"]');
      await cdp.waitFor(`return !!document.querySelector('[data-open-area="${id}"]')`, 15000, `index for ${id}`);
      await cdp.click(`[data-open-area="${id}"]`);
      await cdp.waitFor(waitFor, 15000, id);
    };

    await openArea('speakingguide', `return document.querySelectorAll('[data-guide-part]').length === 3`);
    const sg = await cdp.evaluate(`
      const v = document.getElementById('view');
      const t = v.textContent;
      return {
        rows: v.querySelectorAll('table.plain tbody tr').length,
        tabs: document.querySelectorAll('[data-guide-part]').length,
        model: v.textContent.includes('Musterantworten'),
        back: !!document.querySelector('[data-return-to]'),
        enPart: t.includes('Part 1 – Presentation'),
        enStep: t.includes('Greet the examiners and name the topic'),
        enWatch: t.includes('Do not simply read the keywords out'),
        enTopic: t.includes('My home town'),
        enGroup: t.includes('Structure and order'),
      };
    `);
    record('the speaking guide lists phrases with full examples', sg.rows >= 30, `rows=${sg.rows}`);
    record('the speaking guide switches between all three tasks', sg.tabs === 3, `tabs=${sg.tabs}`);
    record('the speaking guide includes model answers', sg.model === true);
    record('a reference page offers a way back to the index', sg.back === true);
    record('the speaking guide renders its English strategy text',
      sg.enPart && sg.enStep && sg.enWatch && sg.enTopic && sg.enGroup,
      `part=${sg.enPart} step=${sg.enStep} watch=${sg.enWatch} topic=${sg.enTopic} group=${sg.enGroup}`);

    await openArea('writingguide', `return document.getElementById('view').textContent.includes('Musterbriefe')`);
    const wg = await cdp.evaluate(`
      const v = document.getElementById('view');
      const t = v.textContent;
      return {
        checklist: v.textContent.includes('Checkliste'),
        models: v.querySelectorAll('details.disclosure').length,
        contrasts: v.querySelectorAll('.feedback.ok, .feedback.no').length,
        phrases: v.querySelectorAll('table.plain tbody tr').length,
        enTitle: t.includes('Understanding the task'),
        enIdea: t.includes('Who is writing to whom?'),
        enType: t.includes('Complaint'),
        enCheck: t.includes('Task fulfilment'),
        enGuidePoint: t.includes('Reason for the complaint'),
      };
    `);
    record('the writing guide shows strategy and model letters', wg.checklist && wg.models >= 4, `model blocks=${wg.models}`);
    record('the writing guide flags good vs bad choices', wg.contrasts >= 8, `contrasts=${wg.contrasts}`);
    record('the writing guide carries the phrase building blocks', wg.phrases >= 50, `rows=${wg.phrases}`);
    record('the writing guide renders its English strategy text',
      wg.enTitle && wg.enIdea && wg.enType && wg.enCheck && wg.enGuidePoint,
      `title=${wg.enTitle} idea=${wg.enIdea} type=${wg.enType} check=${wg.enCheck}`);

    await openArea('casesguide', `return document.getElementById('view').textContent.includes('Fälle und Artikel')`);
    const cg = await cdp.evaluate(`
      const v = document.getElementById('view');
      const t = v.textContent;
      return {
        tables: v.querySelectorAll('table.plain').length,
        cells: v.querySelectorAll('table.plain td').length,
        highlighted: v.querySelectorAll('td[style*="accent-2"]').length,
        formal: v.textContent.includes('Ihnen'),
        wechsel: v.textContent.includes('Wechsel'),
        enTitle: t.includes('Definite article: der / die / das'),
        enHeader: /nominative/.test(t),
        enNote: t.includes('Only a few cells really change'),
        enWhy: t.includes('You need this table'),
        enTrigger: t.includes('verbs that take the dative'),
      };
    `);
    record('the cases guide renders the article tables', cg.tables >= 8, `tables=${cg.tables} cells=${cg.cells}`);
    record('the cases guide highlights the forms that differ from the nominative', cg.highlighted >= 6, `highlighted=${cg.highlighted}`);
    record('the cases guide covers the formal pronoun and the Wechselpräpositionen', cg.formal && cg.wechsel,
      `formal=${cg.formal} wechsel=${cg.wechsel}`);
    record('the cases guide renders its English layer',
      cg.enTitle && cg.enHeader && cg.enNote && cg.enWhy && cg.enTrigger,
      `title=${cg.enTitle} header=${cg.enHeader} note=${cg.enNote} why=${cg.enWhy} trigger=${cg.enTrigger}`);

    await openArea('nounsguide', `return document.getElementById('view').textContent.includes('Nomen-Lexikon')`);
    const ng = await cdp.evaluate(`
      const v = document.getElementById('view');
      const t = v.textContent;
      return {
        rules: v.textContent.includes('Endungen: immer feminin'),
        exceptions: v.textContent.includes('Die wichtigen Ausnahmen'),
        double: v.textContent.includes('Gleiches Wort'),
        rows: v.querySelectorAll('#noun-rows tr').length,
        filters: v.querySelectorAll('[data-gender-filter]').length,
        search: !!v.querySelector('#noun-search'),
        enExample: t.includes('Our neighbour often helps us in the garden.'),
        enRule: t.includes('no rule — learn it by heart'),
        enHeader: /masculine|neuter|feminine/.test(t),
        enException: t.includes('The ending -chen makes any word neuter'),
        enDouble: t.includes('der See is an inland lake'),
      };
    `);
    record('the noun guide explains the gender rules', ng.rules === true);
    record('the noun guide lists the exceptions', ng.exceptions === true);
    record('the noun guide lists words with two genders', ng.double === true);
    record('the noun lexicon renders with filters and search', ng.rows >= 200 && ng.filters === 4 && ng.search,
      `rows=${ng.rows} filters=${ng.filters}`);
    record('the noun lexicon renders its English translations',
      ng.enExample && ng.enRule && ng.enHeader && ng.enException && ng.enDouble,
      `example=${ng.enExample} rule=${ng.enRule} header=${ng.enHeader} exc=${ng.enException} double=${ng.enDouble}`);

    // Filtering the lexicon by gender must actually narrow it.
    const filtered = await cdp.evaluate(`
      const btn = [...document.querySelectorAll('[data-gender-filter]')].find((b) => b.dataset.genderFilter === 'das');
      if (!btn) return null;
      btn.click();
      return true;
    `);
    await cdp.waitFor(`return document.getElementById('view').textContent.includes('das')`, 12000, 'gender filter');
    const afterFilter = await cdp.evaluate(`return document.querySelectorAll('#noun-rows tr').length`);
    record('filtering the lexicon by gender works', Boolean(filtered) && afterFilter > 20 && afterFilter < 200,
      `rows after filtering to "das" = ${afterFilter}`);

    await openArea('grammarguide', `return document.getElementById('view').textContent.includes('Grammatik zum Nachschlagen')`);
    const gg = await cdp.evaluate(`
      const v = document.getElementById('view');
      const t = v.textContent;
      return {
        topics: v.querySelectorAll('details.disclosure').length,
        jumps: v.querySelectorAll('[data-jump]').length,
        reflexive: t.includes('Reflexivverben'),
        umzu: t.includes('um ... zu'),
        tables: v.querySelectorAll('table.plain').length,
        enTitle: t.includes('Reflexive verbs: sich'),
        enWhy: t.includes('Reflexive verbs come up constantly in the exam'),
        enRule: t.includes('With a reflexive verb a small word belongs firmly to the verb'),
        enTrap: t.includes('because it is about the future'),
        enHeader: t.includes('past participle'),
      };
    `);
    record('the grammar guide lists every topic', gg.topics >= 10 && gg.jumps >= 10, `topics=${gg.topics} jumps=${gg.jumps}`);
    record('the grammar guide covers the reflexive and um-zu patterns', gg.reflexive && gg.umzu,
      `reflexiv=${gg.reflexive} um-zu=${gg.umzu}`);
    record('the grammar guide includes look-up tables', gg.tables >= 5, `tables=${gg.tables}`);
    record('the grammar guide renders its English layer',
      gg.enTitle && gg.enWhy && gg.enRule && gg.enTrap && gg.enHeader,
      `title=${gg.enTitle} why=${gg.enWhy} rule=${gg.enRule} trap=${gg.enTrap} header=${gg.enHeader}`);

    /* --------------------------------------------------------- Satzbau */
    await openArea('sentenceguide', `return !!document.querySelector('#satz-input')`);

    // A correct sentence must come back clean, with the rule named.
    await cdp.evaluate(`
      const t = document.querySelector('#satz-input');
      t.value = 'Morgen fahre ich mit dem Zug nach Berlin.';
      t.dispatchEvent(new Event('input'));
      return true;
    `);
    await cdp.waitFor(`return !!document.querySelector('#satz-result .card')`, 12000, 'sentence analysis');
    const good = await cdp.evaluate(`
      const v = document.getElementById('satz-result');
      return {
        text: v.textContent,
        clean: !/Fehler gefunden/.test(v.textContent),
        v2: /zweiter Position|Zweitstellung/.test(v.textContent),
        enRule: v.textContent.includes('Main clause: the verb is in second position'),
        enExplanation: v.textContent.includes('exactly one element takes the opening slot'),
        enField: v.textContent.includes('finite verb'),
      };
    `);
    record('the sentence analyser names the verb-second rule', good.v2 === true);
    record('the sentence analyser leaves a correct sentence alone', good.clean === true);
    record('the sentence analyser explains the rule in English too',
      good.enRule && good.enExplanation && good.enField,
      `rule=${good.enRule} explanation=${good.enExplanation} field=${good.enField}`);

    // A broken sentence must be flagged with the fix.
    await cdp.evaluate(`
      const t = document.querySelector('#satz-input');
      t.value = 'Am Montag ich fahre nach Berlin.';
      t.dispatchEvent(new Event('input'));
      return true;
    `);
    await cdp.waitFor(`return /Fehler gefunden/.test(document.getElementById('satz-result').textContent)`, 12000, 'error flagged');
    const bad = await cdp.evaluate(`return document.getElementById('satz-result').textContent`);
    record('the sentence analyser flags a verb out of second position', /Vorfeld/.test(bad), '');
    record('the sentence analyser shows the corrected form', /Am Montag fahre ich/.test(bad), '');
    record('the flagged error carries an English message', /only ONE element in the opening slot/.test(bad), '');

    // And a Nebensatz must be recognised as verb-final.
    await cdp.evaluate(`
      const t = document.querySelector('#satz-input');
      t.value = 'Weil ich müde bin, bleibe ich zu Hause.';
      t.dispatchEvent(new Event('input'));
      return true;
    `);
    await cdp.waitFor(`return /Nebensatz/.test(document.getElementById('satz-result').textContent)`, 12000, 'subordinate clause');
    const sub = await cdp.evaluate(`return document.getElementById('satz-result').textContent`);
    record('the sentence analyser recognises a verb-final subordinate clause',
      /Verb steht am Ende|Verb am Ende/.test(sub), '');

    /* --------------------------------------------------------- settings */
    await cdp.evaluate(`document.querySelector('[data-view="settings"]').click(); return true`);
    await cdp.waitFor(`return !!document.querySelector('#api-key')`, 10000, 'settings');
    const offlinePill = await cdp.evaluate(`return document.body.textContent.includes('Kein Schlüssel hinterlegt')`);
    record('settings reports the offline state honestly', offlinePill === true);

    /* ------------------------------------------------------- persistence */
    const persisted = await cdp.evaluate(`return !!localStorage.getItem('b1prep.state.v1')`);
    record('progress is persisted to localStorage', persisted === true);

    const attemptsBeforeReload = await cdp.evaluate(`return import('/js/store.js').then(s => s.getState().counters.attempts)`);
    await cdp.send('Page.navigate', { url: BASE });
    await cdp.waitFor(`return !!document.querySelector('#view .card')`, 12000, 'reload');
    const attemptsAfterReload = await cdp.evaluate(`return import('/js/store.js').then(s => s.getState().counters.attempts)`);
    record('progress survives a page reload', attemptsBeforeReload > 0 && attemptsAfterReload === attemptsBeforeReload,
      `attempts before=${attemptsBeforeReload}, after=${attemptsAfterReload}`);

    /* ------------------------------- durable, server-side persistence */
    // Force a save through the UI, then wipe localStorage - which is what clearing
    // browser data, switching browsers, or changing the port looks like to the app.
    await cdp.click('[data-view="settings"]');
    await cdp.waitFor(`return !!document.querySelector('[data-save-now]')`, 12000, 'settings save button');
    await cdp.click('[data-save-now]');
    await sleep(1500);

    const beforeWipe = await cdp.evaluate(
      `const raw = localStorage.getItem('b1prep.state.v1'); return raw ? (JSON.parse(raw).counters?.attempts || 0) : 0`
    );
    await cdp.evaluate(`localStorage.removeItem('b1prep.state.v1'); return true`);
    const wiped = await cdp.evaluate(`return localStorage.getItem('b1prep.state.v1') === null`);
    record('localStorage can be wiped (simulating cleared browser data)', wiped === true);

    await cdp.send('Page.navigate', { url: BASE });
    await cdp.waitFor(`return !!document.querySelector('#view .card')`, 15000, 'reload after wipe');
    await sleep(1200);
    const afterWipe = await cdp.evaluate(
      `const raw = localStorage.getItem('b1prep.state.v1'); return raw ? (JSON.parse(raw).counters?.attempts || 0) : 0`
    );
    record(
      'progress is restored from the server after browser data is cleared',
      beforeWipe > 0 && afterWipe >= beforeWipe,
      `attempts before wipe=${beforeWipe}, after reload with empty localStorage=${afterWipe}`
    );

    const fsMod = await import('node:fs');
    const progressFile = process.env.B1PREP_PROGRESS_FILE || 'progress.json';
    record('progress is written to a real file on disk', fsMod.existsSync(progressFile), progressFile);

    /* ------------------------------------------------------- console health */
    const errors = cdp.consoleErrors();
    record('no console errors or uncaught exceptions', errors.length === 0, errors.slice(0, 4).join(' | '));
  } catch (err) {
    record('test run completed without a harness error', false, err.message);
  } finally {
    await cleanup();
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  process.exit(summary() ? 1 : 0);
}

main();
