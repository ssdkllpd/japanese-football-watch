'use strict';

const { sha256, stableStringify } = require('./fixed-snapshot');

const REPORT_SCHEMA_VERSION = 'd1-fixture-shadow-compare/1';
const SUPPORTED_CONTRACT_VERSIONS = new Set(['2.0.0', '2.1.0']);
const TIME_FIELDS = new Set(['kickoffUtc', 'reconciledAt', 'fetchedAt', 'verifiedAt', 'publishedAt']);
const ORDERED_ARRAY_FIELDS = new Set(['events', 'startXI', 'substitutes']);
const COMPARISON_COVERAGE = Object.freeze({
  normalized: ['contract_2_0_to_2_1', 'utc_timestamp_representation', 'object_key_order'],
  orderedArrays: ['events', 'lineups[].startXI', 'lineups[].substitutes'],
  unorderedArrays: ['lineups', 'playerStats', 'teamStats', 'provenance.issues', 'fieldIssues.*'],
});

function normalizeTime(value) {
  if (typeof value !== 'string') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeNode(value, key = '') {
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeNode(item));
    if (ORDERED_ARRAY_FIELDS.has(key)) return normalized;
    return normalized.sort((left, right) => {
        const leftKey = stableStringify(left);
        const rightKey = stableStringify(right);
        return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
      });
  }
  if (!value || typeof value !== 'object') return TIME_FIELDS.has(key) ? normalizeTime(value) : value;
  return Object.fromEntries(Object.keys(value).sort().map(childKey => [childKey, normalizeNode(value[childKey], childKey)]));
}

function upcastFixtureBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new TypeError('Fixture bundle must be an object.');
  if (!SUPPORTED_CONTRACT_VERSIONS.has(bundle.contractVersion)) {
    throw new Error(`Unsupported fixture contract version: ${bundle.contractVersion || 'missing'}`);
  }
  const copy = JSON.parse(JSON.stringify(bundle));
  if (!copy.fixture?.id) throw new Error('Fixture bundle fixture.id is required.');
  for (const key of ['events', 'lineups', 'playerStats', 'teamStats']) {
    if (!Array.isArray(copy[key])) throw new Error(`Fixture bundle ${key} must be an array.`);
  }
  if (!copy.sectionStates || typeof copy.sectionStates !== 'object' || Array.isArray(copy.sectionStates)) {
    throw new Error('Fixture bundle sectionStates must be an object.');
  }
  if (copy.contractVersion === '2.0.0') {
    copy.contractVersion = '2.1.0';
    if (!Object.hasOwn(copy, 'detailAvailability')) copy.detailAvailability = 'available';
  }
  return copy;
}

function normalizeFixtureBundle(bundle) {
  return normalizeNode(upcastFixtureBundle(bundle));
}

function pointer(path, key) {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function differences(left, right, options = {}) {
  const limit = options.limit || 100;
  const output = [];

  function visit(leftValue, rightValue, path) {
    if (output.length >= limit) return;
    if (Object.is(leftValue, rightValue)) return;
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (!Array.isArray(leftValue) || !Array.isArray(rightValue)) {
        output.push({ path, kind: 'type_mismatch', left: leftValue, right: rightValue });
        return;
      }
      if (leftValue.length !== rightValue.length) {
        output.push({ path, kind: 'array_length_mismatch', left: leftValue.length, right: rightValue.length });
      }
      const length = Math.min(leftValue.length, rightValue.length);
      for (let index = 0; index < length; index += 1) visit(leftValue[index], rightValue[index], pointer(path, index));
      return;
    }
    const leftObject = leftValue && typeof leftValue === 'object';
    const rightObject = rightValue && typeof rightValue === 'object';
    if (leftObject || rightObject) {
      if (!leftObject || !rightObject) {
        output.push({ path, kind: 'type_mismatch', left: leftValue, right: rightValue });
        return;
      }
      const keys = [...new Set([...Object.keys(leftValue), ...Object.keys(rightValue)])].sort();
      for (const key of keys) {
        if (output.length >= limit) return;
        if (!Object.hasOwn(leftValue, key)) {
          output.push({ path: pointer(path, key), kind: 'missing_left', right: rightValue[key] });
        } else if (!Object.hasOwn(rightValue, key)) {
          output.push({ path: pointer(path, key), kind: 'missing_right', left: leftValue[key] });
        } else {
          visit(leftValue[key], rightValue[key], pointer(path, key));
        }
      }
      return;
    }
    output.push({ path, kind: 'value_mismatch', left: leftValue, right: rightValue });
  }

  visit(left, right, '');
  return output;
}

function compareFixtureBundles(jsonBundle, d1Bundle, options = {}) {
  const normalizedJson = normalizeFixtureBundle(jsonBundle);
  const normalizedD1 = normalizeFixtureBundle(d1Bundle);
  const limit = options.limit || 100;
  const collected = differences(normalizedJson, normalizedD1, { ...options, limit: limit + 1 });
  const found = collected.slice(0, limit);
  const jsonFixtureId = normalizedJson.fixture?.id || null;
  const d1FixtureId = normalizedD1.fixture?.id || null;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    comparisonCoverage: COMPARISON_COVERAGE,
    fixtureId: jsonFixtureId === d1FixtureId ? jsonFixtureId : null,
    equal: found.length === 0,
    json: {
      fixtureId: jsonFixtureId,
      contractVersion: normalizedJson.contractVersion,
      semanticSha256: sha256(normalizedJson),
    },
    d1: {
      fixtureId: d1FixtureId,
      contractVersion: normalizedD1.contractVersion,
      semanticSha256: sha256(normalizedD1),
    },
    differences: found,
    truncated: collected.length > limit,
  };
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  COMPARISON_COVERAGE,
  SUPPORTED_CONTRACT_VERSIONS,
  compareFixtureBundles,
  differences,
  normalizeFixtureBundle,
  upcastFixtureBundle,
};
