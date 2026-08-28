'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compareFixtureBundles } = require('./fixture-shadow-compare');

const PLAN_SCHEMA_VERSION = 'd1-fixture-shadow-plan/1';
const BATCH_REPORT_SCHEMA_VERSION = 'd1-fixture-shadow-batch-report/1';

function validateFixtureShadowPlan(plan) {
  const errors = [];
  if (plan?.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push('unsupported shadow plan schemaVersion');
  if (!Array.isArray(plan?.fixtures) || plan.fixtures.length === 0) {
    errors.push('fixtures must be a non-empty array');
    return errors;
  }
  const ids = new Set();
  for (const [index, fixture] of plan.fixtures.entries()) {
    if (!/^af:fixture:\d+$/.test(fixture?.fixtureId || '')) errors.push(`fixtures[${index}].fixtureId must be canonical`);
    if (ids.has(fixture?.fixtureId)) errors.push(`duplicate fixtureId: ${fixture.fixtureId}`);
    ids.add(fixture?.fixtureId);
    if (typeof fixture?.jsonPath !== 'string' || !fixture.jsonPath) errors.push(`fixtures[${index}].jsonPath is required`);
    if (typeof fixture?.d1Path !== 'string' || !fixture.d1Path) errors.push(`fixtures[${index}].d1Path is required`);
  }
  return errors;
}

function defaultReadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveArtifactPath(baseDirectory, artifactPath) {
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(base, artifactPath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`fixture artifact escapes plan directory: ${artifactPath}`);
  }
  return resolved;
}

function runFixtureShadowPlan(plan, options = {}) {
  const errors = validateFixtureShadowPlan(plan);
  if (errors.length) throw new Error(`Invalid fixture shadow plan:\n- ${errors.join('\n- ')}`);
  const baseDirectory = options.baseDirectory || process.cwd();
  const readJson = options.readJson || defaultReadJson;
  const results = [];

  for (const fixture of [...plan.fixtures].sort((left, right) => (
    left.fixtureId < right.fixtureId ? -1 : (left.fixtureId > right.fixtureId ? 1 : 0)
  ))) {
    try {
      const jsonBundle = readJson(resolveArtifactPath(baseDirectory, fixture.jsonPath));
      const d1Bundle = readJson(resolveArtifactPath(baseDirectory, fixture.d1Path));
      const report = compareFixtureBundles(jsonBundle, d1Bundle, options.compareOptions);
      if (report.json.fixtureId !== fixture.fixtureId || report.d1.fixtureId !== fixture.fixtureId) {
        results.push({
          fixtureId: fixture.fixtureId,
          status: 'error',
          error: 'plan_fixture_id_mismatch',
          observed: { json: report.json.fixtureId, d1: report.d1.fixtureId },
        });
      } else {
        results.push({ fixtureId: fixture.fixtureId, status: report.equal ? 'equal' : 'different', report });
      }
    } catch (error) {
      results.push({ fixtureId: fixture.fixtureId, status: 'error', error: error.message });
    }
  }

  const summary = {
    total: results.length,
    equal: results.filter(result => result.status === 'equal').length,
    different: results.filter(result => result.status === 'different').length,
    errors: results.filter(result => result.status === 'error').length,
  };
  return {
    schemaVersion: BATCH_REPORT_SCHEMA_VERSION,
    passed: summary.total > 0 && summary.different === 0 && summary.errors === 0,
    summary,
    fixtures: results,
  };
}

module.exports = {
  BATCH_REPORT_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  resolveArtifactPath,
  runFixtureShadowPlan,
  validateFixtureShadowPlan,
};
