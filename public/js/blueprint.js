/**
 * The telc Deutsch B1 exam blueprint.
 *
 * Verified against telc gGmbH "telc Deutsch B1 Uebungstest 1" (Testformat / Punkte
 * und Gewichtung) and the telc exam page:
 *   - Written exam: 225 points, pass mark 135 (60%)
 *   - Oral exam:     75 points, pass mark  45 (60%)
 *   - Leseverstehen and Sprachbausteine SHARE one 90-minute slot.
 *   - Every Hoerverstehen item is Richtig/Falsch; there is no multiple choice there.
 *
 * The Sprechen sub-weights are an equal-thirds estimate (the 75-point total and the
 * 45-point pass mark are the exact parts). See README.
 */

export const TOTAL_POINTS = 300;
export const WRITTEN = { total: 225, pass: 135 };
export const ORAL = { total: 75, pass: 45 };

export const GROUPS = [
  { id: 'LV', name: 'Leseverstehen', short: 'Lesen', pts: 75, minutes: 65, mode: 'written', note: 'Teilt sich 90 Minuten mit Sprachbausteinen.' },
  { id: 'SB', name: 'Sprachbausteine', short: 'Sprachbausteine', pts: 30, minutes: 20, mode: 'written', note: 'Nur bei telc. Grammatik + Wortschatz im Brief.' },
  { id: 'HV', name: 'Hörverstehen', short: 'Hören', pts: 75, minutes: 30, mode: 'written', note: 'Alle Aufgaben sind Richtig/Falsch.' },
  { id: 'SA', name: 'Schreiben', short: 'Schreiben', pts: 45, minutes: 30, mode: 'written', note: 'Ein informeller oder halbformeller Brief/E-Mail mit 4 Leitpunkten.' },
  { id: 'SP', name: 'Sprechen', short: 'Sprechen', pts: 75, minutes: 15, mode: 'oral', note: 'Paarprüfung, ca. 20 Min. Vorbereitung.' },
];

