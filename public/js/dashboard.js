/** The learning cockpit: existing learner evidence, one next action, five skills. */
import { esc, on, navigate, fmtDate, fmtDuration, pct, round1, setViewActions } from './shell.js';
import * as store from './store.js';
import * as engine from './engine.js';
import * as ai from './ai.js';
import { GROUPS, PARTS, tagInfo } from './blueprint.js';
import { icon } from './icons.js';

const SKILLS = {
  LV: { title: 'Lesen', icon: 'book-open', route: 'paper', description: 'Texte gezielt verstehen', headline: 'Lesen mit klarem Fokus.' },
  SB: { title: 'Sprachbausteine', icon: 'zap', route: 'paper', description: 'Grammatik im Kontext', headline: 'Mehr Sicherheit im Satz.' },
  HV: { title: 'Hören', icon: 'headphones', route: 'listening', description: 'Die wichtigen Details hören', headline: 'Genau hinhören. Mehr verstehen.' },
  SA: { title: 'Schreiben', icon: 'pen-line', route: 'writing', description: 'Gedanken klar formulieren', headline: 'Schritt für Schritt zum guten Text.' },
  SP: { title: 'Sprechen', icon: 'mic', route: 'speaking', description: 'Sicher ins Gespräch kommen', headline: 'Deine Gedanken. Deine Worte.' },
};

function openTask(task) {
  const from = 'home';
  if (!task) return navigate('drill', { mode: 'mix', size: 12, from });
  switch (task.kind) {
    case 'mock': return navigate('mock', { from });
    case 'review': return navigate('notebook', { from });
    case 'drill': return navigate('drill', { size: 12, tags: task.tags, from });
    case 'writing': return navigate('writing', { from });
    case 'speaking': return navigate('speaking', { partId: task.partId, from });
    default: return navigate(task.kind === 'listening' ? 'listening' : 'paper', { partId: task.partId, from });
  }
}

function taskLabel(task) {
  if (task.kind === 'part' || task.kind === 'listening') {
    const part = PARTS[task.partId];
    return `${SKILLS[part?.group]?.title || 'Prüfungsteil'} · ${part?.label || task.label}`;
  }
  return task.label;
}

function taskIcon(task) {
  return SKILLS[PARTS[task.partId]?.group]?.icon || ({ drill: 'zap', review: 'notebook-pen', mock: 'timer' }[task.kind]) || 'book-open';
}

function readinessSection(label, section, parts) {
  const covered = parts.filter(p => p.attempts > 0).length;
  const hasEvidence = covered > 0;
  const share = hasEvidence ? Math.max(0, Math.min(100, section.points / section.max * 100)) : 0;
  return `<div class="readiness-section">
    <div class="readiness-label"><strong>${label}</strong><span>${hasEvidence ? `${Math.round(section.points)} <small>/ ${section.max} P.</small>` : '<small>Noch keine Daten</small>'}</span></div>
    <div class="readiness-track ${hasEvidence && section.ok ? 'above' : ''}" role="img" aria-label="${label}: ${hasEvidence ? `geschätzt ${Math.round(section.points)} von ${section.max} Punkten` : 'noch keine Daten'}, Bestehensgrenze ${section.pass} Punkte">
      <i style="width:${share}%"></i><b style="left:${section.pass / section.max * 100}%"></b>
    </div>
    <div class="readiness-caption"><span>${covered} / ${parts.length} Teile geübt</span><span>Grenze: ${section.pass} P.</span></div>
  </div>`;
}

