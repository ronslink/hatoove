/** Voluntary, owner-scoped dashboard survey. It only replaces its own card. */
const later = new Set();
let generation = 0;
const QUESTIONS = Object.freeze([
  ['ease', 'feedbackSurveyEase', 1, 5],
  ['useful', 'feedbackSurveyUseful', 1, 5],
  ['explanations', 'feedbackSurveyExplanations', 1, 5],
  ['recommend', 'feedbackSurveyRecommend', 0, 10],
  ['next', 'feedbackSurveyNext'],
]);
export async function renderSurvey({ api, uiText, esc, accountId, isCurrent = () => true }) {
  const host = document.getElementById('feedback-survey');
  if (!host) return;
  const ticket = ++generation;
  const locale = document.documentElement.lang;
  const current = () => ticket === generation && host.isConnected && isCurrent()
    && locale === document.documentElement.lang;
  host.hidden = true;
  const answer = await api.feedback.currentSurvey();
  if (!current() || !answer?.ok || !answer.data?.round_id) return;
  const round = answer.data;
  const key = JSON.stringify([accountId, round.round_id]);
  if (later.has(key)) return;
  // Copy is defined for this version's question set only. Unknown rounds are not reinterpreted.
  if (!Array.isArray(round.questions) || round.questions.length !== QUESTIONS.length
    || QUESTIONS.some(([id, , min, max], i) => {
      const q = round.questions[i];
      return q?.id !== id || (min === undefined
        ? q.type !== 'text' || q.max_length !== 1000
        : q.type !== 'scale' || q.min !== min || q.max !== max);
    })) return;
  host.innerHTML = '<h2>' + esc(uiText('feedbackSurveyTitle')) + '</h2>'
    + '<p>' + esc(uiText('feedbackSurveyIntro')) + '</p>'
    + '<form class="stack">' + QUESTIONS.map(([id, label, min, max]) =>
      min === undefined
        ? '<label>' + esc(uiText(label)) + '<textarea class="input" name="' + id
          + '" maxlength="1000" rows="3" required data-feedback-private></textarea></label>'
        : '<fieldset><legend>' + esc(uiText(label)) + '</legend><div class="row">'
          + Array.from({ length: max - min + 1 }, (_, i) => '<label><input type="radio" name="'
            + id + '" value="' + (min + i) + '" required> ' + (min + i) + '</label>').join('')
          + '</div></fieldset>').join('')
    + '<p role="status" data-survey-message hidden></p><div class="row">'
    + '<button class="btn btn-primary" type="submit">' + esc(uiText('feedbackSurveySend')) + '</button>'
    + '<button class="btn" type="button" data-survey-later>' + esc(uiText('feedbackSurveyLater')) + '</button>'
    + '<button class="btn" type="button" data-survey-skip>' + esc(uiText('feedbackSurveySkip'))
    + '</button></div></form>';
  host.hidden = false;
  const form = host.querySelector('form');
  const message = host.querySelector('[data-survey-message]');
  let busy = false;
  async function send(skip) {
    if (busy || !current()) return;
    if (!skip && !form.reportValidity()) return;
    const answers = {};
    if (!skip) for (const [id, , min] of QUESTIONS) {
      const value = new FormData(form).get(id);
      answers[id] = min === undefined ? String(value || '').trim() : Number(value);
    }
    if (!skip && !answers.next) {
      message.hidden = false; message.textContent = uiText('feedbackSurveyIncomplete'); return;
    }
    busy = true;
    form.querySelectorAll('button').forEach(b => { b.disabled = true; });
    let response;
    try {
      response = await api.feedback.submitSurvey(round.round_id,
        { ...(skip ? { skip: true } : { answers }), route: 'heute', interfaceLanguage: locale });
    } catch { response = { ok: false }; }
    if (!current()) return;
    busy = false;
    if (response?.ok) {
      later.add(key);
      host.textContent = uiText('feedbackSurveyThanks');
    } else {
      form.querySelectorAll('button').forEach(b => { b.disabled = false; });
      message.hidden = false; message.textContent = uiText('feedbackSurveyFailed');
    }
  }
  form.addEventListener('submit', e => { e.preventDefault(); void send(false); });
  form.querySelector('[data-survey-skip]').addEventListener('click', () => { void send(true); });
  form.querySelector('[data-survey-later]').addEventListener('click', () => {
    if (busy) return;
    later.add(key); host.hidden = true;
  });
}
