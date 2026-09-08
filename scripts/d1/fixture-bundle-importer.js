'use strict';

const core = require('./fixture-bundle-importer-core');

function displayNameScore(name) {
  const value = String(name || '').trim();
  if (!value) return -1;
  const tokens = value.split(/\s+/).filter(Boolean);
  const fullTokens = tokens.filter(token => !token.endsWith('.')).length;
  return (fullTokens * 1000) + (tokens.length * 100) + value.length;
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

function validateBundle(bundle, catalog = {}) {
  const reconciled = reconcilePlayerDisplayNames(bundle, catalog);
  return core.validateBundle(reconciled.bundle, reconciled.catalog);
}

function importFixtureBundle(database, bundle, catalog = {}, correctionDocument) {
  const reconciled = reconcilePlayerDisplayNames(bundle, catalog);
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
  validateBundle,
};
