/**
 * PILOT-FEEDBACK-01 (slice FB-D) — the operator's way into the feedback table.
 *
 *   docker compose run --rm app node server/feedback.mjs <command> …
 *
 * IT CONNECTS AS `operator`, NEVER AS `migration`. That role holds EXECUTE on five functions and no table
 * privilege at all, so this file cannot read a learner's writing, cannot change a schema, and cannot touch a row
 * outside the three triage columns `operator_set_feedback_status` names. Everything it does goes through
 * `0050`'s functions — if a command here needs a new capability, that is a new function in a reviewed migration,
 * not a wider grant.
 *
 * WHY IT PRINTS THE REPORTER. Ron, 5 October 2026: "we need to ensure we are recording the user that sent the
 * message". The row records `owner_id`; a human needs the name and e-mail behind it, so every listing resolves
 * them. A row whose account is gone prints `account removed` rather than a blank field, because "we cannot say
 * who" and "we did not look" must not read the same.
 *
 * WHAT IT DOES NOT DO: it does not write feedback, does not mark content approved, and does not send anything to
 * a provider. The CSV carries learner names and addresses, so it is a PERSONAL-DATA export — its destination is
 * the operator's responsibility, and the contract says so.
 *
 * Usage:
 *   list [--status new] [--category bug] [--since 7d]
 *   show <feedback_id> [--save-screenshot <out.webp>]
 *   export --csv [--since 7d] [--screenshots <dir>]
 *   set-status <feedback_id> <triaged|fixed|wontfix> [--note "…"]
 *   summary [--round <round_id>]
 *   purge --older-than <days>
 *   seed --round <round_id> --opens <ISO> --closes <ISO> [--min-age-days 7]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { persistentConfig, persistentRolePool } from './owned-postgres/provision.mjs';

const QUESTION_SET_V1 = Object.freeze([
  { id: 'ease', type: 'scale', min: 1, max: 5 },
  { id: 'useful', type: 'scale', min: 1, max: 5 },
  { id: 'explanations', type: 'scale', min: 1, max: 5 },
  { id: 'recommend', type: 'scale', min: 0, max: 10 },
  { id: 'next', type: 'text', max_length: 1000 },
]);

const CATEGORIES = ['content_error', 'audio', 'translation', 'bug', 'idea', 'other'];
const STATUSES = ['new', 'triaged', 'fixed', 'wontfix'];

/** `7d`, `24h`, `30m` or an ISO timestamp. Returns a Date, or null when nothing was asked for. */
export function parseSince(value) {
  if (value === undefined || value === null) return null;
  const relative = /^(\d+)([dhm])$/.exec(String(value));
  if (relative) {
    const amount = Number(relative[1]);
    const unit = { d: 86400000, h: 3600000, m: 60000 }[relative[2]];
    return new Date(Date.now() - amount * unit);
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`--since must be like 7d, 24h or an ISO date (got "${value}")`);
  return parsed;
}

