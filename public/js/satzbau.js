/**
 * A small German clause analyser.
 *
 * This is a teaching aid, not a parser. It answers the questions that actually cost
 * marks at B1 and that a learner can check instantly:
 *
 *   - Which word is the finite verb, and where does it sit?
 *   - Is this a main clause (verb in position 2) or a subordinate clause (verb last)?
 *   - Is there a sentence bracket (Perfekt or modal) and is it closed properly?
 *   - Is a noun after an article capitalised?
 *
 * It is deliberately conservative: it only raises an issue when the pattern is clear,
 * because a wrong correction teaches the wrong thing. `tools/check.js` tests it.
 *
 * Pure logic, no DOM, so it runs in Node too.
 */

/** Words that push the finite verb to the end of their clause. */
export const SUBORDINATORS = [
  'weil', 'dass', 'obwohl', 'wenn', 'als', 'damit', 'ob', 'während', 'bevor',
  'nachdem', 'seitdem', 'seit', 'falls', 'indem', 'sodass', 'sofern', 'da',
];

/** Two-word subordinators, checked before the single-word list. */
export const SUBORDINATOR_PAIRS = [['so', 'dass'], ['als', 'ob'], ['ohne', 'dass'], ['statt', 'dass'], ['anstatt', 'dass']];

const W_WORDS = ['wer', 'wen', 'wem', 'wessen', 'was', 'wann', 'wo', 'wohin', 'woher', 'warum', 'wieso', 'weshalb', 'wie', 'welcher', 'welche', 'welches', 'welchen', 'welchem'];

/**
 * Finite verb forms, curated rather than guessed. Endings alone are too unreliable:
 * "arbeite" is finite but "Woche" ends in -e too.
 */
export const FINITE_FORMS = new Set([
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

/** Articles and article-like words: what follows must be a capitalised noun. */
const DETERMINERS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'dein', 'deine', 'deinen', 'deinem', 'deiner', 'deines',
  'sein', 'seine', 'seinen', 'seinem', 'seiner', 'seines',
  'ihr', 'ihre', 'ihren', 'ihrem', 'ihrer', 'ihres',
  'unser', 'unsere', 'unseren', 'unserem', 'unserer', 'unseres',
  'euer', 'eure', 'euren', 'eurem', 'eurer',
  'Ihr', 'Ihre', 'Ihren', 'Ihrem', 'Ihrer', 'Ihres',
  'dieser', 'diese', 'dieses', 'diesen', 'diesem',
  'jeder', 'jede', 'jedes', 'jeden', 'jedem',
  'welcher', 'welche', 'welches', 'welchen', 'welchem',
]);

const CAPITALISED = /^[A-ZÄÖÜ]/;
// Keep numbers: "Am 3. Mai" must survive tokenising, or the Vorfeld looks wrong.
const HAS_LETTER = /[A-Za-zÄÖÜäöüß0-9]/;

/** Subject pronouns. A pronoun sitting immediately before the verb, but not in
 * position 1, means two elements were pushed into the Vorfeld. */