export async function dashboardView(el) {
  const state = store.getState();
  const readiness = engine.readiness();
  const countdown = engine.examCountdown(state.settings.examDate);
  const today = store.todayStats();
  const goal = state.settings.dailyGoal || 20;
  const streak = store.streak();
  const errors = store.listErrors();
  const due = store.srsDue(errors.map(e => e.id), errors.length).length;
  const weak = store.weakNodes({ limit: 3, prefix: 'tag:', minAttempts: 2 });
  const days = store.recentDays(14);
  const plan = engine.studyPlan({ days: engine.planHorizon({ examDate: state.settings.examDate }), examDate: state.settings.examDate });
  const todayPlan = plan[0];
  const progress = engine.planDayProgress(todayPlan, store.attemptsOn(store.dayKey()), store.planDoneOn(store.dayKey()));
  const next = progress.tasks.find(t => !t.done)?.task;
  const nextSkill = SKILLS[PARTS[next?.partId]?.group];
  const headline = !next ? 'Alle Bereiche heute geübt.' : nextSkill?.headline || (next.kind === 'mock' ? 'Zeit für deine Generalprobe.' : next.kind === 'review' ? 'Aus Fehlern wird Sicherheit.' : 'Heute gezielt weiterlernen.');
  const covered = readiness.byPart.filter(p => p.attempts > 0).length;
  const written = readiness.byPart.filter(p => p.group !== 'SP');
  const oral = readiness.byPart.filter(p => p.group === 'SP');
  const evidenceLabel = covered === 0 ? 'Noch keine Daten' : covered < readiness.byPart.length ? 'Unvollständige Datenbasis' : 'Alle Teile geübt';
  const maxActivity = Math.max(goal, ...days.map(d => d.attempts), 1);
  const date = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  setViewActions('');

  el.innerHTML = `<div class="academy-dashboard">
    <header class="dashboard-intro">
      <div><p class="eyebrow">DEIN LERNCOCKPIT</p><h2>Dein Weg zur Prüfung.</h2><p>Jeder Lernschritt zählt. Mach heute den nächsten.</p></div>
      <button class="exam-date" data-dashboard-goto="settings">${icon('calendar-days')}<span>${countdown && !countdown.past ? `<strong>${countdown.days} ${countdown.days === 1 ? 'Tag' : 'Tage'} bis zur Prüfung</strong><small>${esc(fmtDate(countdown.date))}</small>` : `<strong>${countdown?.past ? 'Prüfungstermin aktualisieren' : 'Kein Prüfungsdatum'}</strong><small>${countdown?.past ? 'Neues Lernziel festlegen' : 'Deinen Termin festlegen'}</small>`}</span>${icon('arrow-right')}</button>
    </header>

    <div class="dashboard-columns">
      <div class="daily-column">
        <section class="next-session card" aria-labelledby="next-title">
          <div class="session-copy"><div class="session-kicker"><span class="live-dot"></span>${next ? 'DEIN NÄCHSTER LERNSCHRITT' : 'HEUTE SCHON GEÜBT'}</div>
            <h2 id="next-title">${headline}</h2>
            <p>${next ? esc(taskLabel(next)) : 'Gönn dir eine Pause oder festige dein Wissen mit einer kurzen Übungsrunde.'}</p>
            <div class="session-actions"><button class="primary lg" data-recommended>${next ? 'Lernschritt starten' : 'Frei weiterüben'} ${icon('arrow-right')}</button><span>${icon('timer')} ${next ? `${next.minutes} Min. eingeplant` : '12 adaptive Aufgaben'}</span></div>
          </div>
          <div class="session-art" aria-hidden="true"><div class="art-grid"></div><div class="art-orbit"></div><div class="art-paper"><span>DEUTSCH</span><b>B1</b><i></i><i></i><div>${icon('check')}</div></div><div class="art-token">${icon(next ? taskIcon(next) : 'target')}</div></div>
        </section>

        <section class="card today-plan" aria-labelledby="today-title">
          <div class="dashboard-section-heading"><div><p class="eyebrow">${esc(date)}</p><h3 id="today-title">Dein Plan für heute</h3></div><button class="text-button" data-dashboard-goto="plan">Lernplan ${icon('arrow-right')}</button></div>
          <div class="plan-completion"><div class="bar"><i style="width:${progress.total ? progress.done / progress.total * 100 : 0}%"></i></div><span>${progress.done} von ${progress.total} geübt</span></div>
          <div class="today-tasks">${progress.tasks.map(({task, done}, i) => `<button class="today-task ${done ? 'complete' : ''}" data-today-task="${i}"><span class="task-number">${done ? icon('check') : String(i + 1).padStart(2, '0')}</span><span class="task-description"><strong>${esc(taskLabel(task))}</strong><small>${done ? 'Heute geübt' : `${task.minutes} Min. · ${task.kind === 'review' ? 'Wiederholen & festigen' : 'Gezieltes Prüfungstraining'}`}</small></span>${icon('arrow-right')}</button>`).join('')}</div>
        </section>
      </div>

      <section class="card readiness-card" aria-labelledby="readiness-title">
        <div class="dashboard-section-heading"><div><p class="eyebrow">DEIN ZWISCHENSTAND</p><h3 id="readiness-title">Prüfungsprognose</h3></div><span class="readiness-icon">${icon('target')}</span></div>
        <div class="forecast-total"><span>${covered ? Math.round(readiness.total) : '–'}</span><small>/ ${readiness.totalMax} Punkte</small></div>
        <div class="forecast-caption">Prognose gesamt <span>· vorläufig</span></div>
        <div class="evidence-label">${icon('file-text')} ${evidenceLabel}</div>
        ${readinessSection('Schriftlich', readiness.written, written)}
        ${readinessSection('Mündlich', readiness.oral, oral)}
        <p class="forecast-note">${covered ? 'Schätzung aus deinen Übungen. Ungeübte Teile beruhen auf Modellannahmen.' : 'Übe die Prüfungsteile, damit deine persönliche Prognose entstehen kann.'} Beide Bereiche müssen separat bestanden werden.</p>
        <button class="forecast-link" data-dashboard-goto="mock">${icon('timer')} Mit einem Mocktest überprüfen ${icon('arrow-right')}</button>
      </section>
    </div>

    <section class="daily-stats" aria-label="Deine Lernaktivität">
      <div class="daily-stat"><span class="stat-icon blue">${icon('check')}</span><div><strong>${today.attempts}<small> / ${goal}</small></strong><span>Aufgaben heute</span></div><div class="mini-progress" role="img" aria-label="Tagesziel ${Math.min(100, Math.round(today.attempts / goal * 100))} Prozent erreicht" style="--progress:${Math.min(100, today.attempts / goal * 100)}%"></div></div>
      <div class="daily-stat"><span class="stat-icon amber">${icon('flame')}</span><div><strong>${streak}<small> ${streak === 1 ? 'Tag' : 'Tage'}</small></strong><span>In Folge gelernt</span></div></div>
      <div class="daily-stat"><span class="stat-icon violet">${icon('timer')}</span><div><strong>${esc(fmtDuration(today.ms))}</strong><span>Lernzeit heute</span></div></div>
      <button class="daily-stat" data-dashboard-goto="notebook"><span class="stat-icon coral">${icon('notebook-pen')}</span><span><strong>${due}<small> fällig</small></strong><span>Fehler wiederholen</span></span>${icon('arrow-right')}</button>
    </section>

    <section class="skills-section" aria-labelledby="skills-title">
      <div class="dashboard-section-heading"><div><p class="eyebrow">FÜNF BEREICHE. EIN ZIEL.</p><h3 id="skills-title">Deine Prüfungsfertigkeiten</h3></div><button class="text-button" data-dashboard-goto="paper">Alle Prüfungsteile ${icon('arrow-right')}</button></div>
      <div class="skill-cards">${GROUPS.map((group, i) => {
        const skill = SKILLS[group.id];
        const parts = readiness.byPart.filter(p => p.group === group.id);
        const attempts = parts.reduce((sum, p) => sum + p.attempts, 0);
        const seen = parts.filter(p => p.attempts > 0).length;
        const points = parts.reduce((sum, p) => sum + p.points, 0);
        const percent = points / group.pts * 100;
        return `<button class="skill-card" data-skill="${group.id}"><span class="skill-top"><span class="skill-icon skill-${i}">${icon(skill.icon)}</span>${icon('arrow-right')}</span><strong>${skill.title}</strong><span class="skill-description">${skill.description}</span><span class="skill-score">${attempts ? `<b>${round1(points)}</b><span>/ ${group.pts} P. geschätzt</span>` : '<span>Noch nicht geübt</span>'}</span><span class="bar ${attempts && percent >= 60 ? 'good' : ''}"><i style="width:${attempts ? percent : 0}%"></i></span><small>${seen} / ${parts.length} Teile geübt</small></button>`;
      }).join('')}</div>
    </section>

    <div class="dashboard-secondary">
      <section class="card focus-card"><div class="dashboard-section-heading"><div><p class="eyebrow">GEZIELT BESSER WERDEN</p><h3>Dein Fokus</h3></div>${icon('zap')}</div>
        ${weak.length ? `<p class="muted small">Diese Themen kannst du gezielt weiterüben.</p><div class="focus-list">${weak.map((w,i) => `<button data-focus="${i}" class="focus-item"><span class="focus-dot"></span><span>${esc(tagInfo(w.id.slice(4)).label)}</span>${icon('arrow-right')}</button>`).join('')}</div>` : `<p class="muted">Lass uns herausfinden, was du schon kannst.</p><p class="small dim">Mit deinen ersten Antworten entsteht hier dein persönlicher Lernfokus.</p><button class="primary" data-adaptive-start>Erste Übungen starten ${icon('arrow-right')}</button>`}
      </section>
      <section class="card activity-card"><div class="dashboard-section-heading"><div><p class="eyebrow">DRANBLEIBEN LOHNT SICH</p><h3>Deine letzten 14 Tage</h3></div><span class="activity-total">${days.reduce((s,d) => s+d.attempts, 0)} Aufgaben</span></div>
        <div class="activity-chart" role="img" aria-label="Lernaktivität der letzten 14 Tage: ${days.map(d => `${d.key}: ${d.attempts} Aufgaben`).join('; ')}">${days.map((d,i) => `<div class="activity-day ${i === days.length - 1 ? 'is-today' : ''}"><div title="${esc(d.key)}: ${d.attempts} Aufgaben"><i style="height:${d.attempts ? Math.max(5, d.attempts / maxActivity * 100) : 0}%"></i></div><span>${i === days.length - 1 ? 'Heute' : new Date(`${d.key}T12:00:00`).toLocaleDateString('de-DE', {weekday:'short'}).replace('.', '')}</span></div>`).join('')}</div><div class="activity-foot"><span>${state.counters.attempts} Aufgaben insgesamt</span><span>${state.counters.attempts ? `${pct(state.counters.correct / state.counters.attempts * 100)} richtig` : 'Dein erster Schritt zählt'}</span></div>
      </section>
    </div>
    ${!ai.isConfigured() ? `<div class="offline-notice">${icon('book-open')}<p><strong>Offline-Modus aktiv.</strong> Die Aufgabensammlung ist bereit. Für neue KI-Aufgaben und persönliches Schreib- und Sprech-Feedback kannst du KI in den Einstellungen einrichten.</p><button class="text-button" data-dashboard-goto="settings">Einrichten ${icon('arrow-right')}</button></div>` : ''}
    <footer class="dashboard-footer"><span>Certa · Schritt für Schritt zur Prüfung.</span><span>Übungsprognosen sind keine Prüfungsergebnisse.</span></footer>
  </div>`;

  on(el.querySelector('[data-recommended]'), 'click', () => openTask(next));
  for (const button of el.querySelectorAll('[data-dashboard-goto]')) on(button, 'click', () => navigate(button.dataset.dashboardGoto));
  for (const button of el.querySelectorAll('[data-today-task]')) on(button, 'click', () => openTask(progress.tasks[Number(button.dataset.todayTask)].task));
  for (const button of el.querySelectorAll('[data-skill]')) on(button, 'click', () => {
    const group = button.dataset.skill;
    navigate(SKILLS[group].route, { group, from: 'home' });
  });
  on(el.querySelector('[data-adaptive-start]'), 'click', () => navigate('drill', { size: 12, from: 'home' }));
  for (const button of el.querySelectorAll('[data-focus]')) on(button, 'click', () => {
    const tag = weak[Number(button.dataset.focus)].id.slice(4);
    if (tag.startsWith('sa_')) navigate('writing', { from: 'home' });
    else if (tag.startsWith('sp_')) navigate('speaking', { from: 'home' });
    else if (tag.startsWith('hv_') || tag.startsWith('hoeren_')) navigate('listening', { from: 'home' });
    else if (tag.startsWith('lv_')) navigate('paper', { group: 'LV', from: 'home' });
    else navigate('drill', { tags: [tag], size: 6, from: 'home' });
  });
}