/** The reporter, or an explicit statement that there is none. Never an empty string. */
function reporter(row) {
  const name = row.reporter_name ? String(row.reporter_name) : null;
  const email = row.reporter_email ? String(row.reporter_email) : null;
  if (!name && !email) return 'account removed';
  return [name, email].filter(Boolean).join(' · ');
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * CSV cell: quoted where needed, and GUARDED AGAINST FORMULA INJECTION.
 *
 * A cell whose text begins with `=`, `+`, `-`, `@`, a tab or a carriage return is a FORMULA to Excel, LibreOffice
 * and Google Sheets. The learner writes `body`, so `=HYPERLINK(...)` typed into a report would be executed by the
 * spreadsheet of the person triaging it — the operator — which is a privilege boundary crossed by data rather
 * than by code. An independent reviewer raised this. Prefixing a single quote is the standard defence: the cell
 * shows the text and is not evaluated, and a leading apostrophe is what a spreadsheet already means by "literal".
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const guarded = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return /[",\n\r\t]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** Survey answers become their own columns so a spreadsheet can average them without parsing JSON. */
function answerColumns(rows) {
  const ids = new Set();
  for (const row of rows) if (row.survey_answers && typeof row.survey_answers === 'object') {
    for (const key of Object.keys(row.survey_answers)) ids.add(key);
  }
  return [...ids].sort();
}

export function buildCsv(rows, screenshotFiles = null) {
  const answers = answerColumns(rows);
  const header = ['feedback_id', 'created_at', 'kind', 'category', 'route', 'status',
    'reporter', 'interface_language', 'app_version', 'body',
    'exam_id', 'set_id', 'version', 'item_id', 'survey_round',
    ...answers.map((id) => `answer_${id}`), 'operator_note', 'handled_at'];
  // The screenshot column is FIRST when it exists, so it sits beside the id it belongs to.
  if (screenshotFiles) header.unshift('screenshot_file');
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.feedback_id, row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      row.kind, row.category, row.route, row.status, reporter(row), row.interface_language, row.app_version,
      row.body, row.exam_id, row.set_id, row.version, row.item_id, row.survey_round,
      ...answers.map((id) => (row.survey_answers ? row.survey_answers[id] ?? '' : '')),
      row.operator_note,
      row.handled_at instanceof Date ? row.handled_at.toISOString() : row.handled_at,
    ].map(csvCell).join(','));
    if (screenshotFiles) {
      lines[lines.length - 1] = `${csvCell(screenshotFiles.get(row.feedback_id) ?? '')},${lines[lines.length - 1]}`;
    }
  }
  // The BOM is what makes Excel read the file as UTF-8; without it, umlauts and Arabic arrive mangled.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** counts by category, by route, the ten most-reported items, and the survey averages including the recommend score. */
