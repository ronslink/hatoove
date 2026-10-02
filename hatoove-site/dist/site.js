(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const panel = $('#practice-panel');
  const state = { skill: 'reading', locale: 'en', indices: { reading: 0, grammar: 0 }, answers: {}, checked: {}, draft: '', review: false, checks: [false, false, false, false, false], modelOpen: false };
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const copy = {
    en: {sample:'SAMPLE', reading:'Read the situation. Which course fits all the requirements?', grammar:'Choose the word that completes the sentence.', choose:'Choose one answer', hint:'One answer fits.', check:'Check my answer', checked:'Answer checked', correct:'Exactly. Every detail fits.', incorrect:'Let’s look at the detail that matters.', answer:'The correct answer is', next:'Next sample', retry:'Try this again', writing:'Read Mila’s message. Write a reply that addresses all four points below.', label:'Your reply in German', placeholder:'Liebe Mila, …', words:'words', draft:'Your draft stays here until you reload this page.', review:'Review my writing', reviewTitle:'Give your reply a second look.', reviewIntro:'This is a self-review, not an AI assessment or an exam score. Use the checklist to revise your answer.', model:'Compare with a model response', modelNote:'One possible response. Many different answers can meet the task.', checklist:['I addressed all four points with relevant information.','I used a suitable greeting and closing.','I addressed Mila consistently using “du”.','My ideas follow a clear order and connect naturally.','I checked verb positions, endings, spelling and punctuation.']},
    de: {sample:'BEISPIEL', reading:'Lesen Sie die Situation. Welcher Kurs erfüllt alle Anforderungen?', grammar:'Wählen Sie das Wort, das den Satz vervollständigt.', choose:'Wählen Sie eine Antwort', hint:'Eine Antwort passt.', check:'Antwort prüfen', checked:'Antwort geprüft', correct:'Genau. Alle Einzelheiten passen.', incorrect:'Achten wir auf das entscheidende Detail.', answer:'Die richtige Antwort ist', next:'Nächstes Beispiel', retry:'Noch einmal versuchen', writing:'Lesen Sie Milas Nachricht. Schreiben Sie eine Antwort und gehen Sie auf alle vier Punkte ein.', label:'Ihre Antwort auf Deutsch', placeholder:'Liebe Mila, …', words:'Wörter', draft:'Ihr Entwurf bleibt hier, bis Sie die Seite neu laden.', review:'Meinen Text überprüfen', reviewTitle:'Schauen Sie Ihre Antwort noch einmal an.', reviewIntro:'Dies ist eine Selbstkontrolle, keine KI-Bewertung und kein Prüfungsergebnis. Überarbeiten Sie Ihren Text mit der Checkliste.', model:'Mit einer Musterantwort vergleichen', modelNote:'Eine mögliche Antwort. Viele verschiedene Texte können die Aufgabe erfüllen.', checklist:['Ich bin auf alle vier Punkte mit passenden Informationen eingegangen.','Ich habe eine passende Anrede und einen passenden Gruß verwendet.','Ich habe Mila durchgehend mit „du“ angesprochen.','Meine Gedanken sind klar geordnet und sinnvoll verbunden.','Ich habe Satzbau, Endungen, Rechtschreibung und Zeichensetzung überprüft.']}
  };
  const bank = {
    reading: [
      {text:'Sie arbeiten bis 17:30 Uhr. Sie möchten Excel lernen und suchen einen Präsenzkurs am Abend.', options:[['Excel nach Feierabend','Dienstags, 18:30–20:00 Uhr. In unseren Kursräumen am Bahnhof.'],['Excel am Wochenende','Samstags, 09:00–12:00 Uhr. In unserem Schulungszentrum.'],['Excel von zu Hause','Donnerstags, 19:00–20:30 Uhr. Online mit einer Lehrkraft.']], answer:0, explanation:{en:'A is in the evening and takes place in person. B is in the morning. C is online.',de:'A findet am Abend und in Präsenz statt. B ist am Vormittag. C findet online statt.'}, tip:{en:'Match every requirement, not just the word “Excel”.',de:'Achten Sie auf alle Anforderungen, nicht nur auf das Wort „Excel“.'}},
      {text:'Sie können nur am Samstag einen Kurs besuchen. Sie möchten lernen, Ihr Fahrrad selbst zu reparieren, und haben noch keine Erfahrung.', options:[['Fahrradwerkstatt für Profis','Samstags, 10–13 Uhr. Vertiefen Sie Ihre Reparaturkenntnisse. Erfahrung erforderlich.'],['Ihr Fahrrad selbst reparieren','Samstags, 14–17 Uhr. Wir zeigen Ihnen die Grundlagen. Für Anfänger geeignet.'],['Reparieren leicht gemacht','Dienstags, 18–21 Uhr. Ein praktischer Fahrradkurs ohne Vorkenntnisse.']], answer:1, explanation:{en:'B is on Saturday and suitable for beginners. A requires experience. C takes place on Tuesday.',de:'B findet am Samstag statt und ist für Anfänger geeignet. A setzt Erfahrung voraus. C findet am Dienstag statt.'}, tip:{en:'Time and experience level both matter. A matching day alone is not enough.',de:'Sowohl der Termin als auch das Niveau müssen passen. Der richtige Tag allein reicht nicht.'}}
    ],
    grammar: [
      {text:'Das ist der Kollege, mit ___ ich das Projekt vorbereite.', options:[['den',''],['dem',''],['der','']], answer:1, explanation:{en:'“Mit” takes the dative. The relative pronoun refers to the masculine noun “der Kollege”, so the form is “dem”.',de:'„Mit“ steht mit dem Dativ. Das Relativpronomen bezieht sich auf das maskuline Nomen „der Kollege“. Deshalb heißt es „dem“.'}, tip:{en:'First identify the preposition and its case. Then match the pronoun to its noun.',de:'Bestimmen Sie zuerst die Präposition und den Fall. Ordnen Sie dann das Pronomen dem Nomen zu.'}},
      {text:'Ich komme heute später, ___ mein Zug Verspätung hat.', options:[['weil',''],['deshalb',''],['trotzdem','']], answer:0, explanation:{en:'“Weil” introduces the reason and places the conjugated verb “hat” at the end of the clause. “Deshalb” and “trotzdem” would need a different word order.',de:'„Weil“ nennt den Grund. Das konjugierte Verb „hat“ steht am Ende des Nebensatzes. Nach „deshalb“ und „trotzdem“ wäre eine andere Wortstellung nötig.'}, tip:{en:'Check both the meaning and the position of the verb.',de:'Achten Sie sowohl auf die Bedeutung als auch auf die Position des Verbs.'}}
    ]
  };
  const writingPoints = ['Ob und wann Sie helfen können.','Welche Aufgabe Sie übernehmen möchten.','Eine Idee für das Programm.','Eine Frage, die Sie zum Fest haben.'];
  const model = 'Liebe Mila,\n\nvielen Dank für deine Nachricht! Ich helfe euch gern beim Nachbarschaftsfest. Am Samstag habe ich ab 14 Uhr Zeit.\n\nIch kann die Tische aufstellen und einen Kuchen mitbringen. Vielleicht könnten wir auch ein paar Spiele für die Kinder vorbereiten. Das wäre bestimmt lustig.\n\nSoll ich außerdem Getränke besorgen? Sag mir bitte Bescheid, was noch fehlt.\n\nIch freue mich auf das Fest!\nLiebe Grüße\nAlex';
  const currentKey = () => `${state.skill}:${state.indices[state.skill] || 0}`;
  const wordCount = () => state.draft.trim() ? state.draft.trim().split(/\s+/u).length : 0;
  function render() {
    const c = copy[state.locale];
    const isWriting = state.skill === 'writing';
    $('#sample-label').textContent = `${c.sample} ${isWriting ? '01' : `0${state.indices[state.skill] + 1} / 02`}`;
    document.querySelectorAll('[data-skill]').forEach(tab => {const selected = tab.dataset.skill === state.skill; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;});
    panel.setAttribute('aria-labelledby', `tab-${state.skill}`);
    panel.lang = state.locale;
    if (isWriting) {renderWriting(c); return;}
    const item = bank[state.skill][state.indices[state.skill]];
    const key = currentKey();
    panel.innerHTML = `<p class="task-instruction">${c[state.skill]}</p><div class="task-stimulus" lang="de">${escape(item.text)}</div>
      <form id="answer-form"><fieldset id="answer-options"><legend class="sr-only">${c.choose}</legend>${item.options.map((option,index) => `<label class="answer-option"><input type="radio" name="answer" value="${index}" ${state.answers[key] === index ? 'checked' : ''}><span class="option-letter" aria-hidden="true">${'ABC'[index]}</span><span lang="de"><strong>${escape(option[0])}</strong>${option[1] ? `<span>${escape(option[1])}</span>` : ''}</span></label>`).join('')}</fieldset>
      <div class="answer-footer"><span>${c.hint}</span><button id="check-answer" class="button button-dark" type="submit" ${state.answers[key] === undefined ? 'disabled' : ''}>${state.checked[key] ? c.checked : c.check}</button></div></form><div id="feedback" role="status" aria-live="polite" hidden></div>`;
    $('#answer-form').addEventListener('change', event => {state.answers[key] = Number(event.target.value); state.checked[key] = false; $('#check-answer').disabled = false; $('#check-answer').textContent = c.check; $('#feedback').hidden = true;});
    $('#answer-form').addEventListener('submit', event => {event.preventDefault(); if(state.answers[key] === undefined) return; state.checked[key] = true; $('#check-answer').textContent = c.checked; renderFeedback(item,c,key);});
    if(state.checked[key]) renderFeedback(item,c,key);
  }
  function renderFeedback(item,c,key) {
    const correct = state.answers[key] === item.answer;
    const feedback = $('#feedback');
    feedback.className = correct ? '' : 'incorrect';
    feedback.innerHTML = `<h3>${correct ? c.correct : c.incorrect}</h3><p><strong>${c.answer} ${'ABC'[item.answer]}.</strong> ${escape(item.explanation[state.locale])}</p><p>${escape(item.tip[state.locale])}</p><div class="feedback-actions"><button class="button button-dark" id="next-sample" type="button">${c.next}</button><button class="question-nav" id="retry-sample" type="button">${c.retry}</button></div>`;
    feedback.hidden = false;
    $('#next-sample').addEventListener('click', () => {state.indices[state.skill] = (state.indices[state.skill] + 1) % bank[state.skill].length; delete state.answers[currentKey()]; delete state.checked[currentKey()]; render(); panel.focus({preventScroll:true});});
    $('#retry-sample').addEventListener('click', () => {delete state.answers[key]; delete state.checked[key]; render(); panel.querySelector('input').focus({preventScroll:true});});
  }
  function renderWriting(c) {
    panel.innerHTML = `<p class="task-instruction">${c.writing}</p><div class="task-stimulus" lang="de"><p>Hallo!</p><p>In zwei Wochen möchten wir am Samstag ein kleines Nachbarschaftsfest in unserem Innenhof organisieren. Es gibt noch viel zu tun. Hast du Zeit, uns zu helfen?</p><p>Liebe Grüße<br>Mila</p></div><ul class="writing-points" lang="de">${writingPoints.map(point => `<li>${point}</li>`).join('')}</ul><label class="writing-label" for="writing-response">${c.label}</label><textarea class="writing-text" id="writing-response" lang="de" maxlength="6000" placeholder="${c.placeholder}" aria-describedby="draft-note word-count">${escape(state.draft)}</textarea><p class="word-count" id="word-count">${wordCount()} ${c.words}</p><p class="draft-note" id="draft-note">${c.draft}</p><button class="button button-dark" id="review-writing" type="button">${c.review}</button><div id="feedback" role="status" aria-live="polite" hidden></div>`;
    $('#writing-response').addEventListener('input', event => {state.draft = event.target.value; $('#word-count').textContent = `${wordCount()} ${c.words}`;});
    $('#review-writing').addEventListener('click', () => {state.review = true; renderReview(c);});
    if(state.review) renderReview(c);
  }
  function renderReview(c) {
    const feedback = $('#feedback');
    feedback.innerHTML = `<h3>${c.reviewTitle}</h3><p>${c.reviewIntro}</p><div class="review-list">${c.checklist.map((text,index) => `<label><input type="checkbox" data-review="${index}" ${state.checks[index] ? 'checked' : ''}><span>${text}</span></label>`).join('')}</div><details class="model-response" ${state.modelOpen ? 'open' : ''}><summary>${c.model}</summary><p>${c.modelNote}</p><p lang="de">${escape(model)}</p></details>`;
    feedback.hidden = false;
    feedback.querySelectorAll('[data-review]').forEach(input => input.addEventListener('change', () => {state.checks[Number(input.dataset.review)] = input.checked;}));
    feedback.querySelector('details').addEventListener('toggle', event => {state.modelOpen = event.target.open;});
  }
  function selectSkill(skill) {state.skill = skill; render();}
  const tabs = [...document.querySelectorAll('[data-skill]')];
  tabs.forEach((tab,index) => {
    tab.addEventListener('click', () => selectSkill(tab.dataset.skill));
    tab.addEventListener('keydown', event => {
      const target = {ArrowRight:(index + 1) % tabs.length, ArrowLeft:(index + tabs.length - 1) % tabs.length, Home:0, End:tabs.length - 1}[event.key];
      if(target === undefined) return;
      event.preventDefault(); tabs[target].focus(); selectSkill(tabs[target].dataset.skill);
    });
  });
  $('#explanation-language').addEventListener('change', event => {state.locale = event.target.value === 'de' ? 'de' : 'en'; render();});
  $('#hero-start').addEventListener('click', () => {setTimeout(() => panel.focus({preventScroll:true}),100);});
  render();
  // Optional browser-native action. It only opens a practice tab; it never answers or grades.
  if(document.modelContext && typeof document.modelContext.registerTool === 'function') {
    const controller = new AbortController();
    try {
      void Promise.resolve(document.modelContext.registerTool({name:'start_hatoove_practice',title:'Open a practice sample',description:'Open a Hatoove telc Deutsch B1 sample practice tab. Does not submit an answer or produce a grade.',annotations:{readOnlyHint:false,untrustedContentHint:false},inputSchema:{type:'object',properties:{skill:{type:'string',enum:['reading','grammar','writing']}},required:['skill'],additionalProperties:false},execute:async input => {
        if(!input || !['reading','grammar','writing'].includes(input.skill) || Object.keys(input).some(key => key !== 'skill')) throw new Error('Choose reading, grammar or writing.');
        selectSkill(input.skill); $('#practice').scrollIntoView({behavior:'instant',block:'start'}); panel.focus({preventScroll:true});
        return {skill:state.skill,exam:'telc Deutsch B1',mode:'sample',assessment:'not an exam result'};
      }},{signal:controller.signal})).catch(() => {});
      addEventListener('pagehide',() => controller.abort(),{once:true});
    } catch { /* Ordinary practice remains available in browsers without WebMCP support. */ }
  }
})();
