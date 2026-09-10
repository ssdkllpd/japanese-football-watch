'use strict';

const core = require('./fixture-bundle-importer-core');
const reviewedEvidence = require('../../config/d1-major-league-snapshot-20260908.json');

function displayNameScore(name) {
  const value = String(name || '').trim();
  if (!value) return -1;
  const tokens = value.split(/\s+/).filter(Boolean);
  const fullTokens = tokens.filter(token => !token.endsWith('.')).length;
  return (fullTokens * 1000) + (tokens.length * 100) + value.length;
}

function reviewedPlayerAliasRules(evidence = reviewedEvidence) {
  const rules = Array.isArray(evidence?.playerAliases) ? evidence.playerAliases : [];
  const seen = new Set();
  return rules.map((rule, index) => {
    const label = `Reviewed player alias ${index}`;
    if (rule?.provider !== 'api-football' || rule.snapshotId !== evidence.snapshotId
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(rule.observedAt || ''))
      || !Number.isSafeInteger(rule.league) || !Number.isSafeInteger(rule.season)
      || !/^af:team:\d+$/.test(String(rule.teamId || ''))
      || !/^af:player:\d+$/.test(String(rule.aliasPlayerId || ''))
      || !/^af:player:\d+$/.test(String(rule.canonicalPlayerId || ''))
      || !Number.isSafeInteger(rule.aliasProviderId) || !Number.isSafeInteger(rule.canonicalProviderId)
      || rule.aliasPlayerId !== `af:player:${rule.aliasProviderId}`
      || rule.canonicalPlayerId !== `af:player:${rule.canonicalProviderId}`
      || rule.aliasProviderId === rule.canonicalProviderId
      || !String(rule.reason || '').trim()) {
      throw new Error(`${label} is invalid.`);
    }
    const key = [rule.snapshotId, rule.league, rule.season, rule.teamId, rule.aliasPlayerId].join('|');
    if (seen.has(key)) throw new Error(`${label} duplicates a reviewed alias scope.`);
    seen.add(key);
    return { ...rule };
  });
}

const REVIEWED_PLAYER_ALIAS_RULES = reviewedPlayerAliasRules();

function reviewedPlayerCollisionOmissionRules(evidence = reviewedEvidence) {
  const review = evidence?.providerPlayerIdentityCollisionReview;
  if (!review || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(review.observedAt || ''))
    || !Array.isArray(review.omissions)) {
    throw new Error('Reviewed provider player identity collision evidence is invalid.');
  }
  const seen = new Set();
  const sections = new Set(['lineups.startXI', 'lineups.substitutes', 'playerStats']);
  return review.omissions.map((rule, index) => {
    const label = `Reviewed player collision omission ${index}`;
    if (!Number.isSafeInteger(rule?.league) || !Number.isSafeInteger(rule?.season)
      || !/^af:fixture:\d+$/.test(String(rule?.fixtureId || ''))
      || !/^af:team:\d+$/.test(String(rule?.teamId || ''))
      || !sections.has(rule?.section)
      || !/^af:player:[1-9]\d*$/.test(String(rule?.playerId || ''))
      || !Number.isSafeInteger(rule?.providerId) || rule.providerId <= 0
      || rule.playerId !== `af:player:${rule.providerId}`
      || !String(rule?.name || '').trim()
      || !['starter', 'substitute'].includes(rule?.role)
      || rule?.reason !== 'provider_player_id_collides_with_distinct_identity') {
      throw new Error(`${label} is invalid.`);
    }
    const key = [rule.league, rule.season, rule.fixtureId, rule.teamId, rule.section,
      rule.playerId, rule.name, rule.role].join('|');
    if (seen.has(key)) throw new Error(`${label} is duplicated.`);
    seen.add(key);
    return { ...rule, observedAt: review.observedAt };
  });
}

const REVIEWED_PLAYER_COLLISION_OMISSION_RULES = reviewedPlayerCollisionOmissionRules();

