#!/usr/bin/env node
/**
 * EXAM-S2 — focused offline tests for the coordinator-owned package contract.
 *
 * These tests import the REAL `validatePackage` / `canonicalJson` / `packageHash` from
 * `server/package-contract.mjs` and run the three version-controlled source documents plus the
 * required negative mutations through it. They deliberately do NOT re-implement the contract and do
 * not mirror its shape with a different one: a second structural validator would be a divergent
 * source of truth for the same identity.
 *
 * The contract module is root/coordinator-owned and is not committed here. When it is absent this
 * tool exits non-zero — there is no PENDING mode that lets CI pass silently.
 *
 * Usage
 *   node tools/exam-s2-package-check.mjs
 *   node tools/exam-s2-package-check.mjs --source-root <dir>   # dir holding server/package-contract.mjs
 *   EXAM_S2_PACKAGE_CONTRACT=/abs/server/package-contract.mjs node tools/exam-s2-package-check.mjs
 *
 * Exit codes: 0 every test passed; 1 a test failed; 2 the contract module or a source document is missing.
 *
 * Tested boundaries (each calls the real validator; the positives assert acceptance, the negatives
 * assert an `invalid_package` rejection):
 *   accept  valid telc manifest · internal DTZ fixture · English fractional scale
 *   reject  duplicate form · duplicate member · missing version · protected field in payload ·
 *           invalid answer option · unsupported interaction (renderer) · unknown top-level field ·
 *           set examId mismatch · incomplete DTZ marked available · complete-written form
 *   hash    canonicalJson/packageHash deterministic, key-order independent and non-mutating
 *
 * Out of scope here (root PostgreSQL / independent review, not claimed offline): existing-DB
 * reference validity and atomic import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CONTRACT_ENV = 'EXAM_S2_PACKAGE_CONTRACT';
const CONTRACT_RELATIVE = path.join('server', 'package-contract.mjs');
const DOCUMENTS = [
  ['telc manifest', path.join('content', 'exams', 'telc-deutsch-b1', 'manifest.json')],
  ['dtz-internal fixture', path.join('content', 'fixtures', 'exams', 'dtz-internal.json')],
  ['english-scale fixture', path.join('content', 'fixtures', 'exams', 'english-scale.json')],
];

/** Locate the root module: explicit env, then --source-root, then the normal repo path. */
function locateContract(argv) {
  const at = argv.indexOf('--source-root');
  const root = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : REPO;
  const candidates = [...new Set([
    process.env[CONTRACT_ENV],
    path.join(root, CONTRACT_RELATIVE),
    path.join(REPO, CONTRACT_RELATIVE),
  ].filter(Boolean))];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    console.error(`exam-s2-package-check: contract module not found. Looked for: ${candidates.join(', ')}`);
    console.error(`exam-s2-package-check: set ${CONTRACT_ENV} or place the coordinator module at ${CONTRACT_RELATIVE}.`);
    process.exit(2);
  }
  return path.resolve(found);
}

const contractPath = locateContract(process.argv.slice(2));
const contract = await import(pathToFileURL(contractPath).href);
for (const name of ['validatePackage', 'canonicalJson', 'packageHash']) {
  if (typeof contract[name] !== 'function') {
    console.error(`exam-s2-package-check: ${contractPath} does not export ${name}()`);
    process.exit(2);
  }
}
const { validatePackage, canonicalJson, packageHash } = contract;

