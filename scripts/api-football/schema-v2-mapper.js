'use strict';

const FINAL_FIXTURE_STATUSES = new Set(['FT', 'AET', 'PEN']);

const COMMON_PRIORITY_FIELDS = [
  'minutes',
  'goals',
  'assists',
  'yellowCards',
  'secondYellowRed',
  'straightRed',
  'penaltiesConceded',
  'ownGoals',
];

const POSITION_PRIORITY_FIELDS = {
  GK: [
    'cleanSheets', 'saves', 'shotsOnTargetFaced', 'penaltiesSaved', 'highClaims',
    'errorsLeadingToGoal', 'passesCompleted', 'passesAttempted', 'gaOnPitch',
  ],
  DF: [
    'cleanSheets', 'tackles', 'interceptions', 'clearances', 'blocks',
    'duelsWon', 'duelsTotal', 'aerialDuelsWon', 'aerialDuelsTotal',
    'dribbledPast', 'passesCompleted', 'passesAttempted', 'gaOnPitch',
  ],
  MF: [
    'shots', 'shotsOnTarget', 'keyPasses', 'tackles', 'interceptions',
    'duelsWon', 'duelsTotal', 'dribbles', 'dribbledPast',
    'bigChancesMissed', 'possessionsLost', 'passesCompleted', 'passesAttempted',
  ],
  FW: [
    'shots', 'shotsOnTarget', 'keyPasses', 'duelsWon', 'duelsTotal',
    'dribbles', 'dribbledPast', 'bigChancesMissed', 'possessionsLost',
    'passesCompleted', 'passesAttempted',
  ],
};

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameId(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined &&
    String(left) === String(right);
}

function apiFootballPlayerId(player) {
  return player?.apiFootballPlayerId ??
    player?.providerIds?.apiFootball?.player ??
    player?.providerIds?.apiFootball?.playerId ??
    null;
}

function normalizeTrackedPlayers(players = []) {
  const byProviderId = new Map();
  for (const player of players) {
    const providerId = apiFootballPlayerId(player);
    if (providerId === null || providerId === undefined) continue;
    const key = String(providerId);
    if (byProviderId.has(key)) {
      throw new Error(`Duplicate API-Football player id in tracked registry: ${key}`);
    }
    if (!player.playerId || !player.name) {
      throw new Error(`Tracked player ${key} requires playerId and name.`);
    }
    byProviderId.set(key, player);
  }
  return byProviderId;
}

function playerPosition(value, fallback = null) {
  const position = String(value || fallback || '').trim().toUpperCase();
  if (position === 'G' || position === 'GK' || position.includes('GOALKEEPER')) return 'GK';
  if (position === 'D' || position === 'DF' || position.includes('DEFENDER')) return 'DF';
  if (position === 'M' || position === 'MF' || position.includes('MIDFIELDER')) return 'MF';
  if (position === 'F' || position === 'FW' || position.includes('ATTACKER')) return 'FW';
  return fallback || null;
}

function fixtureStatus(fixture) {
  return String(fixture?.fixture?.status?.short || '').toUpperCase();
}

function isFinalFixture(fixture) {
  return FINAL_FIXTURE_STATUSES.has(fixtureStatus(fixture));
}

function fixtureEventsAreComplete(fixture) {
  if (!isFinalFixture(fixture) || !Array.isArray(fixture?.events)) return false;
  const homeGoals = numeric(fixture?.goals?.home);
  const awayGoals = numeric(fixture?.goals?.away);
  if (homeGoals === null || awayGoals === null) return false;
  const observedGoals = fixture.events.filter(event => {
    const type = String(event?.type || '').toLowerCase();
    const detail = String(event?.detail || '').toLowerCase();
    return type === 'goal' && !detail.includes('missed') && !detail.includes('cancel');
  }).length;
  return observedGoals === homeGoals + awayGoals;
}

function teamResolver(options, team) {
  const names = options.clubNamesByProviderId || {};
  return names[String(team?.id)] || team?.name || null;
}

function competitionResolver(options, league) {
  const names = options.competitionNamesByProviderId || {};
  return names[String(league?.id)] || league?.name || null;
}

