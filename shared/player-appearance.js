(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.JFWPlayerAppearance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function starterFromRole(role) {
    return role === 'starter' ? true : role === 'substitute' ? false : null;
  }

  function starterFromLineups(row, lineups) {
    if (!row?.playerId || !row?.teamId) return null;
    let starts = false, bench = false;
    for (const lineup of lineups || []) {
      if (lineup.teamId !== row.teamId) continue;
      starts ||= (lineup.startXI || []).some(player => player.id === row.playerId);
      bench ||= (lineup.substitutes || []).some(player => player.id === row.playerId);
    }
    // Missing or contradictory membership does not establish either role.
    return starts === bench ? null : starts;
  }

  function appearanceState(starter, minutes, state) {
    if (starter === true) return 'started';
    const presence = typeof state === 'string' ? state : state?.presence;
    if (starter !== false || presence && presence !== 'present'
      || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return 'unknown';
    return minutes > 0 ? 'substitute_used' : 'bench_unused';
  }

  function withLineupStarters(bundle) {
    if (!Array.isArray(bundle?.playerStats)) return bundle;
    const explicit = bundle.sectionStates?.lineups;
    const presence = typeof explicit === 'string' ? explicit : explicit?.presence;
    const lineups = presence && presence !== 'present' ? [] : bundle.lineups;
    return { ...bundle, playerStats: bundle.playerStats.map(row => ({
      ...row, starter: starterFromLineups(row, lineups),
    })) };
  }

  return { starterFromRole, starterFromLineups, appearanceState, withLineupStarters };
});
