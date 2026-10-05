/*
 * PILOT-FEEDBACK-01 (slice FB-D) — the operator CSV, which carries learner text into a spreadsheet.
 *
 * WHY THIS IS ITS OWN CHECK. `buildCsv` is pure, so the two defects an independent reviewer found in it are
 * reachable without a database or a browser — and both were of the kind that a human reading the code approves:
 *
 *   * FORMULA INJECTION. A cell beginning `=`, `+`, `-`, `@`, tab or CR is a FORMULA to Excel, LibreOffice and
 *     Google Sheets. `body` is written by the learner and read by the operator, so `=HYPERLINK(...)` typed into a
 *     report would be executed in the operator's spreadsheet — a privilege boundary crossed by data.
 *   * THE `--screenshots` COLUMN. The first version built the CSV and then prepended the column by string
 *     surgery, which produced TWO `screenshot_file` headers (`replace` had already renamed the first) and moved
 *     the BOM off byte 0, so Excel read the file as the wrong encoding and mangled the umlauts and Arabic.
 *
 * It also pins the things that were already right and are easy to break while fixing those: the BOM, the answer
 * columns, and the fact that ordinary learner text is NOT escaped into uselessness.
 *
 * Usage: node tools/pilot-feedback-csv-check.mjs   (exit 0 when every leg passes)
 */

import assert from 'node:assert/strict';

import { buildCsv } from '../server/feedback.mjs';

const results = [];
function check(name, run) {
  try {
    run();
    results.push([name, true, '']);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const base = {
  created_at: new Date(0), kind: 'report', category: 'bug', route: 'heute', status: 'new',
  reporter_name: 'Ron', reporter_email: 'r@example.invalid', interface_language: 'de', app_version: 'unknown',
  exam_id: null, set_id: null, version: null, item_id: null, survey_round: null, survey_answers: null, handled_at: null,
};
const rows = [
  { ...base, feedback_id: 'aaa', body: '=HYPERLINK("http://evil.example","click")', operator_note: '+49 30 1234' },
  { ...base, feedback_id: 'bbb', body: 'Ganz normale Beschreibung mit Umlaut: Hören', operator_note: null },
  { ...base, feedback_id: 'ccc', kind: 'survey', survey_round: 'r1', survey_answers: { ease: 4, next: 'Mehr Hörbeispiele.' } },
];
const shots = new Map([['aaa', 'aaa.webp']]);
const withShots = buildCsv(rows, shots);
const plain = buildCsv(rows);
const lines = withShots.slice(1).split('\r\n').filter(Boolean);
const header = lines[0].split(',');

check('1. the BOM is the first character, so Excel reads UTF-8', () => {
  assert.equal(withShots.charCodeAt(0), 0xfeff, 'the BOM must be at byte 0 or umlauts and Arabic arrive mangled');
  assert.equal(plain.charCodeAt(0), 0xfeff);
});

check('2. --screenshots adds exactly ONE leading column', () => {
  assert.equal(header.filter((name) => name === 'screenshot_file').length, 1,
    'a second screenshot_file header means the column was spliced in after the first rename');
  assert.equal(header.slice(0, 2).join(','), 'screenshot_file,feedback_id', 'it must sit beside the id it belongs to');
  assert.equal(plain.slice(1).split('\r\n')[0].startsWith('feedback_id,'), true,
    'without --screenshots there is no such column at all');
});

check('3. a learner-written formula is neutralised', () => {
  // The body is the learner's; the spreadsheet belongs to the operator.
  assert.ok(lines[1].includes("'=HYPERLINK"), 'a =formula body must be prefixed so no spreadsheet evaluates it');
  assert.ok(lines[1].includes("'+49 30"), 'a +49 phone-shaped note is a formula to a spreadsheet too');
});

check('4. ordinary text is left alone', () => {
  assert.ok(lines[2].includes('Hören'), 'an umlaut must survive the round trip');
  assert.ok(!lines[2].includes("'Ganz normale"), 'text that is not a formula must NOT be prefixed');
});

check('5. survey answers still get their own columns', () => {
  assert.ok(header.includes('answer_ease') && header.includes('answer_next'),
    'answers are spread into columns so a spreadsheet can average them without parsing JSON');
  assert.ok(lines[3].includes('4') && lines[3].includes('Mehr Hörbeispiele'),
    'the answer values must reach their columns');
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n---- pilot-feedback-csv-check: ${results.length - failed.length}/${results.length} passed ----`);
if (failed.length) {
  for (const [name, , detail] of failed) console.log(`  FAIL  ${name}: ${detail}`);
  process.exit(1);
}
console.log('all legs passed');
