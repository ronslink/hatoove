/**
 * WORKFLOW SHAPE — the structural problems in a GitHub Actions file that break it SILENTLY.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A YAML PARSER. On 2 October 2026 the new `rendered` job in
 * `.github/workflows/ci.yml` contained:
 *
 *     - name: The real stack: migrations, API, worker and account lifecycle
 *
 * An UNQUOTED COLON-SPACE inside a plain scalar is a MAPPING in YAML, so the whole workflow was invalid and
 * **every job would have failed to start**. Reading the file did not show it; one line of a real parser did
 * (`L219.C29 mapping values are not allowed in this context`).
 *
 * The honest fix would be a parser, and there is nowhere to put one: the root package is deliberately
 * `"dependencies": {}`, and `repository-check.mjs` is deliberately dependency-free. So this module checks the
 * handful of properties that (a) actually break a workflow, (b) cannot be seen by reading, and (c) need no
 * parser — by tracking indentation and parent scopes, which is all YAML's block structure requires.
 *
 * THE THREE RULES, each one a defect that has either happened here or is one keystroke away:
 *
 *   1. AN UNQUOTED COLON-SPACE IN A SCALAR VALUE — the measured failure above. Block scalars (`run: |`) are
 *      exempt, because their bodies are shell text where a colon-space is perfectly legal and routinely
 *      present; getting that wrong would make this check cry wolf on half the file.
 *   2. A DUPLICATE KEY IN THE SAME MAPPING — YAML's own rule, and a job silently replacing another job is the
 *      worst possible outcome of a merge. Sequence items (`- name: …`) are NOT keys and must not be counted.
 *   3. A JOB WITHOUT `runs-on` OR `timeout-minutes` — a job with no runner cannot run, and a job with no
 *      timeout can hang for the platform's six-hour default, which is how a stuck gate becomes an ignored one.
 *      Every job in this repository's workflow carries a timeout; this keeps it that way.
 *
 * @param {string} text the workflow file's contents
 * @returns {string[]} human-readable problems, each naming the line; empty means the shape is sound
 */
