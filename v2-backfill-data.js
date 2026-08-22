(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.JFWV2BackfillData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  async function browserFetchJson(path) {
    const sep = String(path).includes('?') ? '&' : '?';
    const response = await fetch(`${path}${sep}v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response.json();
  }

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error || 'unknown error');
  }

  function withIntegrity(data, details) {
    return {
      ...(data && typeof data === 'object' ? data : {}),
      _dataIntegrity: {
        degraded: !!details.degraded,
        season: details.season || null,
        dataPath: details.dataPath || null,
        manifestPath: details.manifestPath || null,
        fragmentsExpected: details.fragmentsExpected ?? null,
        fragmentsLoaded: details.fragmentsLoaded ?? null,
        errors: Array.isArray(details.errors) ? details.errors : [],
      },
    };
  }

  async function loadCurrentMergedData(options = {}) {
    const getJson = options.getJson || browserFetchJson;
    const mergeBackfillData = options.mergeBackfillData;
    const errors = [];
    let season = null;
    let dataPath = 'data.json';
    let baseData = null;

    try {
      const catalog = await getJson('seasons.json');
      season = catalog?.current || null;
      const descriptor = (catalog?.seasons || []).find(item => item?.id === season || item?.current);
      if (!season && descriptor?.id) season = descriptor.id;
      if (descriptor?.data) dataPath = descriptor.data;
      if (!season) errors.push('seasons.json に current season がありません');
    } catch (error) {
      errors.push(`seasons.json: ${messageOf(error)}`);
    }

    try {
      baseData = await getJson(dataPath);
    } catch (error) {
      errors.push(`${dataPath}: ${messageOf(error)}`);
      return withIntegrity({ players: [], matches: [], topMatches: [], dataCoverage: [] }, {
        degraded: true,
        season,
        dataPath,
        errors,
      });
    }

    if (!season) {
      return withIntegrity(baseData, {
        degraded: true,
        season,
        dataPath,
        errors,
      });
    }

    if (typeof mergeBackfillData !== 'function') {
      errors.push('backfill merge core が読み込まれていません');
      return withIntegrity(baseData, {
        degraded: true,
        season,
        dataPath,
        errors,
      });
    }

    const manifestPath = `data/${season}/backfill/index.json`;
    let manifest;
    try {
      manifest = await getJson(manifestPath);
    } catch (error) {
      errors.push(`${manifestPath}: ${messageOf(error)}`);
      return withIntegrity(baseData, {
        degraded: true,
        season,
        dataPath,
        manifestPath,
        errors,
      });
    }

    const names = Array.isArray(manifest?.fragments) ? manifest.fragments : [];
    if (!names.length) {
      errors.push(`${manifestPath}: fragments が空です`);
      return withIntegrity(baseData, {
        degraded: true,
        season,
        dataPath,
        manifestPath,
        fragmentsExpected: 0,
        fragmentsLoaded: 0,
        errors,
      });
    }

    let fragments;
    try {
      fragments = await Promise.all(names.map(name => getJson(`data/${season}/backfill/${name}`)));
    } catch (error) {
      errors.push(`backfill fragment: ${messageOf(error)}`);
      return withIntegrity(baseData, {
        degraded: true,
        season,
        dataPath,
        manifestPath,
        fragmentsExpected: names.length,
        fragmentsLoaded: null,
        errors,
      });
    }

    try {
      const merged = mergeBackfillData(baseData, fragments, { season });
      return withIntegrity(merged, {
        degraded: false,
        season,
        dataPath,
        manifestPath,
        fragmentsExpected: names.length,
        fragmentsLoaded: fragments.length,
        errors,
      });
    } catch (error) {
      errors.push(`backfill merge: ${messageOf(error)}`);
      return withIntegrity(baseData, {
        degraded: true,
        season,
        dataPath,
        manifestPath,
        fragmentsExpected: names.length,
        fragmentsLoaded: fragments.length,
        errors,
      });
    }
  }

  return { loadCurrentMergedData, withIntegrity };
});