function reviewedCoachIdentityRecoveryRules(evidence = reviewedEvidence) {
  const review = evidence?.providerMissingCoachIdentityReview;
  if (!review || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(review.observedAt || ''))
    || !Array.isArray(review.recoveries) || !Array.isArray(review.omissions)) {
    throw new Error('Reviewed provider-missing coach identity evidence is invalid.');
  }
  const seen = new Set();
  return review.recoveries.map((rule, index) => {
    const label = `Reviewed coach identity recovery ${index}`;
    if (!Number.isSafeInteger(rule?.league) || !Number.isSafeInteger(rule?.season)
      || !/^af:fixture:\d+$/.test(String(rule?.fixtureId || ''))
      || !/^af:team:\d+$/.test(String(rule?.teamId || ''))
      || !String(rule?.sourceName || '').trim()
      || ![null, 0].includes(rule?.sourceProviderId)
      || !/^af:coach:[1-9]\d*$/.test(String(rule?.canonicalCoachId || ''))
      || !Number.isSafeInteger(rule?.canonicalProviderId) || rule.canonicalProviderId <= 0
      || rule.canonicalCoachId !== `af:coach:${rule.canonicalProviderId}`
      || !String(rule?.canonicalName || '').trim()
      || (rule?.canonicalPhoto !== null && typeof rule?.canonicalPhoto !== 'string')
      || rule?.reason !== 'provider_coach_id_recovered_from_pinned_team_history') {
      throw new Error(`${label} is invalid.`);
    }
    const key = [rule.league, rule.season, rule.fixtureId, rule.teamId,
      rule.sourceName, rule.sourceProviderId].join('|');
    if (seen.has(key)) throw new Error(`${label} is duplicated.`);
    seen.add(key);
    return { ...rule, observedAt: review.observedAt };
  });
}

const REVIEWED_COACH_IDENTITY_RECOVERY_RULES = reviewedCoachIdentityRecoveryRules();

function isMissingProviderPlayerIdentity(id, providerId) {
  return (id === null && (providerId === null || providerId === 0))
    || (id === 'af:player:0' && providerId === 0);
}

function isMissingProviderCoachIdentity(id, providerId) {
  return (id === null && (providerId === null || providerId === 0))
    || (id === 'af:coach:0' && providerId === 0);
}

function reconcileMissingProviderCoachIdentities(
  bundle,
  rules = REVIEWED_COACH_IDENTITY_RECOVERY_RULES,
) {
  const nextBundle = structuredClone(bundle);
  const scope = bundleScope(nextBundle);
  const fixtureId = nextBundle.fixture?.id || null;
  const applicable = rules.filter(rule => rule.league === scope.league
    && rule.season === scope.season && rule.fixtureId === fixtureId
    && rule.observedAt === scope.observedAt);
  const matched = new Set();
  const recoveries = [];
  const omissions = [];

  for (const lineup of nextBundle.lineups || []) {
    const coach = lineup?.coach;
    if (!coach || !isMissingProviderCoachIdentity(coach.id, coach.providerId)) continue;
    const sourceName = String(coach.name || '').trim() || null;
    const sourceProviderId = coach.providerId ?? null;
    const candidates = applicable.filter(rule => rule.teamId === lineup.teamId
      && rule.sourceName === sourceName && rule.sourceProviderId === sourceProviderId);
    if (candidates.length > 1) {
      throw new Error(`Multiple reviewed coach recoveries match ${fixtureId}:${lineup.teamId}.`);
    }
    const rule = candidates[0];
    if (!rule) {
      lineup.coach = null;
      omissions.push({
        fixtureId,
        teamId: lineup.teamId || null,
        sourceName,
        sourceProviderId,
        reason: 'provider_coach_id_missing_or_non_positive',
      });
      continue;
    }
    const ruleKey = [rule.fixtureId, rule.teamId, rule.sourceName, rule.sourceProviderId].join('|');
    if (matched.has(ruleKey)) {
      throw new Error(`Reviewed coach recovery matched multiple rows: ${fixtureId}:${lineup.teamId}.`);
    }
    matched.add(ruleKey);
    lineup.coach = {
      id: rule.canonicalCoachId,
      providerId: rule.canonicalProviderId,
      name: rule.canonicalName,
      photo: rule.canonicalPhoto,
    };
    const { observedAt, league, season, ...recovery } = rule;
    recoveries.push(recovery);
  }

  for (const rule of applicable) {
    const ruleKey = [rule.fixtureId, rule.teamId, rule.sourceName, rule.sourceProviderId].join('|');
    if (!matched.has(ruleKey)) {
      throw new Error(`Reviewed coach recovery matched 0 rows: ${rule.fixtureId}:${rule.teamId}.`);
    }
  }

  const sort = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right));
  recoveries.sort(sort);
  omissions.sort(sort);
  return { bundle: nextBundle, recoveries, omissions };
}