function buildMatchLabel(homeName, awayName, goals) {
  const homeGoals = numeric(goals?.home);
  const awayGoals = numeric(goals?.away);
  if (homeGoals === null || awayGoals === null) return `${homeName || 'Home'} vs ${awayName || 'Away'}`;
  return `${homeName || 'Home'} ${homeGoals}-${awayGoals} ${awayName || 'Away'}`;
}

function collectLineups(fixture) {
  const rows = new Map();
  for (const lineup of fixture?.lineups || []) {
    const team = lineup?.team || null;
    for (const item of lineup?.startXI || []) {
      const player = item?.player || {};
      if (player.id === null || player.id === undefined) continue;
      rows.set(String(player.id), {
        ...(rows.get(String(player.id)) || {}),
        player,
        team,
        start: true,
        bench: false,
      });
    }
    for (const item of lineup?.substitutes || []) {
      const player = item?.player || {};
      if (player.id === null || player.id === undefined) continue;
      rows.set(String(player.id), {
        ...(rows.get(String(player.id)) || {}),
        player,
        team,
        start: false,
        bench: true,
      });
    }
  }
  return rows;
}

function collectPlayerStatistics(fixture) {
  const rows = new Map();
  for (const teamBlock of fixture?.players || []) {
    for (const item of teamBlock?.players || []) {
      const player = item?.player || {};
      if (player.id === null || player.id === undefined) continue;
      rows.set(String(player.id), {
        player,
        team: teamBlock?.team || null,
        statistics: Array.isArray(item.statistics) ? (item.statistics[0] || {}) : {},
      });
    }
  }
  return rows;
}

function eventBucket() {
  return {
    goals: 0,
    assists: 0,
    ownGoals: 0,
    yellowCards: 0,
    secondYellowRed: 0,
    straightRed: 0,
    appearedInEvent: false,
    team: null,
  };
}

function collectEvents(fixture) {
  const rows = new Map();
  function get(playerId) {
    const key = String(playerId);
    if (!rows.has(key)) rows.set(key, eventBucket());
    return rows.get(key);
  }

  for (const event of fixture?.events || []) {
    const type = String(event?.type || '').toLowerCase();
    const detail = String(event?.detail || '').toLowerCase();
    const playerId = event?.player?.id;
    const assistId = event?.assist?.id;

    if (playerId !== null && playerId !== undefined) {
      const current = get(playerId);
      current.appearedInEvent = true;
      current.team = current.team || event?.team || null;

      if (type === 'goal') {
        if (detail.includes('own goal')) current.ownGoals += 1;
        else if (!detail.includes('missed')) current.goals += 1;
      }
      if (type === 'card') {
        if (detail.includes('second yellow')) current.secondYellowRed += 1;
        else if (detail.includes('red')) current.straightRed += 1;
        else if (detail.includes('yellow')) current.yellowCards += 1;
      }
    }

    if (type === 'goal' && !detail.includes('own goal') && !detail.includes('missed') &&
        assistId !== null && assistId !== undefined) {
      const assister = get(assistId);
      assister.assists += 1;
      assister.appearedInEvent = true;
      assister.team = assister.team || event?.team || null;
    }

    if (type === 'subst' && assistId !== null && assistId !== undefined) {
      const substitute = get(assistId);
      substitute.appearedInEvent = true;
      substitute.team = substitute.team || event?.team || null;
    }
  }
  return rows;
}

function collectSubstitutions(fixture) {
  const byPlayer = new Map();
  const events = [];
  for (const event of fixture?.events || []) {
    if (String(event?.type || '').toLowerCase() !== 'subst') continue;
    const outgoingId = event?.player?.id;
    const incomingId = event?.assist?.id;
    const elapsed = numeric(event?.time?.elapsed);
    const extra = numeric(event?.time?.extra);
    const teamId = numeric(event?.team?.id) ?? event?.team?.id ?? null;
    const change = {
      teamId,
      elapsed,
      extra,
      outgoingProviderPlayerId: numeric(outgoingId) ?? outgoingId ?? null,
      outgoingName: event?.player?.name || null,
      incomingProviderPlayerId: numeric(incomingId) ?? incomingId ?? null,
      incomingName: event?.assist?.name || null,
    };
    events.push(change);
    if (outgoingId !== null && outgoingId !== undefined) {
      byPlayer.set(String(outgoingId), {
        direction: 'out',
        elapsed,
        extra,
        replacementProviderPlayerId: change.incomingProviderPlayerId,
        replacementName: change.incomingName,
      });
    }
    if (incomingId !== null && incomingId !== undefined) {
      byPlayer.set(String(incomingId), {
        direction: 'in',
        elapsed,
        extra,
        replacedProviderPlayerId: change.outgoingProviderPlayerId,
        replacedName: change.outgoingName,
      });
    }
  }
  return { byPlayer, events };
}

