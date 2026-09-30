/**
 * Mock DeepSeek API for testing the AI path without a real key.
 *
 * Speaks just enough of the OpenAI-compatible protocol that the app cannot tell
 * the difference, and returns a valid payload for every prompt the app sends.
 * This is what lets tools/e2e-ai.js prove that the JSON contracts, the normalisers
 * and the AI-specific UI actually work.
 *
 * Usage: node tools/mock-deepseek.js [port]
 */

import http from 'node:http';

const PORT = Number(process.argv[2]) || 4399;

let calls = 0;
const callLog = [];

const LETTERS = 'abcdefghij'.split('');
const ADS = 'abcdefghijkl'.split('');
const BANK = 'abcdefghijklmno'.split('');

function lv1() {
  return {
    title: 'MOCK Leseverstehen Teil 1',
    headlines: LETTERS.map((id) => ({ id, text: `Überschrift ${id.toUpperCase()} über ein Alltagsthema` })),
    texts: [
      { id: '1', text: 'Viele Familien in der Stadt suchen seit Monaten eine bezahlbare Wohnung. Die Mieten sind stark gestiegen. Besonders kleine Wohnungen sind selten.', answer: 'a' },
      { id: '2', text: 'Im neuen Kurszentrum kann man ab September Deutsch lernen. Der Unterricht findet abends statt, damit Berufstätige teilnehmen können.', answer: 'b' },
      { id: '3', text: 'Wer mit dem Fahrrad zur Arbeit fährt, spart Geld und tut etwas für die Gesundheit. In vielen Städten gibt es jetzt sichere Radwege.', answer: 'c' },
      { id: '4', text: 'Die Mülltrennung ist in Deutschland wichtig. Papier, Glas und Plastik gehören in verschiedene Tonnen. Falsche Trennung kostet die Stadt viel Geld.', answer: 'd' },
      { id: '5', text: 'Immer mehr Menschen bestellen ihre Einkäufe im Internet. Kleine Läden in der Innenstadt haben es deshalb schwer.', answer: 'e' },
    ],
    why: { 1: 'Der Text handelt von der Wohnungssuche.', 2: 'Es geht um einen Deutschkurs.', 3: 'Der Text empfiehlt das Fahrrad.', 4: 'Der Text erklärt die Mülltrennung.', 5: 'Der Text beschreibt den Onlinehandel.' },
  };
}

function lv2() {
  return {
    title: 'MOCK Leseverstehen Teil 2',
    text: 'Seit drei Jahren arbeitet Frau Nowak in einem Pflegeheim in Leipzig. Früher war sie Verkäuferin, doch nach der Schließung des Geschäfts musste sie sich neu orientieren. Über eine Umschulung kam sie in die Pflege. Am Anfang sei die Arbeit körperlich sehr anstrengend gewesen, sagt sie. Heute möchte sie nicht mehr wechseln, obwohl die Schichten lang sind. Besonders gefällt ihr der Kontakt mit den Bewohnern. Die Bezahlung sei inzwischen besser geworden, aber noch nicht gut genug, findet sie. Ihr Arbeitgeber bietet Fortbildungen an, die sie regelmäßig nutzt. Für die Zukunft wünscht sie sich mehr Kolleginnen und Kollegen, denn der Personalmangel macht allen zu schaffen. Trotzdem empfiehlt sie den Beruf weiter, besonders Menschen, die gern mit anderen zu tun haben.',
    questions: [
      { n: 6, question: 'Was hat Frau Nowak früher gemacht?', options: { a: 'Sie war im Pflegeheim tätig.', b: 'Sie war Verkäuferin.', c: 'Sie hat Altenpflege studiert.' }, answer: 'b', why: 'Im Text steht: Früher war sie Verkäuferin.' },
      { n: 7, question: 'Wie war der Anfang in der Pflege?', options: { a: 'körperlich anstrengend', b: 'gut bezahlt', c: 'sehr langweilig' }, answer: 'a', why: 'Die Arbeit sei körperlich sehr anstrengend gewesen.' },
      { n: 8, question: 'Was gefällt ihr besonders?', options: { a: 'die langen Schichten', b: 'die Fortbildungen', c: 'der Kontakt zu den Bewohnern' }, answer: 'c', why: 'Besonders gefällt ihr der Kontakt mit den Bewohnern.' },
      { n: 9, question: 'Wie beurteilt sie die Bezahlung?', options: { a: 'Sie ist sehr gut.', b: 'Sie ist besser, aber noch nicht gut genug.', c: 'Sie ist gleich geblieben.' }, answer: 'b', why: 'Die Bezahlung sei besser geworden, aber noch nicht gut genug.' },
      { n: 10, question: 'Was wünscht sie sich für die Zukunft?', options: { a: 'mehr Personal', b: 'eine andere Stelle', c: 'kürzere Arbeitswege' }, answer: 'a', why: 'Sie wünscht sich mehr Kolleginnen und Kollegen.' },
    ],
  };
}