let documents;
try {
  documents = Object.fromEntries(DOCUMENTS.map(([label, rel]) => [label, JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'))]));
} catch (error) {
  console.error(`exam-s2-package-check: cannot read a source document: ${error.message}`);
  process.exit(2);
}
const telc = documents['telc manifest'];
const dtz = documents['dtz-internal fixture'];
const english = documents['english-scale fixture'];

const clone = (value) => structuredClone(value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const expectReject = (doc) => {
  try {
    validatePackage(doc);
  } catch (error) {
    assert(error.code === 'invalid_package', `rejected with code ${error.code}, expected invalid_package`);
    return;
  }
  throw new Error('validatePackage accepted a document it must reject');
};

const CASES = [
  ['valid telc manifest accepted', () => {
    const out = validatePackage(clone(telc));
    assert(JSON.stringify(out) === JSON.stringify(telc), 'normalised clone differs from the document');
  }],
  ['internal DTZ fixture accepted', () => { validatePackage(clone(dtz)); }],
  ['English fractional scale accepted', () => {
    validatePackage(clone(english));
    assert(english.blueprint.assessment.correct === 2.5, 'fractional assessment value not preserved');
  }],
  ['duplicate form rejected', () => {
    const doc = clone(telc);
    doc.forms.push({ ...doc.forms[0] });
    expectReject(doc);
  }],
  ['duplicate member rejected', () => {
    const doc = clone(telc);
    doc.forms[0].members.push({ ...doc.forms[0].members[0] });
    expectReject(doc);
  }],
  ['missing version rejected', () => {
    const doc = clone(dtz);
    delete doc.sets[0].version;
    expectReject(doc);
  }],
  ['protected field in payload rejected', () => {
    const doc = clone(dtz);
    doc.sets[0].payload.explanation = 'leaked answer-adjacent text';
    expectReject(doc);
  }],
  ['invalid answer option rejected', () => {
    const doc = clone(dtz);
    doc.sets[0].answers['1'] = 'z';
    expectReject(doc);
  }],
  ['unsupported interaction (renderer) rejected', () => {
    const doc = clone(dtz);
    doc.forms[0].members[0].interaction = 'fill_blank';
    expectReject(doc);
  }],
  ['unknown top-level field rejected', () => {
    const doc = clone(telc);
    doc.fixture = { synthetic: true };
    expectReject(doc);
  }],
  ['set examId mismatch rejected', () => {
    const doc = clone(dtz);
    doc.sets[0].examId = 'telc-deutsch-b1';
    expectReject(doc);
  }],
  ['incomplete DTZ marked available rejected', () => {
    const doc = clone(dtz);
    doc.release.state = 'available';
    expectReject(doc);
  }],
  ['complete-written form rejected (unsupported capability)', () => {
    const doc = clone(telc);
    doc.forms.push({
      id: 'telc-deutsch-b1.complete.01',
      version: 'v1',
      title: 'Complete written (unsupported in S2)',
      scope: 'complete_supported_written',
      sections: ['LV'],
      mode: 'untimed',
      timeLimitSeconds: null,
      feedback: 'finalise',
      members: [{ setId: 'telc-deutsch-b1.lv1.01', version: 'v1', interaction: 'matching_headlines', itemCount: 5 }],
    });
    expectReject(doc);
  }],
  ['canonical hash is deterministic and non-mutating', () => {
    const target = clone(dtz);
    const before = JSON.stringify(target);
    const first = packageHash(target);
    assert(JSON.stringify(target) === before, 'packageHash mutated its argument');
    assert(packageHash(target) === first, 'packageHash is not deterministic');
    const reordered = {
      sets: target.sets, forms: target.forms, release: target.release,
      blueprint: target.blueprint, exam: target.exam, schemaVersion: target.schemaVersion,
    };
    assert(canonicalJson(reordered) === canonicalJson(target), 'canonicalJson depends on key order');
    assert(packageHash(reordered) === first, 'packageHash depends on key order');
  }],
];

let passed = 0;
const failed = [];
for (const [name, run] of CASES) {
  try {
    run();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}: ${error.message}`);
  }
}
console.log(`# contract module: ${contractPath}`);
console.log(`# ${passed}/${CASES.length} contract tests passed`);
if (failed.length > 0) {
  console.log(`# failed: ${failed.join('; ')}`);
  process.exit(1);
}
