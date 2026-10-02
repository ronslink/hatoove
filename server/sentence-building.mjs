/** Recovered finite-form lexicon from 3a9254ce3905b7d4de430e3d129edf0f62c90962:public/js/satzbau.js.
 * Structural teaching hints only; no grammar-correctness or exam-performance claim.
 */

const FINITE_FORMS = new Set([
  // sein
  'bin', 'bist', 'ist', 'sind', 'seid', 'war', 'warst', 'waren', 'wart', 'sei', 'seien',
  // haben
  'habe', 'hast', 'hat', 'haben', 'habt', 'hatte', 'hattest', 'hatten', 'hattet',
  // werden
  'werde', 'wirst', 'wird', 'werden', 'werdet', 'wurde', 'wurdest', 'wurden', 'wurdet', 'werde',
  // Modalverben, Präsens und Präteritum
  'kann', 'kannst', 'können', 'könnt', 'konnte', 'konntest', 'konnten', 'konntet',
  'muss', 'musst', 'müssen', 'müsst', 'musste', 'musstest', 'mussten', 'musstet',
  'darf', 'darfst', 'dürfen', 'dürft', 'durfte', 'durftest', 'durften', 'durftet',
  'soll', 'sollst', 'sollen', 'sollt', 'sollte', 'solltest', 'sollten', 'solltet',
  'will', 'willst', 'wollen', 'wollt', 'wollte', 'wolltest', 'wollten', 'wolltet',
  'mag', 'magst', 'mögen', 'mögt', 'möchte', 'möchtest', 'möchten', 'möchtet',
  // häufige starke Verben: Präsens
  'gebe', 'gibst', 'gibt', 'geben', 'gebt', 'gehe', 'gehst', 'geht', 'gehen',
  'komme', 'kommst', 'kommt', 'kommen', 'fahre', 'fährst', 'fährt', 'fahren', 'fahrt',
  'sehe', 'siehst', 'sieht', 'sehen', 'seht', 'esse', 'isst', 'esst', 'essen',
  'nehme', 'nimmst', 'nimmt', 'nehmen', 'nehmt', 'lese', 'liest', 'lesen', 'lest',
  'spreche', 'sprichst', 'spricht', 'sprechen', 'sprecht', 'schlafe', 'schläfst', 'schläft', 'schlafen',
  'helfe', 'hilfst', 'hilft', 'helfen', 'helft', 'treffe', 'triffst', 'trifft', 'treffen',
  'finde', 'findest', 'findet', 'finden', 'bleibe', 'bleibst', 'bleibt', 'bleiben',
  'weiß', 'weißt', 'wissen', 'wisst', 'kenne', 'kennst', 'kennt', 'kennen',
  'denke', 'denkst', 'denkt', 'denken', 'arbeite', 'arbeitest', 'arbeitet', 'arbeiten',
  'brauche', 'brauchst', 'braucht', 'brauchen', 'kaufe', 'kaufst', 'kauft', 'kaufen',
  'spiele', 'spielst', 'spielt', 'spielen', 'lerne', 'lernst', 'lernt', 'lernen',
  'wohne', 'wohnst', 'wohnt', 'wohnen', 'warte', 'wartest', 'wartet', 'warten',
  'suche', 'suchst', 'sucht', 'suchen', 'frage', 'fragst', 'fragt', 'fragen',
  'rufe', 'rufst', 'ruft', 'rufen', 'gehöre', 'gehörst', 'gehört', 'gehören',
  'gefalle', 'gefällst', 'gefällt', 'gefallen', 'gehe', 'geht', 'gehen',
  // häufige starke Verben: Präteritum
  'ging', 'gingst', 'gingen', 'gingt', 'kam', 'kamst', 'kamen', 'kamt',
  'sah', 'sahst', 'sahen', 'saht', 'aß', 'aßt', 'aßen', 'nahm', 'nahmst', 'nahmen',
  'las', 'last', 'lasen', 'sprach', 'sprachst', 'sprachen', 'half', 'halfst', 'halfen',
  'traf', 'trafst', 'trafen', 'fand', 'fandst', 'fanden', 'blieb', 'bliebst', 'blieben',
  'gab', 'gabst', 'gaben', 'schrieb', 'schriebst', 'schrieben', 'lief', 'liefst', 'liefen',
  'arbeitete', 'arbeitetest', 'arbeiteten', 'brauchte', 'brauchtest', 'brauchten',
  'kaufte', 'kauftest', 'kauften', 'spielte', 'spieltest', 'spielten',
  'lernte', 'lerntest', 'lernten', 'wohnte', 'wohntest', 'wohnten',
  'wartete', 'wartetest', 'warteten', 'suchte', 'suchtest', 'suchten',
  'fragte', 'fragtest', 'fragten', 'rief', 'riefst', 'riefen',
  // sein/haben/werden Konjunktiv II und weitere
  'hätte', 'hättest', 'hätten', 'hättet', 'wäre', 'wärst', 'wären', 'wärt',
  'würde', 'würdest', 'würden', 'würdet', 'könnte', 'könntest', 'könnten', 'könntet',
  'müsste', 'müsstest', 'müssten', 'müsstet', 'dürfte', 'dürftest', 'dürften', 'dürftet',
]);