export function workflowShapeProblems(text) {
  const problems = [];
  const lines = String(text).split(/\r?\n/);
  const indentOf = (line) => (/^\s*/.exec(line) || [''])[0].length;
  const isBlankOrComment = (line) => line.trim() === '' || line.trim().startsWith('#');

  /* ---------------------------------------------------------------- rule 1 */

  /*
   * Block scalars: a line whose value is `|`, `>` or one of their chomping/indent variants opens a body that
   * continues while the indentation is deeper than the KEY's. Tracked so the body is skipped rather than
   * parsed — the difference between a useful check and one that flags every shell script in the file.
   */
  let blockUntilIndent = null;
  for (const [index, line] of lines.entries()) {
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (blockUntilIndent !== null) {
      // A block body ends at the first non-blank line that is not deeper than its key.
      if (indent > blockUntilIndent) continue;
      blockUntilIndent = null;
    }
    // `key: |`, `key: >-`, `- run: |` … opens a block whose content is shell text, not YAML.
    if (/^\s*(?:-\s+)?[\w.$-]+:\s*[|>][-+\d]*\s*$/.test(line)) {
      blockUntilIndent = indent;
      continue;
    }
    const match = /^(\s*)(?:-\s+)?([\w.$-]+):\s*(\S.*)$/.exec(line);
    if (!match) continue;
    const value = match[3];
    // A quoted scalar, or an inline flow collection, is YAML's own way of saying "this is one value".
    const quoted = /^(['"]).*\1$/.test(value) || value.startsWith('[') || value.startsWith('{');
    if (!quoted && value.includes(': ')) {
      problems.push(`line ${index + 1}: unquoted ": " inside a scalar value — YAML reads it as a nested mapping, `
        + `which makes the whole file invalid. Quote the value or rewrite it: ${line.trim().slice(0, 100)}`);
    }
  }

  /* ---------------------------------------------------------------- rule 2 */

  /*
   * Duplicate keys, scoped by PARENT: `runs-on:` under two different jobs is two keys in two mappings, not a
   * duplicate. The parent of a line is the nearest preceding line with a SMALLER indent that is a key, which
   * is what the stack below maintains.
   *
   * A SEQUENCE ITEM IS ITS OWN SCOPE, and this is the part the first version got wrong: in
   *
   *     steps:
   *       - name: one
   *         run: echo a
   *       - name: two
   *         run: echo b
   *
   * the two `run:` keys are in DIFFERENT mappings (one per list item). Treating them as one parent reported a
   * duplicate for every step after the first — twenty-eight false positives on this repository's own workflow,
   * which is exactly the kind of noise that gets a check switched off. So a list item pushes a scope at the
   * column of ITS first key, and the next item at the same indent pops it.
   */
  const stack = []; // [{indent, keys: Map<key, lineNumber>}] — one per mapping, keyed by its keys' indent
  const declare = (key, indent, lineNumber) => {
    // The owning mapping is the most recent scope whose keys sit at THIS indent; anything deeper is closed.
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
    if (!stack.length || stack[stack.length - 1].indent < indent) stack.push({ indent, keys: new Map() });
    const scope = stack[stack.length - 1];
    const prior = scope.keys.get(key);
    if (prior === undefined) scope.keys.set(key, lineNumber);
    else {
      problems.push(`line ${lineNumber}: duplicate key "${key}" in the same mapping (first seen on line `
        + `${prior}) — YAML keeps one of them, silently, which is how a job disappears in a merge`);
    }
  };
  for (const [index, line] of lines.entries()) {
    if (isBlankOrComment(line)) continue;
    const item = /^(\s*)-\s+([\w.$-]+):/.exec(line);
    if (item) {
      /*
       * A LIST ITEM OPENS ITS OWN MAPPING, at the column of its first key. This is the part the first version
       * got wrong: in
       *
       *     steps:
       *       - name: one
       *         run: echo a
       *       - name: two
       *         run: echo b
       *
       * the two `run:` keys live in DIFFERENT mappings, one per item. Treating them as one parent reported a
       * duplicate for every step after the first — twenty-eight false positives on this repository's own
       * workflow, which is exactly the noise that gets a check switched off.
       */
      const keyIndent = line.indexOf(item[2], item[1].length);
      while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
      stack.push({ indent: keyIndent, keys: new Map() });
      declare(item[2], keyIndent, index + 1);
      continue;
    }
    if (/^\s*-/.test(line)) continue; // a list item whose value is a scalar
    const match = /^(\s*)([\w.$-]+):(\s|$)/.exec(line);
    if (!match) continue;
    declare(match[2], indentOf(line), index + 1);
  }

  /* ---------------------------------------------------------------- rule 3 */

  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) {
    problems.push('no top-level "jobs:" mapping — a workflow with no jobs cannot do anything');
  } else {
    const jobIndent = lines.slice(jobsAt + 1).find((line) => !isBlankOrComment(line) && indentOf(line) > 0);
    const jobIndentSize = jobIndent ? indentOf(jobIndent) : 2;
    let current = null;
    for (let index = jobsAt + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (isBlankOrComment(line)) continue;
      const indent = indentOf(line);
      if (indent === 0) break; // the next top-level key ends the jobs mapping
      if (indent === jobIndentSize) {
        const name = /^\s*([\w.$-]+):/.exec(line);
        if (name) current = { name: name[1], line: index + 1, hasRunner: false, hasTimeout: false };
        continue;
      }
      if (!current) continue;
      if (/^\s*runs-on:/.test(line)) current.hasRunner = true;
      if (/^\s*timeout-minutes:/.test(line)) current.hasTimeout = true;
    }
    // Collected in document order so the messages read like the file.
    const jobs = [];
    let active = null;
    for (let index = jobsAt + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (isBlankOrComment(line)) continue;
      const indent = indentOf(line);
      if (indent === 0) break;
      if (indent === jobIndentSize) {
        const name = /^\s*([\w.$-]+):/.exec(line);
        if (name) { active = { name: name[1], line: index + 1, hasRunner: false, hasTimeout: false }; jobs.push(active); }
        continue;
      }
      if (!active) continue;
      if (/^\s*runs-on:/.test(line)) active.hasRunner = true;
      if (/^\s*timeout-minutes:/.test(line)) active.hasTimeout = true;
    }
    for (const job of jobs) {
      if (!job.hasRunner) problems.push(`line ${job.line}: job "${job.name}" has no "runs-on", so it can never run`);
      if (!job.hasTimeout) {
        problems.push(`line ${job.line}: job "${job.name}" has no "timeout-minutes" — a job without a timeout `
          + 'can hang for the platform default, which is how a gate becomes one people ignore');
      }
    }
  }

  return problems;
}
