#!/usr/bin/env node
/**
 * PILOT ACCESS — the operator's queue of pilot account requests (migration `0041`).
 *
 *     docker compose run --rm app node server/access.mjs list [--status=open|invited|declined]
 *     docker compose run --rm app node server/access.mjs decline <email>
 *     docker compose run --rm app node server/access.mjs purge --email <email>
 *     docker compose run --rm app node server/access.mjs purge --older-than <days>
 *
 * WHY A COMMAND AND NOT A SCREEN. During the pilot the front door asks for an account instead of opening
 * the sign-up form, and a person on the team provisions each account by hand: the requests are read here,
 * one at a time, by the operator who is already at a terminal. An operator HTTP surface would be a second
 * authenticated public endpoint with its own session, its own CSRF story and its own noindex rules — a
 * larger surface, for a job that happens a few times a day. There is deliberately NO HTTP route that reads
 * or removes the queue: `POST /api/auth/request-access` can only ever add to it.
 *
 * THIS COMMAND ISSUES NOTHING. It does not create an account, generate a code or send a message; the
 * invite gate and code issuance are their own slice, and there is no email provider (P-03 undecided), so
 * nothing in this file could send one even by accident. `decline` and `purge` are the two housekeeping
 * actions the operator needs today, and `status` already carries the `invited` value that slice will set.
 *
 * IT CONNECTS AS THE RESTRICTED `auth` ROLE, because `account_request` is an auth-support table: the rows
 * are people with no account yet, so no learner, worker, deletion or payments role may read who asked for
 * access. That is also why the command runs inside the app image (`docker compose run app`) — it uses the
 * same credentials the server already has, and no new access is created for it.
 *
 * SAFETY. `purge` deletes rows, so it names exactly what it removed, and it never touches the schema:
 * there is no DROP here and no migration. `--older-than` must be a positive whole number of days, so a
 * stray zero cannot empty a queue that was filled a minute ago. The command refuses the `postgres`,
 * `template0` and `template1` databases, like `migrate.mjs`, and it never reads or writes `"user"`.
 *
 * Exit codes: 0 success; 1 nothing was declined (or a targeted `purge --email` matched no row); 2 the
 * command line, the configuration or the connection was wrong — so a wrapper fails on a typo instead of
 * reporting a clean run.
 */

import { persistentConfig, persistentRolePool } from './owned-postgres/provision.mjs';
import { createPostgresAccountRequests, ACCOUNT_REQUEST_STATUSES } from './owned-postgres/account-requests.mjs';

/** Databases this command refuses, exactly as `migrate.mjs` does: these are never an installation. */
const FORBIDDEN_DATABASES = new Set(['postgres', 'template0', 'template1']);

export const USAGE = `usage: node server/access.mjs <command>
  list [--status=open|invited|declined]   the request queue, oldest first
  decline <email>                         mark one open request declined
  purge --email <email>                   delete one request
  purge --older-than <days>               delete requests older than <days> (1-3650)

Run it through the app image so it uses the server's own credentials:
  docker compose run --rm app node server/access.mjs list`;

/** A command-line error, kept distinct from a database failure so the exit codes can differ. */
export class AccessUsageError extends Error {}

/**
 * Split `--name=value` and `--name value` from positional arguments. Both spellings are accepted because
 * both are what people type and the usage line shows the space form; accepting only one is how a command
 * ends up with two grammars that disagree. A flag with no value, or an unknown flag, is a usage error
 * rather than something silently ignored.
 *
 * @returns {{flags: Map<string,string>, rest: string[]}}
 */
function splitFlags(args, allowed) {
  const flags = new Map();
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inline = /^--([a-z-]+)=(.*)$/.exec(arg);
    const separate = /^--([a-z-]+)$/.exec(arg);
    if (inline || separate) {
      const name = (inline || separate)[1];
      if (!allowed.includes(name)) throw new AccessUsageError(`unknown option --${name}`);
      if (flags.has(name)) throw new AccessUsageError(`--${name} was given twice`);
      let value = inline ? inline[2] : args[index + 1];
      if (!inline) {
        if (value === undefined || value.startsWith('--')) throw new AccessUsageError(`--${name} needs a value`);
        index += 1;
      }
      flags.set(name, value);
      continue;
    }
    rest.push(arg);
  }
  return { flags, rest };
}

/**
 * Turn an argument list into `{command, ...}`. PURE, and it runs before anything connects: a typo must
 * fail on the command line rather than after a pool is open and a schema is in reach.
 *
 * @param {string[]} argv arguments after `node server/access.mjs`
 * @returns {{command: string, status?: string, email?: string, olderThanDays?: number, help?: boolean}}
 */