const SUBJECT_PRONOUNS = new Set(['ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'Sie', 'man']);

/**
 * Split a text into clauses.
 *
 * Splits on commas, semicolons and colons, and on sentence-ending punctuation only
 * when a new sentence really starts (a letter before the mark, a capital after it).
 * That keeps "Am 3. Mai fahre ich …" in one piece instead of splitting at the ordinal.
 */
function splitClauses(text) {
  return String(text)
    .split(/(?<=[A-Za-zÄÖÜäöüß])[.!?](?=\s+[A-ZÄÖÜ])|[,;:]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenise(clause) {
  return (clause.match(/[A-Za-zÄÖÜäöüß0-9-]+|[.!?]/g) || []).filter((t) => HAS_LETTER.test(t));
}

/** A clause counts as subordinate if it opens with a subordinating conjunction. */
export function subordinateLead(tokens) {
  const first = (tokens[0] || '').toLowerCase();
  const second = (tokens[1] || '').toLowerCase();
  for (const [a, b] of SUBORDINATOR_PAIRS) {
    if (first === a && second === b) return `${a} ${b}`;
  }
  return SUBORDINATORS.includes(first) ? first : null;
}

function findFinite(tokens, { subordinate = false } = {}) {
  const searchable = (i, tok) => {
    // A capitalised word inside the clause is a noun (or the formal Sie), not a verb.
    if (i !== 0 && CAPITALISED.test(tok)) return null;
    const key = tok.toLowerCase();
    return FINITE_FORMS.has(key) ? key : null;
  };

  for (let i = 0; i < tokens.length; i++) {
    if (searchable(i, tokens[i])) return i;
  }

  // Not in the curated list. In a subordinate clause the rule tells us where the verb
  // is, so trust the position; elsewhere fall back to the shape of the word.
  if (subordinate && tokens.length) return tokens.length - 1;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i !== 0 && CAPITALISED.test(tok)) continue;
    const t = tok.toLowerCase();
    if (DETERMINERS.has(tok) || SUBJECT_PRONOUNS.has(tok)) continue;
    if (looksFiniteByForm(t)) return i;
  }
  return -1;
}

/** Weak fallback: does this word have the shape of a conjugated verb? */
function looksFiniteByForm(t) {
  if (!t || t.length < 3) return false;
  return /(e|st|t|en|te|test|ten|tet)$/.test(t);
}

/** Does the clause end in a participle or infinitive, i.e. is there a bracket? */
function bracketAtEnd(tokens) {
  const last = (tokens[tokens.length - 1] || '').toLowerCase();
  if (!last) return null;
  if (/^ge.*(t|en)$/.test(last)) return { kind: 'perfekt', word: tokens[tokens.length - 1] };
  if (FINITE_FORMS.has(last)) return null; // ends with the finite verb itself
  if (/(en|eln|ern)$/.test(last)) return { kind: 'infinitiv', word: tokens[tokens.length - 1] };
  return null;
}

/**
 * Analyse one clause.
 * @param {string} rawClause
 * @param {{afterSubordinate?:boolean}} [context]
 *   afterSubordinate: the previous clause was a subordinate one, so a verb-first
 *   clause here is a perfectly good main clause (the Nebensatz occupies position 1).
 */
export function analyseClause(rawClause, context = {}) {
  const tokens = tokenise(rawClause);
  const issues = [];
  if (!tokens.length) return null;

  const lead = subordinateLead(tokens);
  const lower0 = tokens[0].toLowerCase();
  const startsWithW = !lead && W_WORDS.includes(lower0);
  const finiteIdx = findFinite(tokens, { subordinate: Boolean(lead) });
  const finiteWord = finiteIdx >= 0 ? tokens[finiteIdx] : null;

  let type;
  if (lead) type = 'nebensatz';
  else if (startsWithW) type = 'wfrage';
  else if (finiteIdx === 0) type = context.afterSubordinate ? 'hauptsatz' : 'entscheidungsfrage';
  else type = 'hauptsatz';

  const vorfeld = finiteIdx > 0 ? tokens.slice(0, finiteIdx).join(' ') : '';
  const nachfeld = finiteIdx >= 0 ? tokens.slice(finiteIdx + 1).join(' ') : tokens.join(' ');
  const bracket = bracketAtEnd(tokens);
  // The middle field is what sits between the finite verb and the closing bracket.
  const afterFinite = finiteIdx >= 0 ? tokens.slice(finiteIdx + 1) : [];
  const mittelfeld = bracket && afterFinite.length ? afterFinite.slice(0, -1).join(' ') : '';

  let rule;
  if (type === 'nebensatz') {
    rule = {
      id: 'verbfinal',
      title: 'Nebensatz: das Verb steht am Ende',
      titleEn: 'Subordinate clause: the verb goes to the end',
      explanation: `„${lead}" leitet einen Nebensatz ein. Deshalb wandert das konjugierte Verb ganz ans Ende des Nebensatzes.`,
      explanationEn: `"${lead}" introduces a subordinate clause, so the conjugated verb moves right to the end of that clause.`,
    };
    if (finiteIdx >= 0 && finiteIdx !== tokens.length - 1) {
      issues.push({
        severity: 'error',
        message: `Nach „${lead}" muss das konjugierte Verb am Ende stehen. Hier steht „${finiteWord}" an Position ${finiteIdx + 1} von ${tokens.length}.`,
        messageEn: `After "${lead}" the conjugated verb has to come at the end. Here "${finiteWord}" is in position ${finiteIdx + 1} of ${tokens.length}.`,
        hint: `Zum Beispiel: …, ${lead} … ${finiteWord}.`,
        hintEn: `For example: …, ${lead} … ${finiteWord}.`,
      });
    }
  } else if (type === 'hauptsatz') {
    rule = context.afterSubordinate
      ? {
          id: 'v2_nach_nebensatz',
          title: 'Nebensatz zuerst: dann beginnt der Hauptsatz mit dem Verb',
          titleEn: 'Subordinate clause first: the main clause then starts with the verb',
          explanation:
            'Der Nebensatz besetzt Position 1 des ganzen Satzes. Deshalb steht das konjugierte Verb des Hauptsatzes direkt danach – das ist die normale Zweitstellung, nur mit dem Nebensatz als Vorfeld.',
          explanationEn:
            'The subordinate clause fills position 1 of the whole sentence, so the main clause verb comes immediately after it. This is still normal verb-second — the subordinate clause is simply acting as the opening element.',
        }
      : {
          id: 'v2',
          title: 'Hauptsatz: das Verb steht an zweiter Position',
          titleEn: 'Main clause: the verb is in second position',
          explanation:
            'Im Aussagesatz besetzt genau ein Satzteil das Vorfeld (Position 1), das konjugierte Verb folgt direkt auf Position 2. Alles andere kommt danach.',
          explanationEn:
            'In a statement exactly one element takes the opening slot (position 1) and the conjugated verb follows immediately in position 2. Everything else comes after it.',
        };
    if (finiteIdx < 0) {
      issues.push({
        severity: 'warn',
        message: 'Kein konjugiertes Verb erkannt. Prüfe, ob der Satz ein finites Verb hat.',
        messageEn: 'No conjugated verb found. Check whether the sentence has a finite verb.',
      });
    } else if (context.afterSubordinate && finiteIdx !== 0) {
      // "Weil ich müde bin, ich bleibe zu Hause." – the subordinate clause already
      // fills position 1, so the main clause has to begin with its verb.
      issues.push({
        severity: 'error',
        message: 'Nach einem Nebensatz beginnt der Hauptsatz mit dem konjugierten Verb.',
        messageEn: 'After a subordinate clause the main clause begins with the conjugated verb.',
        hint: `Richtig: „… , ${finiteWord} ${tokens.slice(0, finiteIdx).join(' ')} …"`,
        hintEn: `Correct: "… , ${finiteWord} ${tokens.slice(0, finiteIdx).join(' ')} …"`,
      });
    } else if (finiteIdx >= 2 && SUBJECT_PRONOUNS.has(tokens[finiteIdx - 1])) {
      // "Am Montag ich fahre …" – two elements in front of the verb. A pronoun can
      // only stand directly before the verb if it IS the Vorfeld.
      issues.push({
        severity: 'error',
        message: `Vor dem Verb stehen zwei Satzteile („${vorfeld}"). Im Hauptsatz darf nur EIN Satzteil im Vorfeld stehen.`,
        messageEn: `Two elements stand in front of the verb ("${vorfeld}"). A main clause allows only ONE element in the opening slot.`,
        hint: `Richtig: „${tokens.slice(0, finiteIdx - 1).join(' ')} ${finiteWord} ${tokens[finiteIdx - 1]} …" – das Verb kommt direkt nach dem ersten Satzteil.`,
        hintEn: `Correct: "${tokens.slice(0, finiteIdx - 1).join(' ')} ${finiteWord} ${tokens[finiteIdx - 1]} …" — the verb comes directly after the first element.`,
      });
    }
  } else {
    rule = {
      id: 'frage',
      title: type === 'wfrage' ? 'W-Frage: das Verb steht an zweiter Position' : 'Ja/Nein-Frage: das Verb steht an erster Position',
      titleEn: type === 'wfrage' ? 'W-question: the verb is in second position' : 'Yes/no question: the verb is in first position',
      explanation:
        type === 'wfrage'
          ? 'Das Fragewort besetzt Position 1, das konjugierte Verb folgt auf Position 2 – wie im Aussagesatz.'
          : 'Ohne Fragewort beginnt die Frage mit dem konjugierten Verb.',
      explanationEn:
        type === 'wfrage'
          ? 'The question word takes position 1 and the conjugated verb follows in position 2 — exactly as in a statement.'
          : 'With no question word the question opens with the conjugated verb.',
    };
  }

  if (bracket) {
    if (finiteIdx >= 0 && finiteIdx === tokens.length - 1) {
      issues.push({
        severity: 'warn',
        message: 'Am Satzende steht ein Verb, aber das konjugierte Verb fehlt davor.',
        messageEn: 'There is a verb at the end, but the conjugated verb is missing before it.',
        hint: 'Bei Perfekt oder Modalverb brauchst du zwei Teile: „Ich habe … gelernt."',
        hintEn: 'The perfect tense and modal verbs need two parts: "Ich habe … gelernt."',
      });
    }
  }

  // Nouns after a determiner must be capitalised.
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const tok = tokens[i];
    if (DETERMINERS.has(prev) && !CAPITALISED.test(tok) && !FINITE_FORMS.has(tok.toLowerCase())) {
      issues.push({
        severity: 'error',
        message: `„${tok}" folgt auf „${prev}" – Nomen schreibt man groß.`,
        messageEn: `"${tok}" follows "${prev}" — nouns are written with a capital letter.`,
        hint: `Richtig: ${prev} ${tok[0].toUpperCase()}${tok.slice(1)}`,
        hintEn: `Correct: ${prev} ${tok[0].toUpperCase()}${tok.slice(1)}`,
      });
    }
  }

  return { text: rawClause, type, trigger: lead, finite: finiteWord, finiteIndex: finiteIdx, vorfeld, mittelfeld, nachfeld, bracket, rule, issues, tokenCount: tokens.length };
}

/** Analyse a whole sentence. */
export function analyseSentence(text) {
  const raw = splitClauses(text);
  const clauses = [];
  for (const c of raw) {
    const afterSubordinate = clauses.length > 0 && clauses[clauses.length - 1].type === 'nebensatz';
    const analysed = analyseClause(c, { afterSubordinate });
    if (analysed) clauses.push(analysed);
  }
  if (!clauses.length) return null;

  const issues = clauses.flatMap((c) => c.issues);
  return {
    input: String(text).trim(),
    clauses,
    issues,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
  };
}
