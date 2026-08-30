'use strict';

const CONTRACT_VERSION = '2.1.0';
const PRODUCT_TIME_ZONE = 'Asia/Tokyo';

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function booleanOrNull(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

function withoutNulls(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined));
}

function setPath(object, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function provenance(header) {
  return {
    source: header.source_code,
    fetchedAt: header.published_at || header.revision_created_at || null,
    verification: 'provider',
    issues: [],
  };
}

function compactFixture(header, scoreParts) {
  const scores = Object.fromEntries(scoreParts.map(row => [row.scoreKind, {
    home: row.home,
    away: row.away,
  }]));
  return {
    id: header.fixture_id,
    providerId: header.fixture_provider_id,
    competitionId: header.competition_id,
    seasonId: header.season_id,
    kickoffUtc: header.kickoff_utc,
    dateJst: header.date_jst,
    productTimeZone: PRODUCT_TIME_ZONE,
    round: header.round,
    referee: header.referee,
    venue: {
      id: header.venue_id,
      providerId: header.venue_provider_id,
      name: header.venue_name,
      city: header.venue_city,
    },
    status: {
      short: header.status_short,
      long: header.status_long,
      elapsed: header.status_elapsed,
    },
    ingestionState: header.ingestion_state,
    teams: {
      home: {
        id: header.home_team_id,
        providerId: header.home_team_provider_id,
        name: header.home_team_name,
        logo: header.home_team_logo,
        winner: booleanOrNull(header.home_winner),
      },
      away: {
        id: header.away_team_id,
        providerId: header.away_team_provider_id,
        name: header.away_team_name,
        logo: header.away_team_logo,
        winner: booleanOrNull(header.away_winner),
      },
    },
    score: {
      goals: { home: header.home_goals, away: header.away_goals },
      halftime: scores.halftime || { home: null, away: null },
      fulltime: scores.fulltime || { home: null, away: null },
      extratime: scores.extratime || { home: null, away: null },
      penalty: scores.penalty || { home: null, away: null },
    },
    revision: header.revision_no,
    reconciledAt: header.published_at || header.revision_created_at || null,
    provenance: provenance(header),
  };
}

function sectionStates(rows) {
  return Object.fromEntries(rows
    .filter(row => row.kind === 'section_state')
    .map(row => {
      const item = parseJson(row.payload, {});
      return [item.sectionKey, {
        presence: item.presence === 'present_empty' ? 'present' : item.presence,
      }];
    }));
}

function fieldStateMaps(rows) {
  const states = new Map();
  const issues = new Map();
  for (const row of rows.filter(item => item.kind === 'field_state')) {
    const item = parseJson(row.payload, {});
    const key = `${item.factKind}:${item.factKey}`;
    if (!states.has(key)) states.set(key, {});
    states.get(key)[item.fieldPath] = { presence: item.presence };
    const flags = parseJson(item.issueFlagsJson, []);
    if (flags.length) {
      if (!issues.has(key)) issues.set(key, {});
      issues.get(key)[item.fieldPath] = flags;
    }
  }
  return { states, issues };
}

function correctionMaps(rows) {
  const overrides = {};
  const issues = {};
  for (const row of rows.filter(item => item.kind === 'correction')) {
    const item = parseJson(row.payload, {});
    overrides[item.fieldPath] = {
      status: item.status,
      correctedProviderValue: parseJson(item.providerBaselineJson, null),
      value: parseJson(item.appliedValueJson, null),
      reason: item.reason ?? null,
      sourceUrl: item.sourceUrl ?? null,
      verifiedAt: item.verifiedAt ?? null,
      reconciledAt: item.reconciledAt,
    };
    if (item.status === 'review_required') issues[item.fieldPath] = ['conflict'];
  }
  return { issues, overrides };
}

function buildAvailableBundle(header, detailRows, stateRows) {
  const parsed = detailRows.map(row => ({ ...row, value: parseJson(row.payload, {}) }));
  const scoreParts = parsed.filter(row => row.kind === 'score').map(row => row.value);
  const fieldMaps = fieldStateMaps(stateRows);
  const corrections = correctionMaps(stateRows);
  const baseProvenance = provenance(header);
  const lineups = new Map();

  for (const row of parsed.filter(item => item.kind === 'lineup')) {
    const item = row.value;
    lineups.set(item.lineupId, {
      teamId: item.teamId,
      formation: item.formation,
      fieldStates: fieldMaps.states.get(`lineup:${item.teamId}`) || {},
      coach: item.coachId ? {
        id: item.coachId,
        providerId: item.coachProviderId,
        name: item.coachName,
        photo: item.coachPhoto,
      } : null,
      startXI: [],
      substitutes: [],
      provenance: baseProvenance,
    });
  }

  const playerStats = [];
  for (const row of parsed.filter(item => item.kind === 'appearance')) {
    const item = row.value;
    const player = {
      id: item.playerId,
      providerId: item.playerProviderId,
      name: item.playerName,
      number: item.shirtNumber,
      position: item.position,
      grid: item.grid,
      role: item.squadRole,
    };
    const lineup = lineups.get(item.lineupId);
    if (lineup && item.squadRole === 'starter') lineup.startXI.push(player);
    if (lineup && item.squadRole === 'substitute') lineup.substitutes.push(player);

    if (!item.hasStats) continue;

    const values = {
      ...parseJson(item.extraStatsJson, {}),
      ...withoutNulls(parseJson(item.valuesJson, {})),
    };
    playerStats.push({
      fixtureId: header.fixture_id,
      playerId: item.playerId,
      playerProviderId: item.playerProviderId,
      playerName: item.playerName,
      playerPhoto: item.playerPhoto,
      teamId: item.teamId,
      position: item.position,
      starter: item.appearanceState === 'started' ? true
        : (item.appearanceState === 'substitute_used' || item.appearanceState === 'bench_unused' ? false : null),
      captain: booleanOrNull(item.captain),
      values,
      fieldStates: fieldMaps.states.get(`player_stat:${item.playerId}`) || {},
      fieldIssues: fieldMaps.issues.get(`player_stat:${item.playerId}`) || {},
      provenance: baseProvenance,
    });
  }

  const events = parsed.filter(row => row.kind === 'event').map(row => ({
    id: row.value.eventKey,
    type: row.value.type,
    detail: row.value.detail,
    comments: row.value.comments,
    elapsed: row.value.elapsed,
    extra: row.value.extraMinute,
    teamId: row.value.teamId,
    playerId: row.value.playerId,
    relatedPlayerId: row.value.relatedPlayerId,
    provenance: baseProvenance,
  }));

  const teamStats = parsed.filter(row => row.kind === 'team_stat').map(row => {
    const typed = withoutNulls(parseJson(row.value.valuesJson, {}));
    const extra = parseJson(row.value.extraStatsJson, {});
    return {
      teamId: row.value.teamId,
      values: { ...extra, ...typed },
      provenance: baseProvenance,
    };
  });

  const bundle = {
    contractVersion: CONTRACT_VERSION,
    detailAvailability: 'available',
    fixture: compactFixture(header, scoreParts),
    competition: {
      id: header.competition_id,
      providerId: header.competition_provider_id,
      name: header.competition_name,
      country: header.competition_country,
      logo: header.competition_logo,
      flag: header.competition_flag,
    },
    season: {
      id: header.season_id,
      competitionId: header.competition_id,
      providerSeason: header.provider_season,
      label: header.season_label,
    },
    lineups: [...lineups.values()],
    events,
    teamStats,
    playerStats,
    sectionStates: sectionStates(stateRows),
    overrides: corrections.overrides,
    fieldIssues: corrections.issues,
  };

  for (const [path, correction] of Object.entries(corrections.overrides)) {
    if (correction.status === 'active') setPath(bundle, path, correction.value);
    if (correction.status === 'review_required') bundle.fixture.ingestionState = 'needs_review';
  }

  return bundle;
}

function buildUnavailableBundle(header, detailRows) {
  const parsed = detailRows.map(row => ({ ...row, value: parseJson(row.payload, {}) }));
  const scoreParts = parsed.filter(row => row.kind === 'score').map(row => row.value);
  return {
    contractVersion: CONTRACT_VERSION,
    detailAvailability: 'unavailable',
    fixture: compactFixture(header, scoreParts),
    competition: {
      id: header.competition_id,
      providerId: header.competition_provider_id,
      name: header.competition_name,
      country: header.competition_country,
      logo: header.competition_logo,
      flag: header.competition_flag,
    },
    season: {
      id: header.season_id,
      competitionId: header.competition_id,
      providerSeason: header.provider_season,
      label: header.season_label,
    },
    lineups: [],
    events: [],
    teamStats: [],
    playerStats: [],
    sectionStates: {
      events: { presence: 'not_fetched' },
      lineups: { presence: 'not_fetched' },
      teamStats: { presence: 'not_fetched' },
      playerStats: { presence: 'not_fetched' },
    },
    overrides: {},
    fieldIssues: {},
  };
}

module.exports = {
  CONTRACT_VERSION,
  buildAvailableBundle,
  buildUnavailableBundle,
  compactFixture,
};