function lv3() {
  const answers = { 11: 'a', 12: 'b', 13: 'c', 14: 'd', 15: 'e', 16: 'f', 17: 'g', 18: 'x', 19: 'h', 20: 'x' };
  return {
    title: 'MOCK Leseverstehen Teil 3',
    ads: ADS.map((id) => ({ id, text: `Anzeige ${id.toUpperCase()}: Kurs, Angebot oder Dienstleistung mit Bedingungen.` })),
    situations: Object.entries(answers).map(([n, answer]) => ({
      n: Number(n),
      text: `Situation ${n}: Ich suche ein Angebot mit zwei klaren Bedingungen.`,
      answer,
      why: answer === 'x' ? 'Keine Anzeige erfüllt beide Bedingungen.' : `Anzeige ${answer} erfüllt beide Bedingungen.`,
    })),
  };
}

function sb1() {
  const grammars = ['konnektoren', 'praeposition_kasus', 'perfekt_auxiliar', 'adjektivendungen', 'relativpronomen', 'possessivartikel', 'personalpronomen', 'temporalpraeposition', 'konjunktiv2_hoeflich', 'partizip2'];
  let letter = 'Liebe Nina,\n\n';
  for (let n = 21; n <= 30; n++) letter += `wie du weißt, {${n}} ich mich sehr über deine Nachricht gefreut. `;
  letter += '\n\nViele Grüße\nSara';
  return {
    title: 'MOCK Sprachbausteine Teil 1',
    letter,
    gaps: Array.from({ length: 10 }, (_, i) => ({
      n: 21 + i,
      options: { a: `FormA${21 + i}`, b: `FormB${21 + i}`, c: `FormC${21 + i}` },
      answer: ['a', 'b', 'c'][i % 3],
      grammar: grammars[i],
      why: `Erklärung zur Lücke ${21 + i}.`,
    })),
  };
}

function sb2() {
  let letter = 'Sehr geehrte Damen und Herren,\n\n';
  for (let n = 31; n <= 40; n++) letter += `ich schreibe Ihnen, {${n}} ich mich für den Kurs interessiere. `;
  letter += '\n\nMit freundlichen Grüßen\nM. Weber';
  const bank = Array.from({ length: 15 }, (_, i) => ({ id: BANK[i], word: `WORT${BANK[i].toUpperCase()}` }));
  return {
    title: 'MOCK Sprachbausteine Teil 2',
    letter,
    bank,
    gaps: Array.from({ length: 10 }, (_, i) => ({
      n: 31 + i,
      answer: BANK[i],
      grammar: i % 2 ? 'konnektoren' : 'lexik_kollokation',
      why: `Wort ${BANK[i].toUpperCase()} passt in Lücke ${31 + i}.`,
    })),
  };
}

function hv(start, count, wordCount) {
  let script = '';
  const speakers = ['Moderator', 'Gast', 'Sprecherin', 'Anrufbeantworter'];
  for (let i = 0; i < count; i++) {
    const speaker = speakers[i % 3];
    script += `[${speaker}]: ${`Dies ist ein Hörtextabschnitt über ein Alltagsthema mit mehreren Details zu Zeit Ort und Preis. `.repeat(Math.max(1, Math.round(wordCount / 14))).trim()}\n\n`;
  }
  return {
    title: `MOCK Hörverstehen ab ${start}`,
    script,
    items: Array.from({ length: count }, (_, i) => ({
      n: start + i,
      statement: `Aussage ${start + i} über den Hörtext.`,
      answer: i % 2 === 0,
      why: `Begründung für Aussage ${start + i}.`,
    })),
  };
}

