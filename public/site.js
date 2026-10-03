import { LOCALES, initialLocale, getLocale, setLocale, subscribeLocale, t, translateDom, formatNumber } from './assets/i18n/core.js';
import './assets/i18n/common.js';
import './assets/i18n/public-messages.js';
import { instructionMarkup, translateInstructions } from './assets/i18n/instructions.js';

const $ = selector => document.querySelector(selector);
const panel = $('#practice-panel');
const state = {skill:'reading',indices:{reading:0,grammar:0},answers:{},checked:{},draft:'',review:false,checks:[false,false,false,false,false],modelOpen:false};
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const bank = {
  "reading": [
    {
      "text": "Sie arbeiten bis 17:30 Uhr. Sie möchten Excel lernen und suchen einen Präsenzkurs am Abend.",
      "options": [
        [
          "Excel nach Feierabend",
          "Dienstags, 18:30–20:00 Uhr. In unseren Kursräumen am Bahnhof."
        ],
        [
          "Excel am Wochenende",
          "Samstags, 09:00–12:00 Uhr. In unserem Schulungszentrum."
        ],
        [
          "Excel von zu Hause",
          "Donnerstags, 19:00–20:30 Uhr. Online mit einer Lehrkraft."
        ]
      ],
      "answer": 0
    },
    {
      "text": "Sie können nur am Samstag einen Kurs besuchen. Sie möchten lernen, Ihr Fahrrad selbst zu reparieren, und haben noch keine Erfahrung.",
      "options": [
        [
          "Fahrradwerkstatt für Profis",
          "Samstags, 10–13 Uhr. Vertiefen Sie Ihre Reparaturkenntnisse. Erfahrung erforderlich."
        ],
        [
          "Ihr Fahrrad selbst reparieren",
          "Samstags, 14–17 Uhr. Wir zeigen Ihnen die Grundlagen. Für Anfänger geeignet."
        ],
        [
          "Reparieren leicht gemacht",
          "Dienstags, 18–21 Uhr. Ein praktischer Fahrradkurs ohne Vorkenntnisse."
        ]
      ],
      "answer": 1
    }
  ],
  "grammar": [
    {
      "text": "Das ist der Kollege, mit ___ ich das Projekt vorbereite.",
      "options": [
        [
          "den",
          ""
        ],
        [
          "dem",
          ""
        ],
        [
          "der",
          ""
        ]
      ],
      "answer": 1
    },
    {
      "text": "Ich komme heute später, ___ mein Zug Verspätung hat.",
      "options": [
        [
          "weil",
          ""
        ],
        [
          "deshalb",
          ""
        ],
        [
          "trotzdem",
          ""
        ]
      ],
      "answer": 0
    }
  ]
};
const writingPoints = ["Ob und wann Sie helfen können.","Welche Aufgabe Sie übernehmen möchten.","Eine Idee für das Programm.","Eine Frage, die Sie zum Fest haben."];
const model = "Liebe Mila,\n\nvielen Dank für deine Nachricht! Ich helfe euch gern beim Nachbarschaftsfest. Am Samstag habe ich ab 14 Uhr Zeit.\n\nIch kann die Tische aufstellen und einen Kuchen mitbringen. Vielleicht könnten wir auch ein paar Spiele für die Kinder vorbereiten. Das wäre bestimmt lustig.\n\nSoll ich außerdem Getränke besorgen? Sag mir bitte Bescheid, was noch fehlt.\n\nIch freue mich auf das Fest!\nLiebe Grüße\nAlex";