export const PARTS = {
  LV1: {
    id: 'LV1', group: 'LV', pts: 25, items: 5, minutes: 15, kind: 'matching_headlines',
    label: 'Teil 1 – Überschriften zuordnen',
    brief: '10 Überschriften (a–j), 5 kurze Texte (1–5). Jede Überschrift nur einmal, 5 sind Distraktoren.',
    skills: ['lv_global'],
  },
  LV2: {
    id: 'LV2', group: 'LV', pts: 25, items: 5, minutes: 20, kind: 'mc3_text',
    label: 'Teil 2 – Lesetext, Multiple Choice',
    brief: 'Ein längerer Text, 5 Aufgaben (6–10) mit a/b/c. Die Aufgaben folgen der Textreihenfolge.',
    skills: ['lv_detail'],
  },
  LV3: {
    id: 'LV3', group: 'LV', pts: 25, items: 10, minutes: 30, kind: 'matching_ads',
    label: 'Teil 3 – Situationen & Anzeigen',
    brief: '10 Situationen (11–20), 12 Anzeigen (a–l). Jede Anzeige nur einmal. Für manche Situationen passt keine → "x".',
    skills: ['lv_selektiv'],
  },
  SB1: {
    id: 'SB1', group: 'SB', pts: 15, items: 10, minutes: 10, kind: 'gap_mc3',
    label: 'Teil 1 – Grammatik im Brief',
    brief: 'Persönlicher Brief/E-Mail, 10 Lücken (21–30), je a/b/c. Meist drei Formen desselben Wortes.',
    skills: ['konnektoren', 'praeposition_kasus', 'perfekt_auxiliar', 'adjektivendungen', 'relativpronomen'],
  },
  SB2: {
    id: 'SB2', group: 'SB', pts: 15, items: 10, minutes: 10, kind: 'gap_bank',
    label: 'Teil 2 – Wortbank im Brief',
    brief: 'Formeller Brief, 10 Lücken (31–40), 15 Wörter (a–o). Jedes Wort höchstens einmal, 5 bleiben übrig.',
    skills: ['konnektoren', 'lexik_kollokation', 'konjunktiv2_hoeflich'],
  },
  HV1: {
    id: 'HV1', group: 'HV', pts: 25, items: 5, minutes: 8, kind: 'truefalse', plays: 1,
    label: 'Teil 1 – Kurze Texte (einmal hören)',
    brief: '5 kurze Texte, nur EINMAL gehört. 5 Aussagen (41–45), Richtig/Falsch. 30 Sekunden Lesezeit vorher.',
    skills: ['hv_global'],
  },
  HV2: {
    id: 'HV2', group: 'HV', pts: 25, items: 10, minutes: 14, kind: 'truefalse', plays: 2,
    label: 'Teil 2 – Gespräch (zweimal hören)',
    brief: 'Ein längeres Gespräch, ZWEIMAL gehört. 10 Aussagen (46–55), Richtig/Falsch. 1 Minute Lesezeit vorher.',
    skills: ['hv_detail'],
  },
  HV3: {
    id: 'HV3', group: 'HV', pts: 25, items: 5, minutes: 8, kind: 'truefalse', plays: 2,
    label: 'Teil 3 – Ansagen (je zweimal)',
    brief: '5 kurze Ansagen/Nachrichten, jede ZWEIMAL gehört. 5 Aussagen (56–60). Selektives Verstehen: Zeit, Ort, Nummer, Preis.',
    skills: ['hv_selektiv', 'hoeren_zahlen'],
  },
  SA1: {
    id: 'SA1', group: 'SA', pts: 45, items: 1, minutes: 30, kind: 'writing',
    label: 'Schreiben – Brief/E-Mail',
    brief: 'Informeller oder halbformeller Brief oder E-Mail mit 4 Leitpunkten. Ca. 80–120 Wörter.',
    skills: ['sa_aufgabe', 'sa_konnektoren', 'sa_register', 'sa_grammatik', 'sa_wortschatz', 'sa_umfang'],
  },
  SP1: {
    id: 'SP1', group: 'SP', pts: 25, items: 1, minutes: 4, kind: 'speaking_presentation',
    label: 'Teil 1 – Präsentation',
    brief: 'Kurzvortrag zu einem Thema mit Stichwörtern (ca. 3 Minuten). Danach eine Anschlussfrage.',
    skills: ['sp_struktur', 'sp_redemittel', 'sp_fluessigkeit'],
  },
  SP2: {
    id: 'SP2', group: 'SP', pts: 25, items: 1, minutes: 6, kind: 'speaking_discussion',
    label: 'Teil 2 – Diskussion',
    brief: 'Meinungsaustausch zum Thema. Eigene Meinung, Begründung, auf den Partner eingehen.',
    skills: ['sp_interaktion', 'sp_wortschatz', 'sp_fluessigkeit'],
  },
  SP3: {
    id: 'SP3', group: 'SP', pts: 25, items: 1, minutes: 5, kind: 'speaking_planning',
    label: 'Teil 3 – Gemeinsam etwas planen',
    brief: 'Mit dem Partner etwas planen und sich einigen. Vorschläge machen, reagieren, entscheiden.',
    skills: ['sp_interaktion', 'sp_redemittel'],
  },
};

export const PART_LIST = Object.values(PARTS);
export const WRITTEN_PARTS = PART_LIST.filter((p) => GROUPS.find((g) => g.id === p.group).mode === 'written');
export const ORAL_PARTS = PART_LIST.filter((p) => GROUPS.find((g) => g.id === p.group).mode === 'oral');
export const SUBTEST_ORDER = ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3', 'SA1', 'SP1', 'SP2', 'SP3'];

/* ------------------------------------------------------------------- tags */