function lineupPlayer(item, role, trackedPlayers, playerStats, substitutions) {
  const player = item?.player || {};
  const providerPlayerId = player?.id;
  if (providerPlayerId === null || providerPlayerId === undefined) return null;
  const key = String(providerPlayerId);
  const tracked = trackedPlayers.get(key) || null;
  const stats = playerStats.get(key)?.statistics || {};
  const rating = numeric(stats?.games?.rating);
  const row = {
    providerPlayerId: numeric(providerPlayerId) ?? providerPlayerId,
    playerId: tracked?.playerId || null,
    name: tracked?.name || player?.name || playerStats.get(key)?.player?.name || null,
    number: numeric(player?.number),
    position: playerPosition(player?.pos || stats?.games?.position),
    grid: String(player?.grid || '').trim() || null,
    role,
    apiFootballRating: rating,
    minutes: numeric(stats?.games?.minutes),
    captain: typeof stats?.games?.captain === 'boolean' ? stats.games.captain : null,
  };
  const substitution = substitutions.byPlayer.get(key);
  if (substitution) row.substitution = substitution;
  return row;
}

function buildFormationData(fixture, options, trackedPlayers, playerStats, substitutions, sourceId) {
  const lineups = Array.isArray(fixture?.lineups) ? fixture.lineups : [];
  const hasLineup = lineups.some(lineup =>
    lineup?.formation || (lineup?.startXI || []).length || (lineup?.substitutes || []).length
  );
  if (!hasLineup) return null;

  const sides = [
    ['home', fixture?.teams?.home || null],
    ['away', fixture?.teams?.away || null],
  ];
  const teams = sides.map(([side, fixtureTeam]) => {
    const lineup = lineups.find(row => sameId(row?.team?.id, fixtureTeam?.id)) || null;
    const sourceTeam = lineup?.team || fixtureTeam || {};
    return {
      side,
      teamId: numeric(sourceTeam?.id) ?? sourceTeam?.id ?? null,
      teamName: teamResolver(options, sourceTeam),
      formation: String(lineup?.formation || '').trim() || null,
      lineupAvailable: !!lineup,
      startXI: (lineup?.startXI || [])
        .map(item => lineupPlayer(item, 'starter', trackedPlayers, playerStats, substitutions))
        .filter(Boolean),
      substitutes: (lineup?.substitutes || [])
        .map(item => lineupPlayer(item, 'substitute', trackedPlayers, playerStats, substitutions))
        .filter(Boolean),
    };
  });

  return {
    version: '1.0',
    provider: 'api-football',
    sourceId,
    teams,
    substitutions: substitutions.events,
  };
}

function knownValue(values, fieldSources, field, value, sourceId) {
  const parsed = numeric(value);
  if (parsed === null) return false;
  values[field] = parsed;
  fieldSources[field] = sourceId;
  return true;
}

function eventBackedValue(values, fieldSources, field, providerValue, eventValue, eventsComplete, sourceId, conflicts) {
  const reported = numeric(providerValue);
  const eventCount = numeric(eventValue);
  if (reported !== null && eventCount !== null && eventsComplete && reported !== eventCount) {
    conflicts.push({ field, playerStatistics: reported, fixtureEvents: eventCount });
  }
  if (reported !== null && eventCount !== null) {
    if (reported > 0 || eventCount > 0) {
      return knownValue(values, fieldSources, field, Math.max(reported, eventCount), sourceId);
    }
    if (eventsComplete) return knownValue(values, fieldSources, field, 0, sourceId);
  }
  if (reported !== null) return knownValue(values, fieldSources, field, reported, sourceId);
  if (eventCount !== null && (eventCount > 0 || eventsComplete)) {
    return knownValue(values, fieldSources, field, eventCount, sourceId);
  }
  return false;
}