function writingTask(userText) {
  if (userText.includes('Verbindliches Register: "du"')) return {
    situation: 'Ihre Freundin Anna möchte Sie besuchen. Antworten Sie ihr per E-Mail und planen Sie das Wochenende.',
    adressat: 'Ihre Freundin Anna (du)',
    register: 'du',
    leitpunkte: ['Schlagen Sie einen Termin vor.', 'Erklären Sie die Anreise.', 'Beschreiben Sie die Übernachtungsmöglichkeit.', 'Schlagen Sie gemeinsame Aktivitäten vor.'],
    tipps: ['Persönliche Anrede verwenden.', 'Alle vier Leitpunkte behandeln.', 'Mit Liebe Grüße schließen.'],
  };
  return {
    situation: 'Sie haben an einem Deutschkurs teilgenommen und möchten sich bei der Kursleiterin bedanken. Leider haben Sie zweimal gefehlt.',
    adressat: 'Ihre Kursleiterin Frau Berger (Sie)',
    register: 'Sie',
    leitpunkte: ['Bedanken Sie sich für den Kurs.', 'Erklären Sie, warum Sie gefehlt haben.', 'Fragen Sie nach den Unterlagen.', 'Fragen Sie nach dem nächsten Kurs.'],
    tipps: ['Formelle Anrede verwenden.', 'Alle Leitpunkte behandeln.', 'Mit einer Grußformel schließen.'],
  };
}

function writingGrade() {
  return {
    criteria: [
      { key: 'aufgabe', score: 80, points: 12, comment: 'Alle vier Leitpunkte behandelt.' },
      { key: 'kommunikation', score: 78, points: 8, comment: 'Anrede und Grußformel passend.' },
      { key: 'richtigkeit', score: 66, points: 8, comment: 'Einige Kasusfehler.' },
      { key: 'ausdruck', score: 70, points: 6, comment: 'Solider Wortschatz.' },
    ],
    total: 34,
    band: 'befriedigend',
    leitpunkteCovered: [true, true, true, true],
    corrections: [
      { original: 'Ich habe gefehlt weil ich krank war', corrected: 'Ich habe gefehlt, weil ich krank war', explanation: 'Vor "weil" steht ein Komma.' },
      { original: 'Ich freue mich für die Unterlagen', corrected: 'Ich freue mich über die Unterlagen', explanation: 'Es heißt "sich freuen über".' },
    ],
    strengths: ['Klare Struktur', 'Höflicher Ton'],
    priorities: ['Kommas vor Nebensätzen', 'Verben mit Präposition'],
    modelAnswer: 'Sehr geehrte Frau Berger,\n\nich möchte mich herzlich für den Kurs bedanken. Er hat mir sehr geholfen. Leider konnte ich an den letzten beiden Terminen nicht teilnehmen, weil ich krank war. Deshalb möchte ich Sie fragen, ob ich die Unterlagen noch bekommen könnte.\n\nMit freundlichen Grüßen\nSara',
  };
}

function speakingTask() {
  return {
    title: 'MOCK Meine Heimatstadt',
    situation: 'Präsentieren Sie Ihre Heimatstadt oder Ihren Wohnort in etwa drei Minuten.',
    keywords: ['Lage', 'Größe', 'Sehenswürdigkeiten', 'Vor- und Nachteile'],
    questions: ['Würden Sie gern dort bleiben?'],
    redemittel: ['Ich möchte Ihnen … vorstellen.', 'Die Stadt liegt …', 'Ein Vorteil ist, dass …', 'Andererseits …', 'Zusammenfassend …'],
    modelAnswer: 'Ich möchte Ihnen meine Heimatstadt vorstellen. Sie liegt im Süden und hat etwa 200.000 Einwohner.',
    tipps: ['Mit einer Begrüßung beginnen.', 'Pro Stichwort zwei bis drei Sätze.'],
  };
}