export const SENTENCE_TEXT_LIMIT = 2000;
export const SENTENCE_CHECK_VERSION = 'satzbau-heuristic-v1';
export const SENTENCE_LIMITATION = 'Automatische Strukturhinweise für einfache deutsche Sätze. '
  + 'Dies ist keine vollständige Grammatikprüfung und keine Bewertung. Auch ohne Hinweis kann ein Satz Fehler enthalten. '
  + 'Unklare Strukturen, Wortbedeutung, Kasus und die meisten Verbformen werden nicht zuverlässig geprüft.';

// Recover the useful clause-order rules, not the old suffix guess or article-to-capitalisation
// rule: those mistook unknown nouns for verbs and adjectives for misspelled nouns.
const SUBORDINATORS = new Set(['weil', 'dass', 'obwohl', 'wenn', 'damit', 'ob', 'während', 'bevor',
  'nachdem', 'seitdem', 'falls', 'indem', 'sodass', 'sofern']);
const PAIRS = new Set(['so dass', 'als ob', 'ohne dass', 'statt dass', 'anstatt dass']);
const W_WORDS = new Set(['wer', 'wen', 'wem', 'wessen', 'was', 'wann', 'wo', 'wohin', 'woher',
  'warum', 'wieso', 'weshalb', 'wie', 'welcher', 'welche', 'welches', 'welchen', 'welchem']);
const SUBJECTS = new Set(['ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man']);
const OPENERS = new Set(['heute', 'morgen', 'gestern', 'danach', 'deshalb', 'trotzdem', 'dort',
  'hier', 'jetzt', 'später', 'am', 'im', 'nach', 'vor', 'mit', 'seit', 'an', 'auf', 'zu']);
const AUXILIARIES = new Set(['bin', 'bist', 'ist', 'sind', 'seid', 'war', 'waren', 'habe', 'hast',
  'hat', 'haben', 'habt', 'hatte', 'hatten', 'werde', 'wirst', 'wird', 'werden', 'werdet',
  'würde', 'würdest', 'würden', 'würdet', 'hätte', 'hättest', 'hätten', 'hättet']);
const MODALS = new Set(['kann', 'kannst', 'können', 'könnt', 'konnte', 'konnten', 'muss', 'musst',
  'müssen', 'müsst', 'musste', 'mussten', 'darf', 'darfst', 'dürfen', 'dürft', 'soll', 'sollst',
  'sollen', 'sollt', 'will', 'willst', 'wollen', 'wollt', 'möchte', 'möchtest', 'möchten', 'möchtet',
  'könnte', 'könntest', 'könnten', 'könntet', 'müsste', 'müssten', 'dürfte', 'dürften']);
const VERB_BRACKET = new Set([...AUXILIARIES, ...MODALS]);
const MAX_CLAUSES = 24;