/**
 * The weakness taxonomy. Every attempt is scored both at the part level
 * ("skill:LV3") and against one or more of these tags, which is what makes the
 * "adjusts to my weak points" behaviour specific rather than vague.
 */
export const TAGS = {
  konnektoren: { label: 'Konnektoren & Konnektoradverbien', group: 'Grammatik', hint: 'aber, denn, sondern, deshalb, trotzdem, weil, dass, obwohl' },
  praeposition_kasus: { label: 'Präposition + Kasus', group: 'Grammatik', hint: 'bei/mit/nach + Dativ, für/ohne/gegen + Akkusativ' },
  wechselpraeposition: { label: 'Wechselpräpositionen', group: 'Grammatik', hint: 'in, an, auf – Dativ (wo?) vs. Akkusativ (wohin?)' },
  perfekt_auxiliar: { label: 'Perfekt: haben oder sein', group: 'Grammatik', hint: 'Bewegung / Zustandswechsel → sein' },
  partizip2: { label: 'Partizip II', group: 'Grammatik', hint: 'ge…t / ge…en, untrennbare Verben ohne ge-' },
  adjektivendungen: { label: 'Adjektivendungen', group: 'Grammatik', hint: 'nach der/die/das, ein/eine, ohne Artikel' },
  relativpronomen: { label: 'Relativpronomen', group: 'Grammatik', hint: 'der/die/das, dem, denen, mit dem' },
  possessivartikel: { label: 'Possessivartikel', group: 'Grammatik', hint: 'mein / meine / meinen / meiner' },
  personalpronomen: { label: 'Pronomen & Register', group: 'Grammatik', hint: 'dir/Ihnen, mich/mir, du vs. Sie' },
  temporalpraeposition: { label: 'Temporale Präpositionen', group: 'Grammatik', hint: 'bis, in, nach, vor, seit, ab' },
  konjunktiv2_hoeflich: { label: 'Konjunktiv II (höflich)', group: 'Grammatik', hint: 'könnten, müssten, würde, hätte' },
  trennbare_verben: { label: 'Trennbare Verben', group: 'Grammatik', hint: 'anrufen → ich rufe an' },
  modalverben: { label: 'Modalverben', group: 'Grammatik', hint: 'kann, muss, darf, soll, will, möchte' },
  komparativ: { label: 'Komparativ & Superlativ', group: 'Grammatik', hint: 'größer als, am größten, besser' },
  wortstellung_nebensatz: { label: 'Wortstellung im Nebensatz', group: 'Grammatik', hint: 'Verb am Ende nach weil / dass / wenn' },
  negation: { label: 'Negation', group: 'Grammatik', hint: 'nicht vs. kein, nichts, nie' },
  lexik_verben_praeposition: { label: 'Verben mit Präposition', group: 'Wortschatz', hint: 'warten auf, sich freuen über, teilnehmen an' },
  lexik_kollokation: { label: 'Kollokationen', group: 'Wortschatz', hint: 'einen Termin vereinbaren, Bescheid geben' },
  lexik_wortbildung: { label: 'Wortbildung', group: 'Wortschatz', hint: '-ung, -heit, -keit, -lich, -bar, un-' },
  lexik_synonyme: { label: 'Synonyme im Kontext', group: 'Wortschatz', hint: 'Bedeutung aus dem Zusammenhang' },
  lv_global: { label: 'Lesen: Globalverstehen', group: 'Lesestrategie', hint: 'Hauptaussage in eigenen Worten' },
  lv_detail: { label: 'Lesen: Detailverstehen', group: 'Lesestrategie', hint: 'Steht das wirklich im Text?' },
  lv_selektiv: { label: 'Lesen: selektives Verstehen', group: 'Lesestrategie', hint: 'Zwei Bedingungen pro Situation prüfen' },
  hv_global: { label: 'Hören: Globalverstehen', group: 'Hörstrategie', hint: 'Nur einmal – auf die Gesamtaussage hören' },
  hv_detail: { label: 'Hören: Detailverstehen', group: 'Hörstrategie', hint: 'Reihenfolge des Gesprächs nutzen' },
  hv_selektiv: { label: 'Hören: selektives Verstehen', group: 'Hörstrategie', hint: 'Zeit, Ort, Nummer, Preis herausfiltern' },
  hoeren_zahlen: { label: 'Zahlen, Zeiten, Namen', group: 'Hörstrategie', hint: 'Uhrzeiten, Preise, Straßennamen' },
  sa_aufgabe: { label: 'Schreiben: alle Leitpunkte', group: 'Schreiben', hint: 'Jeden Leitpunkt ausdrücklich behandeln' },
  sa_konnektoren: { label: 'Schreiben: Verbindungswörter', group: 'Schreiben', hint: 'deshalb, außerdem, trotzdem, zuerst' },
  sa_register: { label: 'Schreiben: Anrede & Register', group: 'Schreiben', hint: 'Sehr geehrte… / Liebe…, Sie vs. du, Grußformel' },
  sa_grammatik: { label: 'Schreiben: formale Richtigkeit', group: 'Schreiben', hint: 'Kasus, Verbformen, Wortstellung' },
  sa_wortschatz: { label: 'Schreiben: Ausdruck', group: 'Schreiben', hint: 'Abwechslung, passende Kollokationen' },
  sa_umfang: { label: 'Schreiben: Umfang', group: 'Schreiben', hint: 'ca. 80–120 Wörter' },
  sp_fluessigkeit: { label: 'Sprechen: Flüssigkeit', group: 'Sprechen', hint: 'Nicht stocken, Redemittel als Brücke' },
  sp_struktur: { label: 'Sprechen: Struktur', group: 'Sprechen', hint: 'Einleitung, Hauptteil, Schluss' },
  sp_wortschatz: { label: 'Sprechen: Wortschatz', group: 'Sprechen', hint: 'Themenwortschatz aktiv nutzen' },
  sp_interaktion: { label: 'Sprechen: Interaktion', group: 'Sprechen', hint: 'Vorschläge, Reaktion, Einigung' },
  sp_redemittel: { label: 'Sprechen: Redemittel', group: 'Sprechen', hint: 'Feste Wendungen für Meinung und Planung' },
  sp_aussprache: { label: 'Sprechen: Aussprache', group: 'Sprechen', hint: 'Umlaute, Wortakzent, Satzmelodie' },
};