function priorityFields(position) {
  return [...new Set([
    ...COMMON_PRIORITY_FIELDS,
    ...(POSITION_PRIORITY_FIELDS[position] || POSITION_PRIORITY_FIELDS.MF),
  ])];
}

function appearanceState({ line, stats, events, finalFixture }) {
  const minutes = numeric(stats?.games?.minutes);
  if (minutes !== null && minutes > 0) return true;
  if (events?.appearedInEvent) return true;
  if (line?.start && finalFixture) return true;
  if (line?.bench && finalFixture) return false;
  return null;
}

function resultForTeam(fixture, teamId) {
  const homeId = fixture?.teams?.home?.id;
  const awayId = fixture?.teams?.away?.id;
  const homeGoals = numeric(fixture?.goals?.home);
  const awayGoals = numeric(fixture?.goals?.away);
  if (homeGoals === null || awayGoals === null) return null;
  const own = sameId(teamId, homeId) ? homeGoals : (sameId(teamId, awayId) ? awayGoals : null);
  const opponent = sameId(teamId, homeId) ? awayGoals : (sameId(teamId, awayId) ? homeGoals : null);
  if (own === null || opponent === null) return null;
  if (own > opponent) return 'W';
  if (own < opponent) return 'L';
  return 'D';
}

function resultLabel(code, fixture) {
  const homeGoals = numeric(fixture?.goals?.home);
  const awayGoals = numeric(fixture?.goals?.away);
  const score = homeGoals === null || awayGoals === null ? '' : `${homeGoals}-${awayGoals} `;
  return `${score}${code === 'W' ? '勝利' : code === 'L' ? '敗戦' : code === 'D' ? '引分' : '結果未取得'}`;
}

