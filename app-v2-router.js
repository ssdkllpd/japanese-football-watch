(function initFootballRouter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FootballV2Router = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MATCH_FILTERS = new Set(['all', 'live', 'following', 'japanese']);
  const FIXTURE_TABS = new Set(['overview', 'lineup', 'events', 'stats', 'ratings']);
  const COMPETITION_TABS = new Set(['matches', 'standings', 'overview', 'players', 'teams']);
  const LEGACY_HASHES = new Map([
    ['#home', '#/matches'],
    ['#featured', '#/matches'],
    ['#matches', '#/matches'],
    ['#stats', '#/japanese'],
    ['#ga', '#/japanese'],
    ['#insights', '#/japanese'],
    ['#attention', '#/japanese'],
    ['#coverage', '#/more'],
  ]);

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function parseHash(input, defaults = {}) {
    const rawHash = String(input || '').trim();
    const migrated = LEGACY_HASHES.get(rawHash);
    if (!migrated && rawHash && rawHash !== '#' && !rawHash.startsWith('#/')) return notFound('entity_not_found', false);
    const hash = migrated || (rawHash.startsWith('#/') ? rawHash : '#/matches');
    const [rawPath, rawQuery = ''] = hash.slice(1).split('?');
    const segments = rawPath.split('/').filter(Boolean);
    const decoded = segments.map(safeDecode);
    const params = new URLSearchParams(rawQuery);
    if (decoded.some(value => value === null)) return notFound('malformed_route', migrated);

    if (decoded.length === 1 && decoded[0] === 'matches') {
      const requestedFilter = params.get('filter');
      const legacyLive = params.get('live') === '1';
      const filter = MATCH_FILTERS.has(requestedFilter) ? requestedFilter : (legacyLive ? 'live' : 'all');
      const date = validDate(params.get('date')) ? params.get('date') : (defaults.date || null);
      return {
        kind: 'matches', page: 'matches', date, filter,
        canonicalHash: matchesHash(date, filter),
        shouldReplace: Boolean(migrated || params.has('live') || (requestedFilter && !MATCH_FILTERS.has(requestedFilter))),
      };
    }

    if (decoded.length === 2 && decoded[0] === 'fixtures' && decoded[1]) {
      const tab = FIXTURE_TABS.has(params.get('tab')) ? params.get('tab') : 'overview';
      const ratingMode = params.get('ratingMode') === 'jfw' ? 'jfw' : 'provider';
      return {
        kind: 'fixture', page: defaults.fixtureReturn || 'matches', fixtureId: decoded[1], tab,
        playerId: params.get('player') || null, ratingMode,
        canonicalHash: fixtureHash(decoded[1], { tab, playerId: params.get('player'), ratingMode }),
        shouldReplace: false,
      };
    }

    if (decoded.length === 1 && decoded[0] === 'competitions') {
      return { kind: 'competitions', page: 'leagues', canonicalHash: '#/competitions', shouldReplace: Boolean(migrated) };
    }

    if (decoded.length === 2 && decoded[0] === 'competitions' && decoded[1]) {
      const seasonId = params.get('competitionSeason');
      if (seasonId && !seasonId.startsWith('af:season:')) return invalidSeason('competitionSeason', seasonId);
      const tab = COMPETITION_TABS.has(params.get('tab')) ? params.get('tab') : 'matches';
      return {
        kind: 'competition', page: 'leagues', competitionId: decoded[1], competitionSeason: seasonId || null, tab,
        canonicalHash: competitionHash(decoded[1], seasonId, tab), shouldReplace: false,
      };
    }

    if (decoded.length === 2 && ['teams', 'players'].includes(decoded[0]) && decoded[1]) {
      const seasonId = params.get('productSeason');
      if (seasonId && !seasonId.startsWith('jfw:season:')) return invalidSeason('productSeason', seasonId);
      const kind = decoded[0] === 'teams' ? 'team' : 'player';
      return {
        kind, page: defaults.returnPage || 'leagues', entityId: decoded[1], productSeason: seasonId || null,
        canonicalHash: entityHash(decoded[0], decoded[1], seasonId), shouldReplace: false,
      };
    }

    if (decoded.length === 1 && decoded[0] === 'search') {
      return { kind: 'search', page: defaults.returnPage || 'matches', query: params.get('q') || '', canonicalHash: searchHash(params.get('q') || ''), shouldReplace: false };
    }

    if (decoded.length === 1 && ['following', 'japanese', 'more'].includes(decoded[0])) {
      const page = decoded[0];
      const seasonId = page === 'japanese' ? params.get('productSeason') : null;
      if (seasonId && !seasonId.startsWith('jfw:season:')) return invalidSeason('productSeason', seasonId);
      return { kind: page, page, productSeason: seasonId || null, canonicalHash: pageHash(page, seasonId), shouldReplace: Boolean(migrated) };
    }

    return notFound('entity_not_found', migrated);
  }

  function notFound(code, migrated) {
    return { kind: 'error', status: 404, code, page: 'matches', canonicalHash: '#/404', shouldReplace: Boolean(migrated) };
  }

  function invalidSeason(parameter, value) {
    return { kind: 'error', status: 400, code: 'invalid_season_namespace', parameter, value, page: 'matches', canonicalHash: '#/400', shouldReplace: false };
  }

  function withParams(path, entries) {
    const params = new URLSearchParams();
    for (const [key, value] of entries) if (value !== null && value !== undefined && value !== '') params.set(key, value);
    const query = params.toString();
    return `#${path}${query ? `?${query}` : ''}`;
  }

  function matchesHash(date, filter = 'all') {
    return withParams('/matches', [['date', date], ['filter', MATCH_FILTERS.has(filter) ? filter : 'all']]);
  }

  function fixtureHash(fixtureId, options = {}) {
    const tab = FIXTURE_TABS.has(options.tab) ? options.tab : 'overview';
    return withParams(`/fixtures/${encodeURIComponent(fixtureId)}`, [
      ['tab', tab],
      ['player', options.playerId],
      ['ratingMode', tab === 'ratings' ? options.ratingMode : null],
    ]);
  }

  function competitionHash(competitionId, seasonId, tab = 'matches') {
    return withParams(`/competitions/${encodeURIComponent(competitionId)}`, [
      ['competitionSeason', seasonId],
      ['tab', COMPETITION_TABS.has(tab) ? tab : 'matches'],
    ]);
  }

  function entityHash(collection, entityId, seasonId) {
    return withParams(`/${collection}/${encodeURIComponent(entityId)}`, [['productSeason', seasonId]]);
  }

  function searchHash(query) {
    return withParams('/search', [['q', query]]);
  }

  function pageHash(page, seasonId) {
    return withParams(`/${page}`, page === 'japanese' ? [['productSeason', seasonId]] : []);
  }

  return {
    MATCH_FILTERS,
    FIXTURE_TABS,
    COMPETITION_TABS,
    parseHash,
    matchesHash,
    fixtureHash,
    competitionHash,
    entityHash,
    searchHash,
    pageHash,
  };
});
