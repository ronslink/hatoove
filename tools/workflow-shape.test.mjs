/*
 * THE WORKFLOW-SHAPE CHECK MUST BE ABLE TO FAIL, and each of its rules must fail for its own reason.
 *
 * `node --test tools/workflow-shape.test.mjs`
 *
 * This file exists because of a defect in the check that guards this repository's own workflows. Its first
 * version read the workflow with `fs.readFileSync` in a checker that imports no `fs`; the call threw, a
 * `catch { continue; }` swallowed it, and the leg reported NOTHING while looking like it passed. What exposed
 * it was running the discrimination test properly — so the discrimination test is now part of the artefact
 * rather than a thing someone did once.
 *
 * Four mutations, one per rule plus the false-positive guard:
 *   A. an unquoted colon-space in a scalar value  -> the measured CI-breaking defect
 *   B. a duplicate key in the same mapping        -> a job silently replacing another
 *   C. a job with no timeout-minutes              -> a gate that can hang for six hours
 *   D. COLON-SPACE INSIDE A BLOCK SCALAR          -> must NOT be reported (shell text, not YAML)
 *
 * D is the one that decides whether this check is usable: `run: |` bodies are shell, they contain colons and
 * spaces constantly, and a check that flags them would be switched off within a week.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

import { workflowShapeProblems } from './workflow-shape.mjs';

/** The real workflow, and the real second one, must be clean — otherwise the check is noise from the start. */
const REAL = [
  '.github/workflows/ci.yml',
  '.github/workflows/pilot-contracts.yml',
];

test('the workflows this repository actually ships have a sound shape', () => {
  for (const file of REAL) {
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(workflowShapeProblems(text), [], `${file} has structural problems`);
  }
});

const BASE = [
  'name: Example',
  'on:',
  '  pull_request:',
  'jobs:',
  '  first:',
  "    name: First job",
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - uses: actions/checkout@abc # v1',
  '      - name: Say hello',
  '        run: echo hello',
  '',
].join('\n');

test('the base fixture is sound, so every mutation below is the ONLY difference', () => {
  assert.deepEqual(workflowShapeProblems(BASE), []);
});

test('A: an unquoted colon-space in a scalar value is reported', () => {
  const mutated = BASE.replace('      - name: Say hello', '      - name: Say hello: and more');
  const problems = workflowShapeProblems(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /unquoted ": "/);
  assert.match(problems[0], /line 11/, 'and it names the line');
});

test('A2: QUOTING the same value clears it, which is the fix the message recommends', () => {
  const quoted = BASE.replace('      - name: Say hello', '      - name: "Say hello: and more"');
  assert.deepEqual(workflowShapeProblems(quoted), []);
});

test('B: a duplicate key in the same mapping is reported', () => {
  const mutated = `${BASE}  first:\n    name: Duplicate job\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n`;
  const problems = workflowShapeProblems(mutated);
  assert.ok(problems.some((problem) => /duplicate key "first"/.test(problem)),
    `expected a duplicate-key problem, got ${JSON.stringify(problems)}`);
});

test('B2: the same key under DIFFERENT parents is not a duplicate', () => {
  const two = BASE.replace('      - name: Say hello', '      - name: Say hello')
    + '  second:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n';
  // `runs-on` now appears under both jobs: two mappings, two keys, no duplicate.
  assert.deepEqual(workflowShapeProblems(two), []);
});

test('C: a job with no timeout-minutes is reported', () => {
  const mutated = BASE.replace('    timeout-minutes: 5\n', '');
  const problems = workflowShapeProblems(mutated);
  assert.ok(problems.some((problem) => /no "timeout-minutes"/.test(problem)),
    `expected a timeout problem, got ${JSON.stringify(problems)}`);
});

test('C2: a job with no runs-on is reported', () => {
  const mutated = BASE.replace('    runs-on: ubuntu-latest\n', '');
  const problems = workflowShapeProblems(mutated);
  assert.ok(problems.some((problem) => /no "runs-on"/.test(problem)),
    `expected a runner problem, got ${JSON.stringify(problems)}`);
});

test('D: a colon-space INSIDE a block scalar is shell text and must not be reported', () => {
  const withBlock = BASE.replace('        run: echo hello', [
    '        run: |',
    '          echo "note: this colon is shell, not YAML"',
    '          case "$x" in',
    '            a) echo one: two ;;',
    '          esac',
  ].join('\n'));
  assert.deepEqual(workflowShapeProblems(withBlock), [],
    'a block scalar body is shell text; flagging it would make this check unusable');
});

test('D2: a block scalar ENDS, and the next key is checked again', () => {
  /*
   * `working-directory`, not `name`: the first version of this fixture reused `name:` and the validator
   * reported TWO problems — the colon-space it was aiming at, AND a genuine duplicate key, because a step's
   * `name` was already declared on the item line. The validator was right and the fixture was wrong, which is
   * the useful direction for that surprise to go; isolating one rule per mutation is why it is worth stating.
   */
  const withBlock = BASE.replace('        run: echo hello', [
    '        run: |',
    '          echo "note: shell colon"',
    '        shell: bash',
    '        working-directory: Bad: value after the block',
  ].join('\n'));
  const problems = workflowShapeProblems(withBlock);
  assert.equal(problems.length, 1, `expected the post-block key to be checked, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /unquoted ": "/);
  assert.match(problems[0], /line 15/, 'block content is skipped, and the key after it is not');
});

test('a workflow with no jobs at all is reported', () => {
  const problems = workflowShapeProblems('name: Empty\non:\n  push:\n');
  assert.ok(problems.some((problem) => /no top-level "jobs:"/.test(problem)), JSON.stringify(problems));
});

test('comments are ignored, including one that contains a colon-space', () => {
  const commented = BASE.replace('  pull_request:', '  pull_request:\n# a comment: with a colon\n');
  assert.deepEqual(workflowShapeProblems(commented), []);
});