function reconcileMissingProviderPlayerIdentities(bundle) {
  const nextBundle = structuredClone(bundle);
  const omissions = [];

  function omission(section, teamId, player, role = null) {
    omissions.push({
      fixtureId: nextBundle.fixture?.id || null,
      teamId: teamId || null,
      section,
      name: String(player?.name ?? player?.playerName ?? '').trim() || null,
      providerId: player?.providerId ?? player?.playerProviderId ?? null,
      role,
      reason: 'provider_player_id_missing_or_non_positive',
    });
  }

  for (const lineup of nextBundle.lineups || []) {
    for (const [key, role] of [['startXI', 'starter'], ['substitutes', 'substitute']]) {
      lineup[key] = (lineup[key] || []).filter(player => {
        if (!isMissingProviderPlayerIdentity(player?.id, player?.providerId)) return true;
        omission(`lineups.${key}`, lineup.teamId, player, role);
        return false;
      });
    }
  }

  nextBundle.playerStats = (nextBundle.playerStats || []).filter(stat => {
    if (!isMissingProviderPlayerIdentity(stat?.playerId, stat?.playerProviderId)) return true;
    omission('playerStats', stat.teamId, stat, stat.starter === true ? 'starter'
      : (stat.starter === false ? 'substitute' : null));
    return false;
  });

  for (const event of nextBundle.events || []) {
    if (event.playerId === 'af:player:0') event.playerId = null;
    if (event.relatedPlayerId === 'af:player:0') event.relatedPlayerId = null;
  }

  omissions.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { bundle: nextBundle, omissions };
}

function reconcileCollidingProviderPlayerIdentities(
  bundle,
  rules = REVIEWED_PLAYER_COLLISION_OMISSION_RULES,
) {
  const nextBundle = structuredClone(bundle);
  const scope = bundleScope(nextBundle);
  const omissions = [];
  const applicable = rules.filter(rule => rule.league === scope.league
    && rule.season === scope.season && rule.fixtureId === nextBundle.fixture?.id
    && rule.observedAt === scope.observedAt);
  const originalLineupCounts = new Map();
  for (const lineup of nextBundle.lineups) {
    for (const player of [...lineup.startXI, ...lineup.substitutes]) {
      originalLineupCounts.set(player.id, (originalLineupCounts.get(player.id) || 0) + 1);
    }
  }
  const originalStatCounts = new Map();
  for (const stat of nextBundle.playerStats) {
    originalStatCounts.set(stat.playerId, (originalStatCounts.get(stat.playerId) || 0) + 1);
  }

  for (const rule of applicable) {
    const originalCount = rule.section === 'playerStats'
      ? originalStatCounts.get(rule.playerId)
      : originalLineupCounts.get(rule.playerId);
    if ((originalCount || 0) < 2) {
      throw new Error(`Reviewed player collision is no longer duplicated: ${rule.fixtureId}:${rule.playerId}:${rule.section}.`);
    }

    let matches = 0;
    const keep = (row, teamId, role) => {
      const playerId = rule.section === 'playerStats' ? row.playerId : row.id;
      const providerId = rule.section === 'playerStats' ? row.playerProviderId : row.providerId;
      const name = rule.section === 'playerStats' ? row.playerName : row.name;
      const matched = playerId === rule.playerId && providerId === rule.providerId
        && teamId === rule.teamId && name === rule.name && role === rule.role;
      if (matched) matches += 1;
      return !matched;
    };

    if (rule.section === 'playerStats') {
      nextBundle.playerStats = nextBundle.playerStats.filter(stat => keep(
        stat,
        stat.teamId,
        stat.starter === true ? 'starter' : 'substitute',
      ));
    } else {
      const key = rule.section === 'lineups.startXI' ? 'startXI' : 'substitutes';
      const role = key === 'startXI' ? 'starter' : 'substitute';
      for (const lineup of nextBundle.lineups) {
        lineup[key] = lineup[key].filter(player => keep(player, lineup.teamId, role));
      }
    }
    if (matches !== 1) {
      throw new Error(`Reviewed player collision omission matched ${matches} rows: ${rule.fixtureId}:${rule.playerId}:${rule.section}.`);
    }
    const { observedAt, league, season, ...omission } = rule;
    omissions.push(omission);
  }

  omissions.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { bundle: nextBundle, omissions };
}