export const TAG_GROUPS = ['Grammatik', 'Wortschatz', 'Lesestrategie', 'Hörstrategie', 'Schreiben', 'Sprechen'];

/** Grammar tags that the offline generator can drill without any AI call. */
export const GENERATABLE_TAGS = [
  'konnektoren', 'praeposition_kasus', 'wechselpraeposition', 'perfekt_auxiliar', 'partizip2',
  'adjektivendungen', 'relativpronomen', 'possessivartikel', 'personalpronomen',
  'temporalpraeposition', 'konjunktiv2_hoeflich', 'trennbare_verben', 'modalverben',
  'komparativ', 'wortstellung_nebensatz', 'negation', 'lexik_verben_praeposition',
];

/** Relative importance, derived from how many exam points a node drives. */
export const NODE_WEIGHTS = {
  'skill:LV1': 1.0, 'skill:LV2': 1.0, 'skill:LV3': 1.0,
  'skill:SB1': 0.6, 'skill:SB2': 0.6,
  'skill:HV1': 1.0, 'skill:HV2': 1.0, 'skill:HV3': 1.0,
  'skill:SA1': 1.8, 'skill:SP1': 1.0, 'skill:SP2': 1.0, 'skill:SP3': 1.0,
};

export function partOf(id) {
  return PARTS[id] || null;
}

