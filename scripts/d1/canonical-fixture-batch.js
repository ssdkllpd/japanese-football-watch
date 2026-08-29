'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeFixtureBundle } = require('./fixture-shadow-compare');
const { sha256 } = require('./fixed-snapshot');
const { importAndCompare } = require('./import-fixture-bundle');

const PLAN_SCHEMA_VERSION = 'd1-canonical-fixture-import-plan/1';
const REPORT_SCHEMA_VERSION = 'd1-canonical-fixture-import-report/1';

function resolveArtifactPath(baseDirectory, artifactPath) {
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(base, artifactPath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`fixture artifact escapes plan directory: ${artifactPath}`);
  }
  return resolved;
}

function validateCanonicalFixturePlan(plan) {
  const errors = [];
  if (plan?.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push('unsupported import plan schemaVersion');
  if (!/^jfw:season:/.test(String(plan?.productSeasonCanonicalId || ''))) {
    errors.push('productSeasonCanonicalId is required');
  }
  if (!Array.isArray(plan?.fixtures) || plan.fixtures.length === 0) {
    errors.push('fixtures must be a non-empty array');
    return errors;
  }
  const ids = new Set();
  for (const [index, fixture] of plan.fixtures.entries()) {
    if (!/^af:fixture:\d+$/.test(String(fixture?.fixtureId || ''))) {
      errors.push(`fixtures[${index}].fixtureId must be canonical`);
    }
    if (ids.has(fixture?.fixtureId)) errors.push(`duplicate fixtureId: ${fixture.fixtureId}`);
    ids.add(fixture?.fixtureId);
    if (typeof fixture?.bundlePath !== 'string' || !fixture.bundlePath) {
      errors.push(`fixtures[${index}].bundlePath is required`);
    }
    if (typeof fixture?.catalogPath !== 'string' || !fixture.catalogPath) {
      errors.push(`fixtures[${index}].catalogPath is required`);
    }
    if (fixture?.expectedContentSha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(fixture.expectedContentSha256)) {
      errors.push(`fixtures[${index}].expectedContentSha256 must be lowercase SHA-256`);
    }
  }
  return errors;
}

async function runCanonicalFixturePlan(database, plan, options = {}) {
  const errors = validateCanonicalFixturePlan(plan);
  if (errors.length) throw new Error(`Invalid canonical fixture import plan:\n- ${errors.join('\n- ')}`);
  const baseDirectory = options.baseDirectory || process.cwd();
  const readJson = options.readJson || (filePath => JSON.parse(fs.readFileSync(filePath, 'utf8')));
  const fixtures = [];

  for (const item of [...plan.fixtures].sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))) {
    try {
      const bundle = readJson(resolveArtifactPath(baseDirectory, item.bundlePath));
      const catalog = readJson(resolveArtifactPath(baseDirectory, item.catalogPath));
      if (bundle?.fixture?.id !== item.fixtureId) {
        throw new Error(`plan fixture ${item.fixtureId} points to bundle ${bundle?.fixture?.id || 'missing'}`);
      }
      if (catalog?.productSeasonId !== plan.productSeasonCanonicalId) {
        throw new Error(`catalog product season mismatch for ${item.fixtureId}`);
      }
      const contentSha256 = sha256(normalizeFixtureBundle(bundle));
      if (item.expectedContentSha256 && item.expectedContentSha256 !== contentSha256) {
        throw new Error(`content SHA-256 mismatch for ${item.fixtureId}`);
      }
      const result = await importAndCompare(database, bundle, catalog);
      fixtures.push({
        fixtureId: item.fixtureId,
        status: result.passed
          ? (result.imported.imported ? 'imported' : 'already_imported')
          : 'shadow_mismatch',
        bundlePath: item.bundlePath,
        catalogPath: item.catalogPath,
        contentSha256,
        result,
      });
    } catch (error) {
      fixtures.push({
        fixtureId: item.fixtureId,
        status: 'error',
        bundlePath: item.bundlePath,
        catalogPath: item.catalogPath,
        error: error.message,
      });
    }
  }

  const summary = {
    total: fixtures.length,
    imported: fixtures.filter(item => item.status === 'imported').length,
    alreadyImported: fixtures.filter(item => item.status === 'already_imported').length,
    shadowMismatches: fixtures.filter(item => item.status === 'shadow_mismatch').length,
    errors: fixtures.filter(item => item.status === 'error').length,
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    productSeasonCanonicalId: plan.productSeasonCanonicalId,
    passed: summary.total > 0 && summary.errors === 0 && summary.shadowMismatches === 0,
    summary,
    fixtures,
  };
}

module.exports = {
  PLAN_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  resolveArtifactPath,
  runCanonicalFixturePlan,
  validateCanonicalFixturePlan,
};
