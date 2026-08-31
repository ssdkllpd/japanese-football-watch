export const DATE_INDEX_CONTRACT_VERSION = '2.0.0';
export const DATE_INDEX_TIME_ZONE = 'Asia/Tokyo';

const INGESTION_STATES = new Set([
  'scheduled', 'live', 'provisional_final', 'finalized', 'needs_review',
]);
const SCORE_PARTS = ['goals', 'halftime', 'fulltime', 'extratime', 'penalty'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableText(value) {
  return value === null || typeof value === 'string';
}

function isNullableNonNegativeInteger(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function isUtcInstant(value) {
  if (typeof value !== 'string') return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

export function compareCodePoint(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDateIndexFixtures(left, right) {
  return compareCodePoint(left?.kickoffUtc, right?.kickoffUtc)
    || compareCodePoint(left?.fixtureId, right?.fixtureId);
}

function validateCompetition(value, path, errors, expectedId = null) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!/^af:competition:\d+$/.test(String(value.id || ''))) {
    errors.push(`${path}.id must be a canonical competition ID.`);
  }
  if (expectedId !== null && value.id !== expectedId) {
    errors.push(`${path}.id must match ${expectedId}.`);
  }
  if (!Number.isInteger(value.providerId) || value.providerId < 0) {
    errors.push(`${path}.providerId must be a non-negative integer.`);
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    errors.push(`${path}.name must be a non-empty string.`);
  }
  for (const field of ['country', 'logo', 'flag']) {
    if (!isNullableText(value[field])) errors.push(`${path}.${field} must be string or null.`);
  }
}

function validateTeam(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!/^af:team:\d+$/.test(String(value.id || ''))) {
    errors.push(`${path}.id must be a canonical team ID.`);
  }
  if (!Number.isInteger(value.providerId) || value.providerId < 0) {
    errors.push(`${path}.providerId must be a non-negative integer.`);
  }
  if (!isNullableText(value.name)) errors.push(`${path}.name must be string or null.`);
  if (!isNullableText(value.logo)) errors.push(`${path}.logo must be string or null.`);
  if (value.winner !== null && typeof value.winner !== 'boolean') {
    errors.push(`${path}.winner must be boolean or null.`);
  }
}

function validateScorePair(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  for (const side of ['home', 'away']) {
    if (!isNullableNonNegativeInteger(value[side])) {
      errors.push(`${path}.${side} must be a non-negative integer or null.`);
    }
  }
}

function validateFixture(value, index, payload, expectedCompetitionId, errors) {
  const path = `fixtures[${index}]`;
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!/^af:fixture:\d+$/.test(String(value.fixtureId || ''))) {
    errors.push(`${path}.fixtureId must be a canonical fixture ID.`);
  }
  if (!/^af:competition:\d+$/.test(String(value.competitionId || ''))) {
    errors.push(`${path}.competitionId must be a canonical competition ID.`);
  }
  if (expectedCompetitionId !== null && value.competitionId !== expectedCompetitionId) {
    errors.push(`${path}.competitionId must match ${expectedCompetitionId}.`);
  }
  if (!/^af:season:\d+:[^:]+$/.test(String(value.seasonId || ''))) {
    errors.push(`${path}.seasonId must be a canonical competition-season ID.`);
  }
  if (!isUtcInstant(value.kickoffUtc)) errors.push(`${path}.kickoffUtc must be a UTC instant.`);
  if (value.dateJst !== payload.date) errors.push(`${path}.dateJst must match the index date.`);

  if (!isObject(value.status)) errors.push(`${path}.status must be an object.`);
  else {
    if (!isNullableText(value.status.short)) errors.push(`${path}.status.short must be string or null.`);
    if (!isNullableText(value.status.long)) errors.push(`${path}.status.long must be string or null.`);
    if (!isNullableNonNegativeInteger(value.status.elapsed)) {
      errors.push(`${path}.status.elapsed must be a non-negative integer or null.`);
    }
  }

  if (!INGESTION_STATES.has(value.ingestionState)) {
    errors.push(`${path}.ingestionState is invalid.`);
  }
  if (!isObject(value.teams)) errors.push(`${path}.teams must be an object.`);
  else {
    validateTeam(value.teams.home, `${path}.teams.home`, errors);
    validateTeam(value.teams.away, `${path}.teams.away`, errors);
  }
  if (!isObject(value.score)) errors.push(`${path}.score must be an object.`);
  else for (const part of SCORE_PARTS) validateScorePair(value.score[part], `${path}.score.${part}`, errors);

  if (value.competition !== undefined) {
    validateCompetition(value.competition, `${path}.competition`, errors, value.competitionId);
  }
  if (value.competitionName !== undefined && typeof value.competitionName !== 'string') {
    errors.push(`${path}.competitionName must be a string when present.`);
  }
  if (value.competition && value.competitionName !== undefined
      && value.competitionName !== value.competition.name) {
    errors.push(`${path}.competitionName must match competition.name.`);
  }
}