export function groupOf(partId) {
  const p = PARTS[partId];
  return p ? GROUPS.find((g) => g.id === p.group) : null;
}

export function tagInfo(tag) {
  return TAGS[tag] || { label: tag, group: 'Sonstiges', hint: '' };
}

/* ------------------------------------------------- tag canonicalisation */

/**
 * German transliteration, so "präpositionen" and "praeposition" normalise alike.
 */
function foldTag(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Common shapes a model uses for a tag we already know. */
const TAG_ALIASES = {
  konnektor: 'konnektoren',
  konnektoren: 'konnektoren',
  konnektoradverb: 'konnektoren',
  konnektoradverbien: 'konnektoren',
  konjunktion: 'konnektoren',
  konjunktionen: 'konnektoren',
  praeposition: 'praeposition_kasus',
  praepositionen: 'praeposition_kasus',
  kasus: 'praeposition_kasus',
  wechselpraepositionen: 'wechselpraeposition',
  perfekt: 'perfekt_auxiliar',
  hilfsverb: 'perfekt_auxiliar',
  partizip: 'partizip2',
  partizip_ii: 'partizip2',
  adjektivendung: 'adjektivendungen',
  adjektivdeklination: 'adjektivendungen',
  relativsatz: 'relativpronomen',
  possessiv: 'possessivartikel',
  pronomen: 'personalpronomen',
  temporal: 'temporalpraeposition',
  konjunktiv: 'konjunktiv2_hoeflich',
  konjunktiv_ii: 'konjunktiv2_hoeflich',
  hoeflichkeit: 'konjunktiv2_hoeflich',
  trennbare_verb: 'trennbare_verben',
  modalverb: 'modalverben',
  steigerung: 'komparativ',
  wortstellung: 'wortstellung_nebensatz',
  fragewort: 'wortstellung_nebensatz',
  fragewoerter: 'wortstellung_nebensatz',
  indirekte_frage: 'wortstellung_nebensatz',
  verneinung: 'negation',
  verben_mit_praeposition: 'lexik_verben_praeposition',
  verb_praeposition: 'lexik_verben_praeposition',
  kollokation: 'lexik_kollokation',
  kollokationen: 'lexik_kollokation',
  wortbildung: 'lexik_wortbildung',
  synonym: 'lexik_synonyme',
  synonyme: 'lexik_synonyme',
  wortschatz: 'lexik_synonyme',
};

const TAG_LOOKUP = (() => {
  const map = {};
  for (const key of Object.keys(TAGS)) map[foldTag(key)] = key;
  for (const [alias, key] of Object.entries(TAG_ALIASES)) map[foldTag(alias)] = key;
  return map;
})();

/**
 * Map a free-text tag from a model (or from older stored data) onto the fixed
 * taxonomy. Without this, "Konnektoradverb" and "konnektoren" became two separate
 * weakness nodes, so neither accumulated enough evidence to be drilled and the
 * profile filled up with topics the generator cannot even produce items for.
 *
 * Falls back to `konnektoren` - a topic every B1 exam contains and the offline
 * generator can always produce.
 */
export function canonicalTag(raw) {
  const original = String(raw || '').trim();
  if (TAGS[original]) return original;
  const key = foldTag(original);
  if (!key) return 'konnektoren';
  if (TAG_LOOKUP[key]) return TAG_LOOKUP[key];

  // Last resort: longest shared prefix with a known tag, but only when it is
  // substantial enough to be meaningful rather than a coincidence.
  let best = null;
  let bestLen = 0;
  for (const [folded, canonical] of Object.entries(TAG_LOOKUP)) {
    let i = 0;
    while (i < folded.length && i < key.length && folded[i] === key[i]) i += 1;
    if (i > bestLen) {
      bestLen = i;
      best = canonical;
    }
  }
  return bestLen >= 8 ? best : 'konnektoren';
}

export function partLabel(partId) {
  return PARTS[partId]?.label || partId;
}