function mapFixtureToSchemaV2(fixture, options = {}) {
  const providerFixtureId = fixture?.fixture?.id;
  if (providerFixtureId === null || providerFixtureId === undefined) {
    throw new Error('API-Football fixture.id is required.');
  }

  const trackedPlayers = normalizeTrackedPlayers(options.trackedPlayers || []);
  const lines = collectLineups(fixture);
  const playerStats = collectPlayerStatistics(fixture);
  const events = collectEvents(fixture);
  const substitutions = collectSubstitutions(fixture);
  const finalFixture = isFinalFixture(fixture);
  const eventsComplete = fixtureEventsAreComplete(fixture);
  const sourceId = `api-football-fixture-${providerFixtureId}`;
  const matchId = options.matchId || `api-football-fixture-${providerFixtureId}`;
  const updated = options.updated || new Date().toISOString();
  const competition = competitionResolver(options, fixture?.league || {});
  const homeClub = teamResolver(options, fixture?.teams?.home || {});
  const awayClub = teamResolver(options, fixture?.teams?.away || {});
  const match = buildMatchLabel(homeClub, awayClub, fixture?.goals);
  const formationData = buildFormationData(
    fixture,
    options,
    trackedPlayers,
    playerStats,
    substitutions,
    sourceId
  );

  const candidateIds = new Set([...lines.keys(), ...playerStats.keys(), ...events.keys()]);
  const records = [];
  const playerUpdates = [];
  const gaResultsAdd = [];

  for (const providerPlayerId of candidateIds) {
    const tracked = trackedPlayers.get(String(providerPlayerId));
    if (!tracked) continue;

    const line = lines.get(String(providerPlayerId)) || null;
    const statsRow = playerStats.get(String(providerPlayerId)) || null;
    const stats = statsRow?.statistics || {};
    const eventStats = events.get(String(providerPlayerId)) || eventBucket();
    const team = statsRow?.team || line?.team || eventStats.team || null;
    const club = teamResolver(options, team) || tracked.club || null;
    const position = playerPosition(
      stats?.games?.position || line?.player?.pos,
      playerPosition(tracked.position || tracked.pos)
    );
    const appearance = appearanceState({ line, stats, events: eventStats, finalFixture });
    let start = null;
    let bench = null;
    if (line?.start === true) {
      start = true;
      bench = false;
    } else if (line?.bench === true) {
      start = false;
      bench = true;
    } else if (appearance === true && typeof stats?.games?.substitute === 'boolean') {
      start = !stats.games.substitute;
      bench = stats.games.substitute;
    }
    const values = {};
    const fieldSources = {};
    const conflicts = [];

    knownValue(values, fieldSources, 'minutes', stats?.games?.minutes, sourceId);
    eventBackedValue(values, fieldSources, 'goals', stats?.goals?.total, eventStats.goals, eventsComplete, sourceId, conflicts);
    eventBackedValue(values, fieldSources, 'assists', stats?.goals?.assists, eventStats.assists, eventsComplete, sourceId, conflicts);
    knownValue(values, fieldSources, 'shots', stats?.shots?.total, sourceId);
    knownValue(values, fieldSources, 'shotsOnTarget', stats?.shots?.on, sourceId);
    knownValue(values, fieldSources, 'keyPasses', stats?.passes?.key, sourceId);
    knownValue(values, fieldSources, 'tackles', stats?.tackles?.total, sourceId);
    knownValue(values, fieldSources, 'interceptions', stats?.tackles?.interceptions, sourceId);
    knownValue(values, fieldSources, 'blocks', stats?.tackles?.blocks, sourceId);
    knownValue(values, fieldSources, 'saves', stats?.goals?.saves, sourceId);
    knownValue(values, fieldSources, 'duelsWon', stats?.duels?.won, sourceId);
    knownValue(values, fieldSources, 'duelsTotal', stats?.duels?.total, sourceId);
    knownValue(values, fieldSources, 'dribbles', stats?.dribbles?.success, sourceId);
    knownValue(values, fieldSources, 'dribbledPast', stats?.dribbles?.past, sourceId);
    knownValue(values, fieldSources, 'passesCompleted', stats?.passes?.accuracy, sourceId);
    knownValue(values, fieldSources, 'passesAttempted', stats?.passes?.total, sourceId);
    knownValue(values, fieldSources, 'penaltiesSaved', stats?.penalty?.saved, sourceId);
    knownValue(values, fieldSources, 'penaltiesConceded', stats?.penalty?.commited, sourceId);
    eventBackedValue(values, fieldSources, 'yellowCards', stats?.cards?.yellow, eventStats.yellowCards, eventsComplete, sourceId, conflicts);
    eventBackedValue(values, fieldSources, 'secondYellowRed', null, eventStats.secondYellowRed, eventsComplete, sourceId, conflicts);
    eventBackedValue(values, fieldSources, 'straightRed', null, eventStats.straightRed, eventsComplete, sourceId, conflicts);
    eventBackedValue(values, fieldSources, 'ownGoals', null, eventStats.ownGoals, eventsComplete, sourceId, conflicts);

    const goalsConceded = numeric(stats?.goals?.conceded);
    if (position === 'GK' && appearance === true && goalsConceded !== null) {
      knownValue(values, fieldSources, 'gaOnPitch', goalsConceded, sourceId);
      knownValue(values, fieldSources, 'cleanSheets', goalsConceded === 0 ? 1 : 0, sourceId);
      knownValue(values, fieldSources, 'shotsOnTargetFaced',
        numeric(stats?.goals?.saves) === null ? null : numeric(stats.goals.saves) + goalsConceded,
        sourceId);
    }

    const wantedFields = priorityFields(position);
    const missingFields = wantedFields.filter(field => values[field] === undefined);
    const providerIds = {
      apiFootball: {
        player: numeric(providerPlayerId) ?? providerPlayerId,
        fixture: numeric(providerFixtureId) ?? providerFixtureId,
        team: numeric(team?.id) ?? team?.id ?? null,
        league: numeric(fixture?.league?.id) ?? fixture?.league?.id ?? null,
      },
    };
    const apiFootballRating = numeric(stats?.games?.rating);

    const record = {
      recordId: `${matchId}-${tracked.playerId}`,
      playerId: tracked.playerId,
      matchId,
      playerName: tracked.name,
      player: tracked.name,
      club,
      competition,
      league: competition,
      match,
      ko: fixture?.fixture?.date || null,
      round: fixture?.league?.round || null,
      appearance,
      start,
      bench,
      ratingPosition: position,
      ratingPositionSource: stats?.games?.position ? 'api_football_fixture' : 'season_primary',
      values,
      missingFields,
      fieldSources,
      sourceIds: [sourceId],
      providerIds,
      priorityUpdate: missingFields.length > 0,
      priorityFields: missingFields,
    };
    if (apiFootballRating !== null) {
      record.providerRatings = {
        apiFootball: { value: apiFootballRating, sourceId },
      };
    }
    if (line) {
      record.lineup = {
        role: line.start ? 'starter' : (line.bench ? 'substitute' : null),
        number: numeric(line?.player?.number),
        position: playerPosition(line?.player?.pos),
        grid: String(line?.player?.grid || '').trim() || null,
      };
    }
    const substitution = substitutions.byPlayer.get(String(providerPlayerId));
    if (substitution) record.substitution = substitution;
    if (conflicts.length) record.ratingConflicts = conflicts;
    records.push(record);

    playerUpdates.push({
      playerId: tracked.playerId,
      name: tracked.name,
      providerIds: { apiFootball: { player: providerIds.apiFootball.player } },
      statsStatus: missingFields.length ? 'partial' : 'verified',
      priorityUpdate: missingFields.length > 0,
      priorityFields: missingFields,
      sourceIds: [sourceId],
    });

    const goals = numeric(values.goals);
    const assists = numeric(values.assists);
    if ((goals || 0) > 0 || (assists || 0) > 0) {
      const result = resultForTeam(fixture, team?.id);
      gaResultsAdd.push({
        matchId,
        ko: fixture?.fixture?.date || null,
        league: competition,
        match,
        playerId: tracked.playerId,
        player: tracked.name,
        club,
        goals,
        assists,
        contribution: `${goals ? `${goals}G` : ''}${assists ? `${assists}A` : ''}`,
        result,
        resultLabel: resultLabel(result, fixture),
        status: 'verified_api_football',
        sourceIds: [sourceId],
        providerIds,
      });
    }
  }

  const matchUpdate = {
    matchId,
    league: competition,
    round: fixture?.league?.round || null,
    ko: fixture?.fixture?.date || null,
    match,
    status: finalFixture ? 'verified' : 'live_or_scheduled',
    addIfMissing: true,
    sourceIds: [sourceId],
    providerIds: {
      apiFootball: {
        fixture: numeric(providerFixtureId) ?? providerFixtureId,
        league: numeric(fixture?.league?.id) ?? fixture?.league?.id ?? null,
        homeTeam: numeric(fixture?.teams?.home?.id) ?? fixture?.teams?.home?.id ?? null,
        awayTeam: numeric(fixture?.teams?.away?.id) ?? fixture?.teams?.away?.id ?? null,
      },
    },
  };
  if (formationData) matchUpdate.formationData = formationData;

  return {
    schemaVersion: 2,
    season: options.season || String(fixture?.league?.season || ''),
    updated,
    provider: 'api-football',
    sources: {
      [sourceId]: {
        id: sourceId,
        name: 'API-Football fixture bundle',
        type: 'provider_api',
        endpoint: `/fixtures?id=${providerFixtureId}`,
        retrievedAt: updated,
        priority: 1,
        exhaustiveFor: eventsComplete
          ? ['result', 'goals', 'assists', 'lineups', 'substitutions', 'cards']
          : ['observed_events_only'],
      },
    },
    matchUpdates: [matchUpdate],
    playerUpdates,
    playerMatchStats: records,
    gaResultsAdd,
  };
}

module.exports = {
  FINAL_FIXTURE_STATUSES,
  buildFormationData,
  collectSubstitutions,
  fixtureEventsAreComplete,
  mapFixtureToSchemaV2,
  normalizeTrackedPlayers,
  numeric,
  playerPosition,
};
