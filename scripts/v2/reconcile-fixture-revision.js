'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateFixtureBundle } = require('./fixture-contract');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function revisionContent(value) {
  if (Array.isArray(value)) return value.map(revisionContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'fetchedAt' && key !== 'reconciledAt')
    .map(([key, item]) => [key, revisionContent(item)]));
}

function assertBundle(bundle, label) {
  const errors = validateFixtureBundle(bundle);
  if (errors.length) throw new Error(`${label} fixture bundle is invalid: ${errors.join('; ')}`);
  if (bundle.contractVersion !== '2.1.0') {
    throw new Error(`${label} fixture bundle must use contractVersion 2.1.0.`);
  }
  if (!Number.isSafeInteger(bundle.fixture?.revision) || bundle.fixture.revision < 1) {
    throw new Error(`${label} fixture revision must be a positive safe integer.`);
  }
}

function reconcileFixtureRevision(current, incoming) {
  assertBundle(incoming, 'Incoming');
  const next = structuredClone(incoming);
  if (!current) {
    next.fixture.revision = 1;
    return { bundle: next, changed: true, reason: 'initial_revision' };
  }

  assertBundle(current, 'Current');
  for (const field of ['id', 'competitionId', 'seasonId', 'providerId']) {
    if (current.fixture[field] !== incoming.fixture[field]) {
      throw new Error(`Current and incoming fixture ${field} differ.`);
    }
  }
  next.fixture.revision = current.fixture.revision;
  if (stableStringify(revisionContent(current)) === stableStringify(revisionContent(next))) {
    return { bundle: structuredClone(current), changed: false, reason: 'content_unchanged' };
  }
  if (current.fixture.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Fixture revision cannot be incremented safely.');
  }
  next.fixture.revision = current.fixture.revision + 1;
  return { bundle: next, changed: true, reason: 'content_changed' };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const [currentPath, incomingPath, outputPath] = argv;
  if (!currentPath || !incomingPath || !outputPath) {
    throw new Error('Usage: reconcile-fixture-revision.js CURRENT_OR_- INCOMING OUTPUT');
  }
  const current = currentPath === '-' ? null : readJson(path.resolve(currentPath), 'Current fixture');
  const incoming = readJson(path.resolve(incomingPath), 'Incoming fixture');
  const result = reconcileFixtureRevision(current, incoming);
  writeJson(path.resolve(outputPath), result.bundle);
  process.stdout.write(`${JSON.stringify({
    fixtureId: result.bundle.fixture.id,
    revision: result.bundle.fixture.revision,
    changed: result.changed,
    reason: result.reason,
  })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { canonicalize, reconcileFixtureRevision, revisionContent, stableStringify };