function speakingGrade() {
  return {
    criteria: [
      { key: 'struktur', score: 75, comment: 'Klare Gliederung mit Einleitung und Schluss.' },
      { key: 'wortschatz', score: 68, comment: 'Themenwortschatz vorhanden, wenig Variation.' },
      { key: 'fluessigkeit', score: 62, comment: 'Mehrere Pausen, aber verständlich.' },
      { key: 'interaktion', score: 70, comment: 'Geht auf Rückfragen ein.' },
      { key: 'aussprache', score: null, comment: 'Aus Transkript nicht beurteilbar.' },
    ],
    points: 17,
    band: 'befriedigend',
    corrections: [{ original: 'Ich wohne in meine Stadt', corrected: 'Ich wohne in meiner Stadt', explanation: 'Dativ nach "in" bei einer Position.' }],
    betterPhrases: [{ said: 'Es ist gut', better: 'Es gefällt mir besonders gut, weil …' }],
    strengths: ['Verständliche Aussprache-Tendenz', 'Gute Struktur'],
    priorities: ['Mehr Konnektoren', 'Dativ nach Präpositionen'],
  };
}

let drillSequence = 0;
function drill(userText) {
  // Portable builds reject repeated AI questions. Give the fixture the same
  // opportunity to choose a fresh sentence as the real generator.
  const sentences = [
    'Ich wohne seit drei Jahren in ___ Wohnung.',
    'Der Zug hält heute an ___ kleinen Station.',
    'Morgen spricht unsere Lehrerin mit ___ neuen Kollegin.',
    'Hinter ___ alten Fabrik entsteht bald ein Park.',
    'Paul erzählt von ___ spannenden Reise nach Italien.',
  ];
  const offset = drillSequence++ % sentences.length;
  const candidates = [...sentences.slice(offset), ...sentences.slice(0, offset)];
  return {
    sentence: candidates.find(sentence => !userText.includes(sentence)) || candidates[0],
    options: { a: 'einer', b: 'eine', c: 'einen' },
    answer: 'a',
    explanation: 'Die Präposition verlangt in diesem Satz den Dativ: einer.',
  };
}

function pick(userText) {
  if (userText.includes('Leseverstehen-Teil 1')) return lv1();
  if (userText.includes('Leseverstehen-Teil 2')) return lv2();
  if (userText.includes('Leseverstehen-Teil 3')) return lv3();
  if (userText.includes('Sprachbausteine Teil 1')) return sb1();
  if (userText.includes('Sprachbausteine Teil 2')) return sb2();
  if (userText.includes('Hörverstehen Teil 1')) return hv(41, 5, 60);
  if (userText.includes('Hörverstehen Teil 2')) return hv(46, 10, 90);
  if (userText.includes('Hörverstehen Teil 3')) return hv(56, 5, 50);
  if (userText.includes('Erstelle EINE Schreibaufgabe')) return writingTask(userText);
  if (userText.includes('Bewerte diesen Text')) return writingGrade();
  if (userText.includes('Erstelle EINE Aufgabe für die mündliche')) return speakingTask();
  if (userText.includes('Bewerte diese mündliche Leistung')) return speakingGrade();
  if (userText.includes('Erstelle EINE einzelne Grammatik')) return drill(userText);
  if (userText.includes('Du erklärst einem Lernenden')) return { explanation: 'Nach "in" folgt hier der Dativ.', example: 'Sie lebt in einer kleinen Stadt.' };
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls, kinds: callLog }));
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* fall through */
  }

  if (req.url?.includes('/chat/completions')) {
    const user = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const payload = pick(user);
    calls += 1;
    callLog.push({ n: calls, length: user.length, preview: user.slice(0, 60) });

    await new Promise((r) => setTimeout(r, 120)); // pretend to think

    const envelope = {
      id: `mock-${calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'deepseek-chat',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(payload) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envelope));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock DeepSeek listening on http://127.0.0.1:${PORT} (calls served: ${calls})`);
});