function bundleScope(bundle) {
  const competition = /^af:competition:(\d+)$/.exec(String(bundle?.fixture?.competitionId || ''));
  const season = /^af:season:(\d+):(\d+)$/.exec(String(bundle?.fixture?.seasonId || ''));
  return {
    league: competition ? Number(competition[1]) : null,
    season: season && competition && season[1] === competition[1] ? Number(season[2]) : null,
    observedAt: bundle?.fixture?.provenance?.fetchedAt || null,
  };
}

function reconcileReviewedPlayerAliases(bundle, rules = REVIEWED_PLAYER_ALIAS_RULES) {
  const nextBundle = structuredClone(bundle);
  const scope = bundleScope(nextBundle);
  const applications = [];

  for (const rule of rules) {
    if (scope.league !== rule.league || scope.season !== rule.season || scope.observedAt !== rule.observedAt) continue;
    let references = 0;

    function applyLineupPlayer(player, label) {
      if (!player || player.id !== rule.aliasPlayerId) return;
      if (player.providerId !== rule.aliasProviderId) {
        throw new Error(`${label} reviewed player alias identity mismatch.`);
      }
      player.id = rule.canonicalPlayerId;
      player.providerId = rule.canonicalProviderId;
      references += 1;
    }

    for (const [lineupIndex, lineup] of (nextBundle.lineups || []).entries()) {
      if (lineup.teamId !== rule.teamId) continue;
      for (const [playerIndex, player] of (lineup.startXI || []).entries()) {
        applyLineupPlayer(player, `lineups[${lineupIndex}].startXI[${playerIndex}]`);
      }
      for (const [playerIndex, player] of (lineup.substitutes || []).entries()) {
        applyLineupPlayer(player, `lineups[${lineupIndex}].substitutes[${playerIndex}]`);
      }
    }

    for (const [statIndex, stat] of (nextBundle.playerStats || []).entries()) {
      if (stat.teamId !== rule.teamId) continue;
      if (stat.playerId === rule.aliasPlayerId || stat.playerProviderId === rule.aliasProviderId) {
        if (stat.playerId !== rule.aliasPlayerId || stat.playerProviderId !== rule.aliasProviderId) {
          throw new Error(`playerStats[${statIndex}] reviewed player alias identity mismatch.`);
        }
        stat.playerId = rule.canonicalPlayerId;
        stat.playerProviderId = rule.canonicalProviderId;
        references += 1;
      }
    }

    for (const event of nextBundle.events || []) {
      if (event.teamId !== rule.teamId) continue;
      if (event.playerId === rule.aliasPlayerId) {
        event.playerId = rule.canonicalPlayerId;
        references += 1;
      }
      if (event.relatedPlayerId === rule.aliasPlayerId) {
        event.relatedPlayerId = rule.canonicalPlayerId;
        references += 1;
      }
    }

    if (references > 0) {
      applications.push({
        provider: rule.provider,
        snapshotId: rule.snapshotId,
        observedAt: rule.observedAt,
        league: rule.league,
        season: rule.season,
        teamId: rule.teamId,
        aliasPlayerId: rule.aliasPlayerId,
        aliasProviderId: rule.aliasProviderId,
        canonicalPlayerId: rule.canonicalPlayerId,
        canonicalProviderId: rule.canonicalProviderId,
        references,
        reason: rule.reason,
      });
    }
  }

  return { bundle: nextBundle, applications };
}

function reconcileMissingPlayerPositions(bundle) {
  const nextBundle = structuredClone(bundle);
  const lineupPlayers = new Map();
  const duplicates = new Set();

  for (const lineup of nextBundle.lineups || []) {
    for (const player of [...(lineup.startXI || []), ...(lineup.substitutes || [])]) {
      if (!player?.id) continue;
      if (lineupPlayers.has(player.id)) {
        duplicates.add(player.id);
        continue;
      }
      lineupPlayers.set(player.id, { player, teamId: lineup.teamId });
    }
  }

  for (const stat of nextBundle.playerStats || []) {
    if (!stat?.playerId || duplicates.has(stat.playerId)) continue;
    const lineup = lineupPlayers.get(stat.playerId);
    if (!lineup || lineup.teamId !== stat.teamId) continue;
    const lineupPosition = lineup.player.position ?? null;
    const statPosition = stat.position ?? null;
    if (lineupPosition === null && statPosition !== null) lineup.player.position = statPosition;
    else if (lineupPosition !== null && statPosition === null) stat.position = lineupPosition;
  }

  return nextBundle;
}

