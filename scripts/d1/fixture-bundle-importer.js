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
  const identities = reconcileReviewedPlayerAliases(bundle);
  const positions = reconcileMissingPlayerPositions(identities.bundle);
  const names = reconcilePlayerDisplayNames(positions, catalog);
  return {
    bundle: omitNullTeamStatValues(names.bundle),
    catalog: names.catalog,
    playerAliasApplications: identities.applications,
  };
}

function validateBundle(bundle, catalog = {}) {
  const reconciled = reconcileProviderVariants(bundle, catalog);
  const context = core.validateBundle(reconciled.bundle, reconciled.catalog);
  context.providerVariantEvidence = {
    playerAliases: reconciled.playerAliasApplications,
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
  reconcileReviewedPlayerAliases,
  reviewedPlayerAliasRules,
  validateBundle,
};