const currentKey = () => state.skill + ':' + (state.indices[state.skill] || 0);
const wordCount = () => state.draft.trim() ? state.draft.trim().split(/\s+/u).length : 0;
const text = key => t('public.' + key);
const label = (key, tag = 'span', attributes = '') => '<' + tag + ' data-i18n="public.' + key + '"' + attributes + '>' + escape(text(key)) + '</' + tag + '>';
const instructions = {
  reading: 'Lesen Sie die Situation. Welcher Kurs erfüllt alle Anforderungen?',
  grammar: 'Wählen Sie das Wort, das den Satz vervollständigt.',
  writing: 'Lesen Sie Milas Nachricht. Schreiben Sie eine Antwort und gehen Sie auf alle vier Punkte ein.',
};
const directions = () => instructionMarkup({id: 'public.' + state.skill, examLanguage: 'de', original: instructions[state.skill], parameters: {}, locale: getLocale()});
function bind(key, node) {
  node.dataset.i18n = 'public.' + key;
  node.textContent = text(key);
}
function updateCounts() {
  $('#sample-label').textContent = text('sample') + ' ' + (state.skill === 'writing' ? '01' : '0' + (state.indices[state.skill] + 1) + ' / 02');
  if ($('#word-count')) $('#word-count').textContent = formatNumber(wordCount()) + ' ' + text('words');
}
// This callback never renders, replaces form nodes, or changes any practice state.
function localizePublic() {
  translateDom(document);
  translateInstructions(panel, getLocale());
  $('#interface-language').value = getLocale();
  panel.lang = getLocale();
  panel.dir = getLocale() === 'ar' ? 'rtl' : 'ltr';
  document.title = text('title');
  document.querySelector('meta[name="description"]').content = text('description');
  document.querySelector('meta[property="og:title"]').content = 'Hatoove · ' + text('slogan');
  document.querySelector('meta[property="og:description"]').content = text('ogDescription');
  updateCounts();
}
function render() {
  const isWriting = state.skill === 'writing';
  document.querySelectorAll('[data-skill]').forEach(tab => {const selected = tab.dataset.skill === state.skill; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;});
  panel.setAttribute('aria-labelledby', 'tab-' + state.skill);
  if (isWriting) renderWriting();
  else {
    const item = bank[state.skill][state.indices[state.skill]], key = currentKey();
    panel.innerHTML = directions() + '<div class="task-stimulus" lang="de" dir="ltr">' + escape(item.text) + '</div>'
      + '<form id="answer-form"><fieldset id="answer-options">' + label('choose','legend',' class="sr-only"')
      + item.options.map((option,index) => '<label class="answer-option"><input type="radio" name="answer" value="' + index + '"' + (state.answers[key] === index ? ' checked' : '') + '><span class="option-letter" lang="de" dir="ltr" aria-hidden="true">' + 'ABC'[index] + '</span><span lang="de" dir="ltr"><strong>' + escape(option[0]) + '</strong>' + (option[1] ? '<span>' + escape(option[1]) + '</span>' : '') + '</span></label>').join('')
      + '</fieldset><div class="answer-footer">' + label('hint') + label(state.checked[key] ? 'checked' : 'check','button',' id="check-answer" class="button button-dark" type="submit"' + (state.answers[key] === undefined ? ' disabled' : ''))
      + '</div></form><div id="feedback" role="status" aria-live="polite" hidden></div>';
    $('#answer-form').addEventListener('change', event => {
      state.answers[key] = Number(event.target.value); state.checked[key] = false;
      $('#check-answer').disabled = false; bind('check', $('#check-answer')); $('#feedback').hidden = true;
    });
    $('#answer-form').addEventListener('submit', event => {
      event.preventDefault(); if(state.answers[key] === undefined) return;
      state.checked[key] = true; bind('checked', $('#check-answer')); renderFeedback(item,key);
    });
    if(state.checked[key]) renderFeedback(item,key);
  }
  localizePublic();
}
function renderFeedback(item,key) {
  const feedback = $('#feedback');
  feedback.className = state.answers[key] === item.answer ? '' : 'incorrect';
  const itemKey = state.skill + state.indices[state.skill];
  feedback.innerHTML = label(state.answers[key] === item.answer ? 'correct' : 'incorrect','h3')
    + '<p><strong>' + label('answer') + ' <bdi lang="de" dir="ltr">' + 'ABC'[item.answer] + '.</bdi></strong> ' + label(itemKey + 'Explanation') + '</p>'
    + label(itemKey + 'Tip','p') + '<div class="feedback-actions">' + label('next','button',' class="button button-dark" id="next-sample" type="button"')
    + label('retry','button',' class="question-nav" id="retry-sample" type="button"') + '</div>';
  feedback.hidden = false;
  $('#next-sample').addEventListener('click', () => {state.indices[state.skill] = (state.indices[state.skill] + 1) % bank[state.skill].length; delete state.answers[currentKey()]; delete state.checked[currentKey()]; render(); panel.focus({preventScroll:true});});
  $('#retry-sample').addEventListener('click', () => {delete state.answers[key]; delete state.checked[key]; render(); panel.querySelector('input').focus({preventScroll:true});});
}
function renderWriting() {
  panel.innerHTML = directions() + '<div class="task-stimulus" lang="de" dir="ltr"><p>Hallo!</p><p>In zwei Wochen möchten wir am Samstag ein kleines Nachbarschaftsfest in unserem Innenhof organisieren. Es gibt noch viel zu tun. Hast du Zeit, uns zu helfen?</p><p>Liebe Grüße<br>Mila</p></div><ul class="writing-points" lang="de" dir="ltr">'
    + writingPoints.map(point => '<li>' + escape(point) + '</li>').join('') + '</ul>' + label('label','label',' class="writing-label" for="writing-response"')
    + '<textarea class="writing-text" id="writing-response" lang="de" dir="ltr" maxlength="6000" data-i18n-placeholder="public.placeholder" placeholder="' + escape(text('placeholder')) + '" aria-describedby="draft-note word-count">' + escape(state.draft) + '</textarea>'
    + '<p class="word-count" id="word-count"></p>' + label('draft','p',' class="draft-note" id="draft-note"') + label('review','button',' class="button button-dark" id="review-writing" type="button"')
    + '<div id="feedback" role="status" aria-live="polite" hidden></div>';
  $('#writing-response').addEventListener('input', event => {state.draft = event.target.value; updateCounts();});
  $('#review-writing').addEventListener('click', () => {state.review = true; renderReview();});
  if(state.review) renderReview();
}
function renderReview() {
  const feedback = $('#feedback');
  feedback.innerHTML = label('reviewTitle','h3') + label('reviewIntro','p') + '<div class="review-list">'
    + state.checks.map((checked,index) => '<label><input type="checkbox" data-review="' + index + '"' + (checked ? ' checked' : '') + '>' + label('checklist' + index) + '</label>').join('')
    + '</div><details class="model-response"' + (state.modelOpen ? ' open' : '') + '>' + label('model','summary') + label('modelNote','p') + '<p lang="de" dir="ltr">' + escape(model) + '</p></details>';
  feedback.hidden = false;
  feedback.querySelectorAll('[data-review]').forEach(input => input.addEventListener('change', () => {state.checks[Number(input.dataset.review)] = input.checked;}));
  feedback.querySelector('details').addEventListener('toggle', event => {state.modelOpen = event.target.open;});
}
function selectSkill(skill) {state.skill = skill; render();}
const tabs = [...document.querySelectorAll('[data-skill]')];
tabs.forEach((tab,index) => {
  tab.addEventListener('click', () => selectSkill(tab.dataset.skill));
  tab.addEventListener('keydown', event => {
    const direction = getLocale() === 'ar' ? -1 : 1;
    const target = {ArrowRight:(index + direction + tabs.length) % tabs.length, ArrowLeft:(index - direction + tabs.length) % tabs.length, Home:0, End:tabs.length - 1}[event.key];
    if(target === undefined) return;
    event.preventDefault(); tabs[target].focus(); selectSkill(tabs[target].dataset.skill);
  });
});
$('#sample-start').addEventListener('click', () => {setTimeout(() => panel.focus({preventScroll:true}),100);});
$('#interface-language').addEventListener('change', event => {
  if (LOCALES.includes(event.target.value)) setLocale(event.target.value, {persist:true});
});
const unsubscribeLocale = subscribeLocale(localizePublic);
addEventListener('pagehide', event => { if (!event.persisted) unsubscribeLocale(); });
addEventListener('pageshow', event => { if (event.persisted) setLocale(initialLocale()); });
setLocale(getLocale());
render();
// Optional browser-native action opens a practice tab; it never answers or grades.
if(document.modelContext && typeof document.modelContext.registerTool === 'function') {
  const controller = new AbortController();
  try {
    void Promise.resolve(document.modelContext.registerTool({name:'start_hatoove_practice',title:text('toolTitle'),description:text('toolDescription'),annotations:{readOnlyHint:false,untrustedContentHint:false},inputSchema:{type:'object',properties:{skill:{type:'string',enum:['reading','grammar','writing']}},required:['skill'],additionalProperties:false},execute:async input => {
      if(!input || !['reading','grammar','writing'].includes(input.skill) || Object.keys(input).some(key => key !== 'skill')) throw new Error(text('toolError'));
      selectSkill(input.skill); $('#practice').scrollIntoView({behavior:'instant',block:'start'}); panel.focus({preventScroll:true});
      return {skill:state.skill,exam:'telc Deutsch B1',mode:'sample',assessment:'not an exam result'};
    }},{signal:controller.signal})).catch(() => {});
    addEventListener('pagehide',() => controller.abort(),{once:true});
  } catch { /* Optional integration is absent in ordinary browsers. */ }
}