function reconcilePlayerDisplayNames(bundle, catalog = {}) {
  const nextBundle = structuredClone(bundle);
  const nextCatalog = structuredClone(catalog || {});
  const groups = new Map();

  function register(id, providerId, name, apply) {
    if (!id || !Number.isInteger(providerId) || !String(name || '').trim()) return;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ providerId, name: String(name).trim(), apply });
  }

  for (const player of nextCatalog.players || []) {
    register(player.id, player.providerId, player.name, value => { player.name = value; });
  }
  for (const lineup of nextBundle.lineups || []) {
    for (const player of [...(lineup.startXI || []), ...(lineup.substitutes || [])]) {
      register(player.id, player.providerId, player.name, value => { player.name = value; });
    }
  }
  for (const stat of nextBundle.playerStats || []) {
    register(stat.playerId, stat.playerProviderId, stat.playerName, value => { stat.playerName = value; });
  }

  for (const entries of groups.values()) {
    const providerIds = new Set(entries.map(entry => entry.providerId));
    if (providerIds.size !== 1) continue;
    const preferred = entries.reduce((best, entry) => (
      !best || displayNameScore(entry.name) > displayNameScore(best.name) ? entry : best
    ), null);
    for (const entry of entries) entry.apply(preferred.name);
  }

  return { bundle: nextBundle, catalog: nextCatalog };
}

function omitNullTeamStatValues(bundle) {
  const nextBundle = structuredClone(bundle);
  for (const stat of nextBundle.teamStats || []) {
    if (!stat?.values || typeof stat.values !== 'object' || Array.isArray(stat.values)) continue;
    stat.values = Object.fromEntries(Object.entries(stat.values)
      .filter(([, value]) => value !== null && value !== undefined));
  }
  return nextBundle;
}

function reconcileProviderVariants(bundle, catalog = {}) {
  const missingIdentities = reconcileMissingProviderPlayerIdentities(bundle);
  const identities = reconcileReviewedPlayerAliases(missingIdentities.bundle);
  const collisions = reconcileCollidingProviderPlayerIdentities(identities.bundle);
  const coaches = reconcileMissingProviderCoachIdentities(collisions.bundle);
  const positions = reconcileMissingPlayerPositions(coaches.bundle);
  const names = reconcilePlayerDisplayNames(positions, catalog);
  return {
    bundle: omitNullTeamStatValues(names.bundle),
    catalog: names.catalog,
    playerAliasApplications: identities.applications,
    playerIdentityOmissions: missingIdentities.omissions,
    playerIdentityCollisionOmissions: collisions.omissions,
    coachIdentityRecoveries: coaches.recoveries,
    coachIdentityOmissions: coaches.omissions,
  };
}

function validateBundle(bundle, catalog = {}) {
  const reconciled = reconcileProviderVariants(bundle, catalog);
  const context = core.validateBundle(reconciled.bundle, reconciled.catalog);
  context.providerVariantEvidence = {
    playerAliases: reconciled.playerAliasApplications,
    playerIdentityOmissions: reconciled.playerIdentityOmissions,
    playerIdentityCollisionOmissions: reconciled.playerIdentityCollisionOmissions,
    coachIdentityRecoveries: reconciled.coachIdentityRecoveries,
    coachIdentityOmissions: reconciled.coachIdentityOmissions,
  };
  return context;
}

function importFixtureBundle(database, bundle, catalog = {}, correctionDocument) {
  const reconciled = reconcileProviderVariants(bundle, catalog);
  return core.importFixtureBundle(
    database,
    reconciled.bundle,
    reconciled.catalog,
    correctionDocument,
  );
}

module.exports = {
  ...core,
  importFixtureBundle,
  reconcileMissingPlayerPositions,
  reconcileMissingProviderPlayerIdentities,
  reconcileMissingProviderCoachIdentities,
  reconcileCollidingProviderPlayerIdentities,
  reconcileReviewedPlayerAliases,
  reviewedCoachIdentityRecoveryRules,
  reviewedPlayerAliasRules,
  validateBundle,
};