export function parseAccessArgs(argv) {
  const args = [...argv];
  if (!args.length) throw new AccessUsageError('no command');
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', help: true };
  const command = args.shift();
  if (command === 'list') {
    const { flags, rest } = splitFlags(args, ['status']);
    if (rest.length) throw new AccessUsageError(`list takes no arguments, got "${rest.join(' ')}"`);
    const status = flags.get('status') ?? null;
    if (status !== null && !ACCOUNT_REQUEST_STATUSES.includes(status)) {
      throw new AccessUsageError(`--status must be one of ${ACCOUNT_REQUEST_STATUSES.join(', ')}`);
    }
    return { command, status };
  }
  if (command === 'decline') {
    if (args.length !== 1) throw new AccessUsageError('decline takes exactly one email address');
    return { command, email: args[0] };
  }
  if (command === 'purge') {
    const { flags, rest } = splitFlags(args, ['email', 'older-than']);
    /*
     * EXACTLY ONE SELECTOR. `--email a@b` names one person's request; `--older-than 30` is the retention
     * sweep. Accepting both would make "delete this one, or everything old, whichever" a question nobody
     * can answer afterwards from the command, and the port refuses the same ambiguity again so a caller
     * that bypasses this parser still cannot delete by accident.
     */
    if (rest.length) throw new AccessUsageError(`purge takes no positional arguments, got "${rest.join(' ')}"`);
    const email = flags.get('email');
    const age = flags.get('older-than');
    if ((email === undefined ? 0 : 1) + (age === undefined ? 0 : 1) !== 1) {
      throw new AccessUsageError('purge takes exactly one of --email <address> or --older-than <days>');
    }
    if (email !== undefined) return { command, email };
    if (!/^[0-9]{1,4}$/.test(age) || Number(age) < 1 || Number(age) > 3650) {
      throw new AccessUsageError('--older-than must be a whole number of days between 1 and 3650');
    }
    return { command, olderThanDays: Number(age) };
  }
  throw new AccessUsageError(`unknown command "${command}"`);
}

/** One request, one line. Widths are fixed so a long address cannot be mistaken for another column. */
export function formatRequest(row) {
  const at = (value) => (value instanceof Date ? value.toISOString() : String(value ?? ''));
  return [
    at(row.created_at).slice(0, 16).replace('T', ' '),
    String(row.status).padEnd(8),
    String(row.language).padEnd(2),
    String(row.email).padEnd(40),
    String(row.name).slice(0, 40),
    `consent:${row.consent_version}`,
  ].join('  ');
}

/**
 * Run one command against an injected port, so a check can drive the REAL argument handling and the REAL
 * output with the same port the product uses (never a re-implementation of it).
 *
 * @param {string[]} argv
 * @param {{requests: object, log?: Function, error?: Function}} options
 * @returns {Promise<number>} the process exit code
 */
export async function runAccessCommand(argv, { requests, log = console.log, error = console.error } = {}) {
  if (!requests || typeof requests.list !== 'function') throw new TypeError('runAccessCommand requires the account-request port');
  const parsed = parseAccessArgs(argv);
  if (parsed.command === 'help') {
    log(USAGE);
    return 0;
  }
  if (parsed.command === 'list') {
    const rows = await requests.list(parsed.status ? { status: parsed.status } : {});
    if (!rows.length) {
      log(parsed.status ? `no ${parsed.status} account requests` : 'no account requests');
      return 0;
    }
    log(`${rows.length} account request(s)${parsed.status ? ` (${parsed.status})` : ''}:`);
    for (const row of rows) log(formatRequest(row));
    return 0;
  }
  if (parsed.command === 'decline') {
    const outcome = await requests.decline(parsed.email);
    if (outcome.declined) {
      log(`declined ${parsed.email}`);
      return 0;
    }
    // "No such request" and "already handled" are different answers, and saying one for both is how a
    // typo becomes a silent no-op somebody believes they performed.
    error(outcome.found
      ? `no open request for ${parsed.email} (it is already handled)`
      : `no request for ${parsed.email}`);
    return 1;
  }
  const outcome = parsed.email
    ? await requests.purge({ email: parsed.email })
    : await requests.purge({ olderThanDays: parsed.olderThanDays });
  for (const email of outcome.emails) log(`removed ${email}`);
  log(parsed.email
    ? `removed ${outcome.removed} request(s) for ${parsed.email}`
    : `removed ${outcome.removed} request(s) older than ${parsed.olderThanDays} day(s)`);
  // A named address that matched nothing is a typo; a retention sweep that matched nothing is a quiet day.
  return parsed.email && outcome.removed === 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('access.mjs');

if (invokedDirectly) {
  let pool = null;
  try {
    // Parse BEFORE connecting, and require the target to be named explicitly.
    const argv = process.argv.slice(2);
    parseAccessArgs(argv);
    const database = process.env.OWNAPI_PG_DATABASE || '';
    if (!database) throw new AccessUsageError('OWNAPI_PG_DATABASE must name the installation database');
    if (FORBIDDEN_DATABASES.has(database)) throw new AccessUsageError(`refusing to read or change ${database}`);
    // `persistentConfig` validates the schema, the role prefix and the credentials before a connection.
    const config = persistentConfig(process.env);
    pool = persistentRolePool(config, 'auth', { max: 2 });
    const requests = createPostgresAccountRequests({ pool });
    process.exitCode = await runAccessCommand(argv, { requests });
  } catch (failure) {
    if (failure instanceof AccessUsageError) {
      console.error(`access: ${failure.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      // No message from the driver, no SQL, no credential: the same redaction rule the HTTP API follows.
      console.error(`access: FAILED ${failure && failure.code ? failure.code : (failure && failure.message) || 'unknown'}`);
      process.exitCode = 2;
    }
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