export function summarise(rows) {
  const count = (values) => {
    const map = new Map();
    for (const value of values) if (value !== null && value !== undefined && value !== '') {
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const reports = rows.filter((row) => row.kind === 'report');
  const surveys = rows.filter((row) => row.kind === 'survey' && row.survey_answers);
  const items = count(reports.map((row) => (row.item_id ? `${row.exam_id}/${row.set_id}@${row.version}#${row.item_id}` : null)));
  const scales = ['ease', 'useful', 'explanations'];
  const averages = {};
  for (const id of scales) {
    const values = surveys.map((row) => row.survey_answers?.[id]).filter((v) => typeof v === 'number');
    averages[id] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }
  const recommends = surveys.map((row) => row.survey_answers?.recommend).filter((v) => typeof v === 'number');
  const promoters = recommends.filter((v) => v >= 9).length;
  const detractors = recommends.filter((v) => v <= 6).length;
  return {
    total: rows.length,
    reports: reports.length,
    surveys: surveys.length,
    skipped: rows.filter((row) => row.kind === 'survey' && !row.survey_answers).length,
    byCategory: count(reports.map((row) => row.category)),
    byRoute: count(reports.map((row) => row.route)),
    byStatus: count(rows.map((row) => row.status)),
    topItems: items.slice(0, 10),
    averages,
    recommend: recommends.length
      ? { responses: recommends.length, score: Math.round(((promoters - detractors) / recommends.length) * 100) }
      : { responses: 0, score: null },
  };
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { flags[name] = argv[i + 1]; i += 1; }
      else flags[name] = true;
    } else positionals.push(token);
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

function usage(message) {
  if (message) console.error(`feedback: ${message}\n`);
  console.error('usage: list | show <id> | export --csv | set-status <id> <status> | summary | purge --older-than <d> | seed');
  process.exit(2);
}

async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  if (!command) usage('no command');
  const config = persistentConfig();
  // The OPERATOR pool: never the migration role (contract §4). One connection; this is a human's tool.
  const pool = persistentRolePool(config, 'operator', { max: 1 });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  try {
    if (command === 'list') {
      if (flags.status && !STATUSES.includes(flags.status)) usage(`--status must be one of ${STATUSES.join(', ')}`);
      if (flags.category && !CATEGORIES.includes(flags.category)) usage(`--category must be one of ${CATEGORIES.join(', ')}`);
      const rows = await q('SELECT * FROM operator_feedback_list($1,$2,$3,$4)',
        [null, flags.status ?? null, flags.category ?? null, parseSince(flags.since)]);
      if (!rows.length) { console.log('no feedback matches'); return; }
      console.log(`\n${rows.length} row(s)`);
      for (const row of rows) {
        console.log(`  ${row.created_at.toISOString().slice(0, 16).replace('T', ' ')}  ${String(row.status).padEnd(9)} ` +
          `${String(row.kind).padEnd(7)} ${String(row.category ?? '').padEnd(14)} ${oneLine(reporter(row)).slice(0, 34).padEnd(34)} ` +
          `${row.feedback_id}`);
      }
      return;
    }

    if (command === 'show') {
      const id = positionals[0];
      if (!id) usage('show needs a feedback_id');
      const rows = await q('SELECT * FROM operator_feedback_list($1,$2,$3,$4)', [id, null, null, null]);
      if (!rows.length) { console.error(`feedback: no report with id ${id}`); process.exit(1); }
      const row = rows[0];
      console.log(`\n${row.feedback_id}`);
      console.log(`  reported     ${row.created_at.toISOString()}  by ${reporter(row)}  (${row.owner_id})`);
      console.log(`  kind/status  ${row.kind} · ${row.status}${row.handled_at ? ` · handled ${row.handled_at.toISOString()}` : ''}`);
      console.log(`  category     ${row.category ?? '—'}    route ${row.route ?? '—'}    language ${row.interface_language}    app ${row.app_version}`);
      if (row.kind === 'report') {
        console.log(`  question     ${row.exam_id ?? '—'}/${row.set_id ?? '—'}@${row.version ?? '—'}#${row.item_id ?? '—'}`);
      } else {
        console.log(`  survey       ${row.survey_round}  ${row.survey_answers ? JSON.stringify(row.survey_answers) : '(skipped)'}`);
      }
      console.log(`\n  ${row.body ?? '(no text)'}\n`);
      if (row.operator_note) console.log(`  note: ${row.operator_note}\n`);
      if (flags['save-screenshot']) {
        const [shot] = await q('SELECT * FROM operator_feedback_screenshot($1)', [id]);
        if (!shot) { console.error('  no screenshot for this report'); process.exit(1); }
        const target = path.resolve(String(flags['save-screenshot']));
        writeFileSync(target, shot.bytes);
        console.log(`  screenshot written to ${target} (${shot.mime_type}, ${shot.width}x${shot.height}, ${shot.bytes.length} bytes)`);
      }
      return;
    }

    if (command === 'export') {
      if (!flags.csv) usage('export currently supports --csv only');
      const rows = await q('SELECT * FROM operator_feedback_list($1,$2,$3,$4)', [null, null, null, parseSince(flags.since)]);
      /*
       * THE SCREENSHOT COLUMN IS BUILT WITH THE CSV, NOT SPLICED INTO IT. The first version wrote the CSV, then
       * prepended a header by string surgery — which put a SECOND `screenshot_file` on the header line
       * (`replace` had already renamed the first) and moved the BOM off byte 0, so Excel read the file as the
       * wrong encoding and the umlauts and Arabic arrived mangled. The reviewer found both. Building the column
       * where the other columns are built makes those two failures impossible rather than unlikely.
       */
      const screenshotFiles = new Map();
      if (flags.screenshots) {
        const dir = path.resolve(String(flags.screenshots));
        for (const row of rows) {
          const [shot] = await q('SELECT * FROM operator_feedback_screenshot($1)', [row.feedback_id]);
          if (!shot) continue;
          const suffix = shot.mime_type === 'image/png' ? 'png' : 'webp';
          writeFileSync(path.join(dir, `${row.feedback_id}.${suffix}`), shot.bytes);
          screenshotFiles.set(row.feedback_id, `${row.feedback_id}.${suffix}`);
        }
      }
      process.stdout.write(buildCsv(rows, screenshotFiles.size ? screenshotFiles : null));
      return;
    }

    if (command === 'set-status') {
      const [id, status] = positionals;
      if (!id || !status) usage('set-status needs <feedback_id> <status>');
      if (!['triaged', 'fixed', 'wontfix'].includes(status)) usage('status must be triaged, fixed or wontfix');
      const note = typeof flags.note === 'string' ? flags.note : null;
      const [result] = await q('SELECT operator_set_feedback_status($1,$2,$3) AS ok', [id, status, note]);
      console.log(result.ok ? `updated ${id} -> ${status}` : `no report with id ${id}`);
      if (!result.ok) process.exit(1);
      return;
    }

    if (command === 'summary') {
      const rows = await q('SELECT * FROM operator_feedback_list($1,$2,$3,$4)', [null, null, null, null]);
      const scoped = flags.round ? rows.filter((row) => row.survey_round === flags.round) : rows;
      const summary = summarise(scoped);
      console.log(`\nfeedback summary${flags.round ? ` (round ${flags.round})` : ''}`);
      console.log(`  total ${summary.total} — ${summary.reports} report(s), ${summary.surveys} survey answer(s), ${summary.skipped} skip(s)`);
      const table = (label, pairs) => {
        if (!pairs.length) return;
        console.log(`  ${label}: ${pairs.map(([k, n]) => `${k} ${n}`).join(' · ')}`);
      };
      table('by category', summary.byCategory);
      table('by route   ', summary.byRoute);
      table('by status  ', summary.byStatus);
      if (summary.topItems.length) {
        console.log('  most-reported items:');
        for (const [item, n] of summary.topItems) console.log(`    ${String(n).padStart(4)}  ${item}`);
      }
      const avg = (v) => (v === null ? '—' : v.toFixed(2));
      console.log(`  survey averages: ease ${avg(summary.averages.ease)} · useful ${avg(summary.averages.useful)} · explanations ${avg(summary.averages.explanations)}`);
      console.log(`  recommend score: ${summary.recommend.score === null ? '—' : summary.recommend.score} (from ${summary.recommend.responses} response(s); %9-10 minus %0-6)`);
      console.log('');
      return;
    }

    if (command === 'purge') {
      const days = Number(flags['older-than']);
      if (!Number.isInteger(days) || days < 30) usage('purge needs --older-than <days>, at least 30');
      const [result] = await q('SELECT operator_purge_feedback($1) AS removed', [days]);
      console.log(`purged ${result.removed} report(s) older than ${days} day(s)`);
      return;
    }

    if (command === 'seed') {
      const round = flags.round;
      if (!round) usage('seed needs --round <round_id>');
      const opens = new Date(String(flags.opens ?? ''));
      const closes = new Date(String(flags.closes ?? ''));
      if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) usage('seed needs --opens and --closes as ISO timestamps');
      const minAge = flags['min-age-days'] === undefined ? 7 : Number(flags['min-age-days']);
      const [result] = await q('SELECT operator_seed_survey_round($1,$2,$3,$4::jsonb,$5) AS seeded',
        [round, opens, closes, JSON.stringify(QUESTION_SET_V1), minAge]);
      console.log(result.seeded
        ? `seeded round ${round}: ${opens.toISOString()} .. ${closes.toISOString()}, ${QUESTION_SET_V1.length} questions, min age ${minAge} day(s)`
        : `round ${round} already exists — its id and question set are frozen, so nothing changed`);
      return;
    }

    usage(`unknown command "${command}"`);
  } finally {
    await pool.end().catch(() => {});
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  await main();
}
