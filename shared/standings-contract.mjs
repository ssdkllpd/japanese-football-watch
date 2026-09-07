const ROOT_FIELDS = new Set([
  'contractVersion', 'competition', 'season', 'groups', 'sectionStates',
  'generatedAt', 'provenance',
]);
const COMPETITION_FIELDS = new Set(['id', 'providerId', 'name', 'country', 'logo', 'flag']);
const SEASON_FIELDS = new Set(['id', 'competitionId', 'providerSeason', 'label']);
const GROUP_FIELDS = new Set(['id', 'name', 'table']);
const ROW_FIELDS = new Set([
  'rank', 'team', 'points', 'goalDifference', 'form', 'status', 'description',
  'overall', 'home', 'away', 'updatedAt', 'provenance',
]);
const TEAM_FIELDS = new Set(['id', 'providerId', 'name', 'logo']);
const SCOPE_FIELDS = new Set(['played', 'wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst']);
const PROVENANCE_FIELDS = new Set(['source', 'fetchedAt', 'verification', 'issues']);
const SECTION_STATE_FIELDS = new Set(['standings']);
const PRESENCE_FIELDS = new Set(['presence']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertFields(value, allowed, label) {
  if (!object(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function nullableString(value, label) {
  if (value !== null && typeof value !== 'string') throw new Error(`${label} must be a string or null.`);
}

function integerOrNull(value, label, minimum = 0) {
  if (value !== null && (!Number.isInteger(value) || value < minimum)) {
    throw new Error(`${label} must be an integer >= ${minimum} or null.`);
  }
}

function utcInstant(value, label) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC instant.`);
  }
}

function canonical(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is not canonical.`);
}

function validateProvenance(value, label) {
  assertFields(value, PROVENANCE_FIELDS, label);
  if (typeof value.source !== 'string' || !value.source) throw new Error(`${label}.source is required.`);
  utcInstant(value.fetchedAt, `${label}.fetchedAt`);
  if (typeof value.verification !== 'string' || !value.verification) {
    throw new Error(`${label}.verification is required.`);
  }
  if (!Array.isArray(value.issues) || value.issues.some(issue => typeof issue !== 'string')) {
    throw new Error(`${label}.issues must be an array of strings.`);
  }
}

function validateScope(value, label) {
  assertFields(value, SCOPE_FIELDS, label);
  for (const field of SCOPE_FIELDS) integerOrNull(value[field], `${label}.${field}`);
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRow(row, label) {
  assertFields(row, ROW_FIELDS, label);
  integerOrNull(row.rank, `${label}.rank`, 1);
  integerOrNull(row.points, `${label}.points`);
  if (row.goalDifference !== null && !Number.isInteger(row.goalDifference)) {
    throw new Error(`${label}.goalDifference must be an integer or null.`);
  }
  nullableString(row.form, `${label}.form`);
  nullableString(row.status, `${label}.status`);
  nullableString(row.description, `${label}.description`);
  if (row.updatedAt !== null) utcInstant(row.updatedAt, `${label}.updatedAt`);
  assertFields(row.team, TEAM_FIELDS, `${label}.team`);
  canonical(row.team.id, /^af:team:\d+$/, `${label}.team.id`);
  integerOrNull(row.team.providerId, `${label}.team.providerId`);
  if (typeof row.team.name !== 'string' || !row.team.name) throw new Error(`${label}.team.name is required.`);
  nullableString(row.team.logo, `${label}.team.logo`);
  validateScope(row.overall, `${label}.overall`);
  validateScope(row.home, `${label}.home`);
  validateScope(row.away, `${label}.away`);
  validateProvenance(row.provenance, `${label}.provenance`);
}

export function standingsIdentityDigestInput(groups) {
  const lines = [];
  for (const group of groups) {
    lines.push(`G\t${group.id}\t${group.name}`);
    for (const row of group.table) lines.push(`R\t${group.id}\t${row.team.id}`);
  }
  return `${lines.join('\n')}\n`;
}

export function assertValidStandingsPayload(payload, options = {}) {
  assertFields(payload, ROOT_FIELDS, 'standings');
  if (payload.contractVersion !== '2.0.0') throw new Error('standings.contractVersion must be 2.0.0.');
  assertFields(payload.competition, COMPETITION_FIELDS, 'standings.competition');
  canonical(payload.competition.id, /^af:competition:\d+$/, 'standings.competition.id');
  integerOrNull(payload.competition.providerId, 'standings.competition.providerId');
  if (typeof payload.competition.name !== 'string' || !payload.competition.name) {
    throw new Error('standings.competition.name is required.');
  }
  nullableString(payload.competition.country, 'standings.competition.country');
  nullableString(payload.competition.logo, 'standings.competition.logo');
  nullableString(payload.competition.flag, 'standings.competition.flag');
  assertFields(payload.season, SEASON_FIELDS, 'standings.season');
  canonical(payload.season.id, /^af:season:\d+:\d+$/, 'standings.season.id');
  canonical(payload.season.competitionId, /^af:competition:\d+$/, 'standings.season.competitionId');
  integerOrNull(payload.season.providerSeason, 'standings.season.providerSeason');
  nullableString(payload.season.label, 'standings.season.label');
  if (payload.season.competitionId !== payload.competition.id) {
    throw new Error('standings season competition does not match the root competition.');
  }
  if (options.expectedCompetitionId === undefined || options.expectedSeasonId === undefined) {
    throw new Error('Expected competition and season IDs must be supplied externally.');
  }
  if (payload.competition.id !== options.expectedCompetitionId
    || payload.season.id !== options.expectedSeasonId) {
    throw new Error('Standings payload does not match the declared competition-season scope.');
  }
  if (!Array.isArray(payload.groups)) throw new Error('standings.groups must be an array.');
  const groupIds = new Set();
  const groupNames = new Set();
  for (let groupIndex = 0; groupIndex < payload.groups.length; groupIndex += 1) {
    const group = payload.groups[groupIndex];
    const label = `standings.groups[${groupIndex}]`;
    assertFields(group, GROUP_FIELDS, label);
    if (typeof group.id !== 'string' || !group.id) throw new Error(`${label}.id is required.`);
    if (typeof group.name !== 'string' || !group.name) throw new Error(`${label}.name is required.`);
    if (groupIds.has(group.id) || groupNames.has(group.name)) throw new Error('Standings group IDs and names must be unique.');
    groupIds.add(group.id);
    groupNames.add(group.name);
    if (!Array.isArray(group.table)) throw new Error(`${label}.table must be an array.`);
    const teams = new Set();
    for (let rowIndex = 0; rowIndex < group.table.length; rowIndex += 1) {
      const row = group.table[rowIndex];
      validateRow(row, `${label}.table[${rowIndex}]`);
      if (teams.has(row.team.id)) throw new Error(`${label} contains a duplicate team.`);
      teams.add(row.team.id);
      if (rowIndex > 0) {
        const previous = group.table[rowIndex - 1];
        const previousRank = previous.rank ?? Number.MAX_SAFE_INTEGER;
        const currentRank = row.rank ?? Number.MAX_SAFE_INTEGER;
        if (currentRank < previousRank
          || (currentRank === previousRank && compareCodePoint(row.team.id, previous.team.id) < 0)) {
          throw new Error(`${label}.table is not deterministically ordered.`);
        }
      }
    }
  }
  assertFields(payload.sectionStates, SECTION_STATE_FIELDS, 'standings.sectionStates');
  assertFields(payload.sectionStates.standings, PRESENCE_FIELDS, 'standings.sectionStates.standings');
  const expectedPresence = payload.groups.some(group => group.table.length) ? 'present' : 'provider_missing';
  if (payload.sectionStates.standings.presence !== expectedPresence) {
    throw new Error('standings section presence does not match its rows.');
  }
  utcInstant(payload.generatedAt, 'standings.generatedAt');
  validateProvenance(payload.provenance, 'standings.provenance');
  return payload;
}

export { compareCodePoint };