export function validateDateIndexPayload(payload, options = {}) {
  const errors = [];
  const expectedDate = options.expectedDate ?? null;
  const expectedCompetitionId = options.expectedCompetitionId === undefined
    ? (payload?.competition?.id ?? null)
    : options.expectedCompetitionId;

  if (!isObject(payload)) return ['date index must be an object.'];
  if (payload.contractVersion !== DATE_INDEX_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${DATE_INDEX_CONTRACT_VERSION}.`);
  }
  if (payload.timeZone !== DATE_INDEX_TIME_ZONE) {
    errors.push(`timeZone must be ${DATE_INDEX_TIME_ZONE}.`);
  }
  if (!isDateKey(payload.date)) errors.push('date must be a real YYYY-MM-DD date.');
  if (expectedDate !== null && payload.date !== expectedDate) errors.push(`date must match ${expectedDate}.`);
  if (!isUtcInstant(payload.generatedAt)) errors.push('generatedAt must be a UTC instant.');
  if (!Array.isArray(payload.fixtures)) errors.push('fixtures must be an array.');

  if (expectedCompetitionId === null) {
    if (payload.competition !== undefined) errors.push('generic date index must not declare root competition.');
  } else {
    validateCompetition(payload.competition, 'competition', errors, expectedCompetitionId);
  }

  if (Array.isArray(payload.fixtures)) {
    payload.fixtures.forEach((fixture, index) => {
      validateFixture(fixture, index, payload, expectedCompetitionId, errors);
    });
    const fixtureIds = payload.fixtures.map(fixture => fixture?.fixtureId);
    if (new Set(fixtureIds).size !== fixtureIds.length) errors.push('fixture IDs must be unique.');
    if (options.requireSorted !== false) {
      for (let index = 1; index < payload.fixtures.length; index += 1) {
        if (compareDateIndexFixtures(payload.fixtures[index - 1], payload.fixtures[index]) > 0) {
          errors.push('fixtures must be ordered by kickoffUtc and fixtureId.');
          break;
        }
      }
    }
  }
  return errors;
}

export function assertValidDateIndexPayload(payload, options = {}) {
  const errors = validateDateIndexPayload(payload, options);
  if (errors.length) throw new Error(`Date index validation failed: ${errors.join(' ')}`);
  return payload;
}

export function mergeDateIndexes(current, incoming) {
  const incomingCompetitionId = incoming?.competition?.id ?? null;
  assertValidDateIndexPayload(incoming, {
    expectedCompetitionId: incomingCompetitionId,
  });
  if (current?.date && current.date !== incoming.date) {
    throw new Error('Cannot merge different JST dates.');
  }
  if (current?.competition?.id && current.competition.id !== incomingCompetitionId) {
    throw new Error('Cannot merge different competition indexes.');
  }

  const byId = new Map();
  for (const row of current?.fixtures || []) if (row?.fixtureId) byId.set(row.fixtureId, row);
  for (const row of incoming.fixtures) byId.set(row.fixtureId, row);
  const merged = {
    contractVersion: incoming.contractVersion,
    timeZone: incoming.timeZone,
    date: incoming.date,
    fixtures: [...byId.values()].sort(compareDateIndexFixtures),
    generatedAt: incoming.generatedAt,
  };
  if (incomingCompetitionId !== null) merged.competition = { ...incoming.competition };
  assertValidDateIndexPayload(merged, {
    expectedCompetitionId: incomingCompetitionId,
  });
  return merged;
}