function segments(text) {
  const result = [];
  let start = 0;
  let sentence = 0;
  let before = null;
  for (const match of text.matchAll(/[,;:]+|[.!?]+(?=\s|$)/gu)) {
    const prefix = text.slice(start, match.index);
    // Ordinals and common abbreviations are not clause boundaries.
    if (match[0] === '.' && (/\d$/u.test(prefix) || /\b(?:Dr|Hr|Fr|bzw|usw|z\.B|u\.a)$/iu.test(prefix))) continue;
    const ending = /^[.!?]/u.test(match[0]);
    const part = text.slice(start, match.index + (ending ? match[0].length : 0)).trim();
    if (part) result.push({ text: part, sentence, before, after: match[0] });
    start = match.index + match[0].length;
    if (ending) sentence += 1;
    before = match[0];
  }
  const tail = text.slice(start).trim();
  if (tail) result.push({ text: tail, sentence, before, after: null });
  return result;
}

function leadOf(tokens, context) {
  const lower = tokens.map((word) => word.toLowerCase());
  const pair = lower.slice(0, 2).join(' ');
  if (PAIRS.has(pair)) return pair;
  if (SUBORDINATORS.has(lower[0])) return lower[0];
  // als/da/seit can introduce a prepositional/adverbial phrase too; require a clear subject.
  if (['als', 'da', 'seit'].includes(lower[0]) && SUBJECTS.has(lower[1])) return lower[0];
  if (context.embedded && W_WORDS.has(lower[0])) return lower[0];
  return null;
}

function finiteCandidate(tokens, subordinate) {
  const candidates = tokens.map((word, index) => ({ word, index, lower: word.toLowerCase() }))
    .filter((token) => (token.index === 0 || !/^\p{Lu}/u.test(token.word)) && FINITE_FORMS.has(token.lower));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const last = candidates.at(-1);
  if (subordinate && last.index === tokens.length - 1 && VERB_BRACKET.has(last.lower)) {
    if (candidates.length > 2 || candidates.slice(0, -1).some((token) => AUXILIARIES.has(token.lower))) return null;
    return last;
  }
  const first = candidates[0];
  if (!subordinate && VERB_BRACKET.has(first.lower)
    && candidates.slice(1).every((token) => /(?:en|eln|ern)$/u.test(token.lower))) return first;
  return null;
}

