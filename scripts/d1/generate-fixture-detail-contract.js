'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildAvailableBundle, buildUnavailableBundle } = require('./fixture-dto');

const DYNAMIC_MAP_PATHS = new Set([
  'lineups[].fieldStates',
  'teamStats[].values',
  'playerStats[].values',
  'playerStats[].fieldStates',
  'playerStats[].fieldIssues',
  'sectionStates',
  'overrides',
  'fieldIssues',
]);

function mergeSchemas(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.type === 'any' || right.type === 'any') return { type: 'any' };
  if (left.type !== right.type) return { type: 'any' };
  if (left.type === 'array') return { type: 'array', items: mergeSchemas(left.items, right.items) };
  if (left.type !== 'object') return left;
  if (left.additionalProperties || right.additionalProperties) {
    return {
      type: 'object',
      additionalProperties: mergeSchemas(left.additionalProperties, right.additionalProperties),
    };
  }
  const properties = {};
  for (const key of [...new Set([...Object.keys(left.properties), ...Object.keys(right.properties)])].sort()) {
    properties[key] = mergeSchemas(left.properties[key], right.properties[key]);
  }
  return { type: 'object', properties };
}

function schemaFor(value, pathName = '') {
  if (Array.isArray(value)) {
    const itemPath = `${pathName}[]`;
    return {
      type: 'array',
      // An empty array contributes no evidence about its item shape. Keeping it
      // null lets the populated available bundle define the contract when it is
      // merged with the unavailable bundle's empty sections.
      items: value.reduce((schema, item) => mergeSchemas(schema, schemaFor(item, itemPath)), null),
    };
  }
  if (value === null || typeof value !== 'object') return { type: 'any' };
  if (DYNAMIC_MAP_PATHS.has(pathName)) {
    const values = Object.values(value);
    return {
      type: 'object',
      additionalProperties: values.reduce(
        (schema, item) => mergeSchemas(schema, schemaFor(item, `${pathName}.*`)), null,
      ) || { type: 'any' },
    };
  }
  const properties = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = pathName ? `${pathName}.${key}` : key;
    properties[key] = schemaFor(value[key], childPath);
  }
  return { type: 'object', properties };
}

function contractSamples() {
  const header = {
    fixture_id: 'af:fixture:9001', fixture_provider_id: 9001,
    competition_id: 'af:competition:39', competition_provider_id: 39,
    competition_name: 'Premier League', competition_country: 'England',
    competition_logo: 'https://example.test/competition.png', competition_flag: 'https://example.test/flag.png',
    season_id: 'af:season:39:2026', provider_season: 2026, season_label: '2026',
    kickoff_utc: '2026-08-21T20:00:00.000Z', date_jst: '2026-08-22',
    round: 'Regular Season - 1', referee: 'Referee', venue_id: 'af:venue:1',
    venue_provider_id: 1, venue_name: 'Ground', venue_city: 'City',
    status_short: 'NS', status_long: 'Not Started', status_elapsed: null,
    ingestion_state: 'scheduled', home_team_id: 'af:team:40', home_team_provider_id: 40,
    home_team_name: 'Home FC', home_team_logo: 'https://example.test/home.png', home_winner: null,
    away_team_id: 'af:team:50', away_team_provider_id: 50,
    away_team_name: 'Away FC', away_team_logo: 'https://example.test/away.png', away_winner: null,
    home_goals: null, away_goals: null, revision_no: 1,
    published_at: '2026-08-21T19:00:00.000Z', revision_created_at: '2026-08-21T19:00:00.000Z',
    source_code: 'api-football',
  };
  const detailRows = [
    ...['halftime', 'fulltime', 'extratime', 'penalty'].map(scoreKind => ({
      kind: 'score', payload: JSON.stringify({ scoreKind, home: null, away: null }),
    })),
    { kind: 'lineup', payload: JSON.stringify({
      lineupId: 'lineup-home', teamId: 'af:team:40', formation: '4-4-2',
      coachId: 'af:coach:1', coachProviderId: 1, coachName: 'Coach', coachPhoto: 'https://example.test/coach.png',
    }) },
    { kind: 'appearance', payload: JSON.stringify({
      lineupId: 'lineup-home', playerId: 'af:player:1', playerProviderId: 1,
      playerName: 'Starter', playerPhoto: 'https://example.test/player.png', shirtNumber: 9,
      position: 'F', grid: '1:1', squadRole: 'starter', hasStats: true,
      teamId: 'af:team:40', appearanceState: 'started', captain: true,
      valuesJson: JSON.stringify({ rating: 7.1 }), extraStatsJson: '{}',
    }) },
    { kind: 'appearance', payload: JSON.stringify({
      lineupId: 'lineup-home', playerId: 'af:player:2', playerProviderId: 2,
      playerName: 'Substitute', shirtNumber: 10, position: 'M', grid: null,
      squadRole: 'substitute', hasStats: false,
    }) },
    { kind: 'event', payload: JSON.stringify({
      eventKey: 'af:event:9001:0', type: 'goal', detail: 'Normal Goal', comments: null,
      elapsed: 10, extraMinute: null, teamId: 'af:team:40', playerId: 'af:player:1',
      relatedPlayerId: null,
    }) },
    { kind: 'team_stat', payload: JSON.stringify({
      teamId: 'af:team:40', valuesJson: JSON.stringify({ possession: 55 }), extraStatsJson: '{}',
    }) },
  ];
  const stateRows = [
    ...['events', 'lineups', 'teamStats', 'playerStats'].map(sectionKey => ({
      kind: 'section_state', payload: JSON.stringify({ sectionKey, presence: 'present' }),
    })),
    { kind: 'field_state', payload: JSON.stringify({
      factKind: 'lineup', factKey: 'af:team:40', fieldPath: 'formation', presence: 'present', issueFlagsJson: '[]',
    }) },
    { kind: 'field_state', payload: JSON.stringify({
      factKind: 'player_stat', factKey: 'af:player:1', fieldPath: 'rating',
      presence: 'present', issueFlagsJson: '["conflict"]',
    }) },
    { kind: 'correction', payload: JSON.stringify({
      fieldPath: 'fixture.referee', status: 'review_required', providerBaselineJson: '"Old"',
      appliedValueJson: '"New"', reason: 'review', sourceUrl: 'https://example.test/source',
      verifiedAt: '2026-08-21T19:10:00.000Z', reconciledAt: '2026-08-21T19:20:00.000Z',
    }) },
  ];
  return [buildAvailableBundle(header, detailRows, stateRows), buildUnavailableBundle(header, detailRows)];
}

function fixtureDetailSchema() {
  return contractSamples().reduce((schema, sample) => mergeSchemas(schema, schemaFor(sample)), null);
}

function renderFixtureDetailContractModule() {
  const schema = JSON.stringify(fixtureDetailSchema(), null, 2);
  return `// Generated by scripts/d1/generate-fixture-detail-contract.js. Do not edit by hand.\n`
    + `export const FIXTURE_DETAIL_SCHEMA = Object.freeze(${schema});\n`;
}

if (require.main === module) {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'shared', 'fixture-detail-contract.mjs'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderFixtureDetailContractModule(), 'utf8');
  process.stdout.write(`${output}\n`);
}

module.exports = { contractSamples, fixtureDetailSchema, renderFixtureDetailContractModule };