function analyseClause(segment, context) {
  const tokens = segment.text.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || [];
  const trigger = leadOf(tokens, context);
  const candidate = finiteCandidate(tokens, Boolean(trigger));
  const finite = candidate ? { word: candidate.word, index: candidate.index } : null;
  const hints = [];
  const add = (code, message, severity = 'hint') => hints.push({ code, severity, message });
  let type = trigger ? 'subordinate' : /\?\s*$/u.test(segment.text) ? 'question'
    : finite && (finite.index > 0 || context.afterOpeningSubordinate) ? 'main' : 'uncertain';
  if (!finite) type = 'uncertain';
  let rule = 'Die Struktur lässt sich mit diesen einfachen Regeln nicht sicher bestimmen.';

  if (!finite) {
    add('uncertain_verb', 'Keine eindeutige konjugierte Verbform erkannt. Das kann an der begrenzten Wortliste '
      + 'oder einer komplexen Struktur liegen und bedeutet nicht, dass ein Verb fehlt.', 'uncertain');
  } else if (trigger) {
    rule = 'In einfachen eingeleiteten Nebensätzen steht das konjugierte Verb normalerweise am Ende.';
    // Ersatzinfinitive, coordinated clauses and extraposition defeat a simple final-word test.
    const ambiguous = tokens.some((word, i) => i > finite.index && ['und', 'oder', 'als', 'wie', 'zu'].includes(word.toLowerCase()))
      || tokens.filter((word) => /(?:en|eln|ern)$/u.test(word) && !/^\p{Lu}/u.test(word)).length > 1;
    if (finite.index !== tokens.length - 1 && !ambiguous) {
      add('subordinate_verb_position', 'Prüfe die Stellung von „' + finite.word + '“: Nach „' + trigger
        + '“ steht das konjugierte Verb in einfachen schriftlichen Nebensätzen normalerweise am Ende.');
    } else if (ambiguous) {
      add('complex_clause', 'Mehrteilige Verbgruppen, Vergleiche und Ergänzungen nach dem Verb brauchen '
        + 'eine genauere Prüfung. Hier wird keine Wortstellungskorrektur vorgeschlagen.', 'uncertain');
    }
  } else if (type === 'main') {
    rule = 'Im einfachen Aussagesatz folgt das konjugierte Verb auf das erste Satzglied. Ein Satzglied kann mehrere Wörter haben.';
    if (context.afterOpeningSubordinate) {
      rule = 'Ein vorangestellter Nebensatz kann das erste Satzglied bilden; danach folgt normalerweise das konjugierte Verb.';
      if (finite.index > 0 && !['dann', 'so'].includes(tokens[0]?.toLowerCase())) {
        add('main_after_subordinate', 'Prüfe den Anschluss: Nach einem vorangestellten Nebensatz beginnt '
          + 'der Hauptsatz normalerweise mit dem konjugierten Verb „' + finite.word + '“.');
      }
    } else if (finite.index > 1 && OPENERS.has(tokens[0]?.toLowerCase())
      && SUBJECTS.has(tokens[finite.index - 1]?.toLowerCase())) {
      add('main_verb_position', 'Prüfe, ob vor „' + finite.word + '“ zwei Satzglieder stehen. '
        + 'Nach einer vorangestellten Zeit- oder Ortsangabe folgt im einfachen Aussagesatz normalerweise das Verb, dann das Subjekt.');
    }
  } else if (type === 'question') {
    rule = W_WORDS.has(tokens[0]?.toLowerCase())
      ? 'In einer einfachen W-Frage folgt das konjugierte Verb auf die Fragegruppe.'
      : 'Eine einfache Ja/Nein-Frage beginnt normalerweise mit dem konjugierten Verb.';
  } else {
    add('verb_first_uncertain', 'Eine Verbform am Anfang kann zu einer Frage, Aufforderung oder '
      + 'anderen Struktur gehören. Eine sichere Einordnung ist hier nicht möglich.', 'uncertain');
  }
  if (finite && !trigger && VERB_BRACKET.has(candidate.lower)) {
    const end = tokens.at(-1) || '';
    if (finite.index < tokens.length - 1 && !/^\p{Lu}/u.test(end)
      && (/^ge.*(?:t|en)$/u.test(end) || (MODALS.has(candidate.lower) && /(?:en|eln|ern)$/u.test(end)))) {
      add('verb_bracket', 'Mögliche Satzklammer: „' + finite.word + ' … ' + end
        + '“. Die Wortformen und ihre Bedeutung werden damit nicht als richtig bestätigt.');
    }
  }
  return { text: segment.text, tokens, type, trigger, finite, rule, hints };
}

/** Pure bounded check. Text is returned for display only, never stored or sent to a model. */
export function checkSentence(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > SENTENCE_TEXT_LIMIT) throw new TypeError('invalid_sentence');
  const parts = segments(text.trim());
  const clauses = [];
  for (const part of parts.slice(0, MAX_CLAUSES)) {
    const previous = clauses.at(-1);
    const previousPart = parts[clauses.length - 1];
    const sameSentence = previousPart?.sentence === part.sentence;
    const firstInSentence = parts.findIndex((entry) => entry.sentence === part.sentence);
    const context = {
      embedded: Boolean(sameSentence && part.before === ','),
      afterOpeningSubordinate: Boolean(sameSentence && part.before === ','
        && firstInSentence === clauses.length - 1 && previous?.type === 'subordinate'),
    };
    clauses.push(analyseClause(part, context));
  }
  const hints = clauses.flatMap((clause, index) => clause.hints.map((hint) => ({ clause: index, ...hint })));
  const truncated = parts.length > MAX_CLAUSES;
  if (truncated) hints.push({ clause: null, code: 'clause_limit', severity: 'uncertain',
    message: 'Es werden höchstens 24 Teilsätze auf einmal untersucht. Bitte teile längere Texte auf.' });
  return { kind: 'structural-hints', version: SENTENCE_CHECK_VERSION, language: 'de', limited: true,
    limitation: SENTENCE_LIMITATION, truncated, clauses, hints };
}
